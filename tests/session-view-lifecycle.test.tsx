/**
 * The session hook's view lifecycle around an in-flight send. React
 * StrictMode replays mount effects (cleanup, then mount again) while the
 * opening POST is still unacknowledged. The accepted send must still adopt
 * the canonical record for the live view, which matters for attachment sends
 * that have no optimistic bubble. A real unmount must start no further reads.
 */
import React, { StrictMode, act, useEffect, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ChatInput, LhMessage } from "../src/core/index.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { SessionModel } from "../components/session-core.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const canonical: LhMessage = {
	...newUserMessage(""),
	id: "server_user",
	content: [{ type: "text", text: "[Attached image: board.png]" }],
	userText: "",
	sessionAttachments: [{ id: "file_1", name: "board.png", kind: "image", mimeType: "image/png", size: 4 }],
};
const attachmentInput: ChatInput = { type: "text", text: "", attachmentIds: ["file_1"] };

async function fixture({ strict = true } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const calls: string[] = [];
	const acks: Array<{ resolve: (response: Response) => void }> = [];
	let recordMessages: LhMessage[] = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			const path = String(url);
			calls.push(path);
			if (path === "/api/chat") {
				const ack = deferred<Response>();
				acks.push(ack);
				return ack.promise;
			}
			if (path.endsWith("/stream")) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			return Response.json({ messages: recordMessages, turnInFlight: false });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const { useChatSession } = await import("../components/session.ts");
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	let session!: ReturnType<typeof useChatSession>;
	function Harness({ input }: { input: ChatInput }) {
		session = useChatSession({ chatId: "c1", initialMessages: [] });
		const sent = useRef(false);
		// Same shape as chat.tsx's opening effect: send once per mount.
		useEffect(() => {
			if (sent.current) return;
			sent.current = true;
			void session.send(input);
		}, [input]);
		return <div data-testid="count">{session.messages.length}</div>;
	}
	const render = (input: ChatInput) => root.render(strict ? <StrictMode><Harness input={input} /></StrictMode> : <Harness input={input} />);
	let mounted = true;
	const unmount = async () => { if (mounted) { mounted = false; await act(async () => { root.unmount(); }); } };
	cleanup = async () => {
		await unmount();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	return {
		calls, acks, unmount,
		get session() { return session; },
		setRecord(messages: LhMessage[]) { recordMessages = messages; },
		rendered: () => Number(doc.querySelector('[data-testid="count"]')?.textContent ?? "-1"),
		async mount(input: ChatInput = attachmentInput) { await act(async () => { render(input); }); },
		async ack(index = 0) {
			await act(async () => {
				acks[index]!.resolve(Response.json({ ok: true }));
				for (let i = 0; i < 20; i++) await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
		},
		reads: () => calls.filter((call) => call !== "/api/chat"),
	};
}

describe("session view lifecycle around an unacknowledged send", () => {
	it("StrictMode detach+reattach before the ack: the accepted attachment send adopts the record and attaches once", async () => {
		const f = await fixture();
		await f.mount();
		assert.equal(f.acks.length, 1, "the replayed mount does not resend");
		f.setRecord([canonical]);
		await f.ack();
		assert.deepEqual(f.reads(), ["/api/chats/c1", "/api/chats/c1/stream"]);
		assert.equal(f.rendered(), 1, "the canonical attachment message renders live");
		assert.deepEqual(f.session.nativeMessages, [canonical]);
	});

	it("a true unmount before the ack starts no record read or stream", async () => {
		const f = await fixture();
		await f.mount();
		await f.unmount();
		f.setRecord([canonical]);
		await f.ack();
		assert.deepEqual(f.reads(), []);
	});

	it("a newer reattach owns the view: the earlier ack starts nothing of its own", async () => {
		const f = await fixture();
		await f.mount();
		f.setRecord([canonical]);
		await act(async () => { f.session.resumeStream(); await new Promise((resolve) => setTimeout(resolve, 20)); });
		const before = f.reads().length;
		await f.ack();
		assert.equal(f.reads().length, before, "no second record read or stream for the superseded send");
		assert.equal(f.rendered(), 1);
	});

	it("a user Stop after the replayed mount cancels the recovery", async () => {
		const f = await fixture();
		await f.mount();
		await act(async () => { f.session.stop(); });
		f.setRecord([canonical]);
		await f.ack();
		assert.deepEqual(f.reads(), [], "Stop means stop: no reattach once the ack lands");
	});

	it("without StrictMode the ordinary path is unchanged: one record read and one stream", async () => {
		const f = await fixture({ strict: false });
		await f.mount();
		f.setRecord([canonical]);
		await f.ack();
		assert.deepEqual(f.reads(), ["/api/chats/c1", "/api/chats/c1/stream"]);
		assert.equal(f.rendered(), 1);
	});
});

describe("SessionModel attach/detach", () => {
	function model() {
		const calls: string[] = [];
		const ack = deferred<Response>();
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async (url) => {
			calls.push(String(url));
			if (String(url) === "/api/chat") return ack.promise;
			if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
			return Response.json({ messages: [canonical] });
		} });
		return { m, calls, ack };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	it("an ack that lands while detached adopts on the next attach, once", async () => {
		const { m, calls, ack } = model();
		m.attachView();
		const sending = m.send(attachmentInput);
		m.detachView();
		ack.resolve(Response.json({ ok: true }));
		assert.equal(await sending, true);
		assert.deepEqual(calls, ["/api/chat"], "nothing is read while no view is attached");
		m.attachView();
		await settle();
		assert.deepEqual(calls, ["/api/chat", "/api/chats/c1", "/api/chats/c1/stream"]);
		assert.deepEqual(m.getState().nativeMessages, [canonical]);
		m.detachView();
		m.attachView();
		await settle();
		assert.equal(calls.length, 3, "the owed adoption is not repeated by later attaches");
	});

	it("a newer send after the detach owns the view; the stale admission is dropped", async () => {
		const { m, calls, ack } = model();
		m.attachView();
		const first = m.send(attachmentInput);
		m.detachView();
		m.attachView();
		void m.resumeStream(true);
		ack.resolve(Response.json({ ok: true }));
		await first;
		await settle();
		assert.deepEqual(calls.filter((call) => call !== "/api/chat"), ["/api/chats/c1", "/api/chats/c1/stream"], "only the newer reattach reads");
	});
});
