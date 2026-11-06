import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearOpeningPrompt, readOpeningPrompt, readOpeningPromptEntry, stashOpeningPrompt } from "../components/opening-prompt.ts";
import { SessionStarter } from "../components/start-session.ts";
import type { SessionAttachmentInfo } from "../src/core";

const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
let data: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
function install(value: unknown) {
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value });
}
beforeEach(() => {
	data = new Map();
	storage = {
		getItem: key => data.get(key) ?? null,
		setItem: (key, value) => { data.set(key, value); },
		removeItem: key => { data.delete(key); },
	};
	install(storage);
});
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "sessionStorage", original);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});
const fail = () => { throw new Error("synthetic storage failure"); };

describe("opening message storage", () => {
	it("keeps full text off the URL and records attempted delivery before send", () => {
		const text = "a syllabus with Unicode 世界 & ? # ".repeat(1500);
		assert.equal(stashOpeningPrompt("c1", text), true);
		assert.deepEqual(readOpeningPromptEntry("c1"), { text, attempted: false });
		assert.equal(stashOpeningPrompt("c1", text, true), true);
		assert.deepEqual(readOpeningPromptEntry("c1"), { text, attempted: true });
		assert.equal(clearOpeningPrompt("c1"), true);
		assert.equal(readOpeningPrompt("c1"), undefined);
	});

	it("hands over attachment-only openings without storing file contents", () => {
		const info: SessionAttachmentInfo = { id: "image_1", name: "screenshot.png", kind: "image", mimeType: "image/png", size: 42 };
		assert.equal(stashOpeningPrompt("c1", "", false, [info]), true);
		assert.deepEqual(readOpeningPromptEntry("c1"), { text: "", attempted: false, attachments: [info] });
		assert.equal(stashOpeningPrompt("c1", "", true, [info]), true);
		assert.equal(readOpeningPromptEntry("c1")?.attempted, true);
		assert.ok(!data.get("lh.openingPrompt.c1")!.includes("base64"));
	});

	it("does not restore malformed attachment references from storage", () => {
		data.set("lh.openingPrompt.c1", JSON.stringify({ text: "hello", attempted: true, attachments: [{ id: "../other", name: "bad", kind: "image", mimeType: "image/png", size: 1 }] }));
		assert.deepEqual(readOpeningPromptEntry("c1"), { text: "hello", attempted: true });
	});

	it("treats a legacy raw-text stash conservatively as a possibly attempted send", () => {
		data.set("lh.openingPrompt.old", "teach me logic");
		assert.deepEqual(readOpeningPromptEntry("old"), { text: "teach me logic", attempted: true });
	});

	for (const unavailable of [undefined, null]) {
		it(`reports unavailable storage (${unavailable}) instead of claiming a safe handover`, () => {
			install(unavailable);
			assert.equal(stashOpeningPrompt("c1", "keep this"), false);
			assert.equal(readOpeningPrompt("c1"), undefined);
			assert.equal(clearOpeningPrompt("c1"), false);
		});
	}
	it("catches a throwing storage getter", () => {
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: fail });
		assert.equal(stashOpeningPrompt("c1", "keep this"), false);
		assert.equal(readOpeningPrompt("c1"), undefined);
		assert.equal(clearOpeningPrompt("c1"), false);
	});
	for (const method of ["getItem", "setItem", "removeItem"] as const) {
		it(`contains ${method} exceptions without crashing a source or chat page`, () => {
			storage[method] = fail;
			assert.doesNotThrow(() => stashOpeningPrompt("c1", "keep this"));
			assert.doesNotThrow(() => readOpeningPrompt("c1"));
			assert.doesNotThrow(() => clearOpeningPrompt("c1"));
			if (method !== "removeItem") assert.equal(stashOpeningPrompt("c1", "keep this"), false);
		});
	}
	it("does not accept a storage write that failed silently", () => {
		storage.setItem = () => {};
		assert.equal(stashOpeningPrompt("c1", "keep this"), false);
	});
});

describe("new-session create and handover", () => {
	function createFetch() {
		const bodies: unknown[] = [];
		const fetchLike = (async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ id: `chat_${bodies.length}` });
		}) as typeof fetch;
		return { bodies, fetchLike };
	}
	it("refuses navigation on quota failure, then reuses the created session for unchanged retry", async () => {
		const starter = new SessionStarter();
		const { bodies, fetchLike } = createFetch();
		const text = "full text ".repeat(4000);
		const setItem = storage.setItem;
		storage.setItem = fail;
		await assert.rejects(starter.start({ title: text }, fetchLike));
		assert.equal(bodies.length, 1);
		storage.setItem = setItem;
		assert.equal(await starter.start({ title: text }, fetchLike), "/chat/chat_1");
		assert.equal(bodies.length, 1);
		assert.equal(readOpeningPrompt("chat_1"), text);
	});
	it("reuses creation even when verifying the first storage write failed", async () => {
		const starter = new SessionStarter();
		const { bodies, fetchLike } = createFetch();
		const getItem = storage.getItem;
		storage.getItem = fail;
		await assert.rejects(starter.start({ title: "hello" }, fetchLike));
		storage.getItem = getItem;
		assert.equal(await starter.start({ title: "hello" }, fetchLike), "/chat/chat_1");
		assert.equal(bodies.length, 1);
	});
	it("creates first, prepares attachments for that session, then hands over references", async () => {
		const starter = new SessionStarter();
		const { bodies, fetchLike } = createFetch();
		const info: SessionAttachmentInfo = { id: "pdf_1", name: "lesson.pdf", kind: "pdf", mimeType: "application/pdf", size: 123 };
		const preparedFor: string[] = [];
		const attachments = {
			snapshot: () => [{ id: info.id, name: info.name, info }],
			prepare: async (chatId: string) => { preparedFor.push(chatId); return [info]; },
		};
		assert.equal(await starter.start({ title: "lesson.pdf" }, fetchLike, "model", attachments, ""), "/chat/chat_1");
		assert.deepEqual(bodies, [{ title: "lesson.pdf" }]);
		assert.deepEqual(preparedFor, ["chat_1"]);
		assert.deepEqual(readOpeningPromptEntry("chat_1"), { text: "", attempted: false, attachments: [info] });
	});

	it("reuses the created session after attachment preparation fails", async () => {
		const starter = new SessionStarter();
		const { bodies, fetchLike } = createFetch();
		let failPreparation = true;
		const info: SessionAttachmentInfo = { id: "notes_1", name: "notes.txt", kind: "text", mimeType: "text/plain", size: 10 };
		const attachments = {
			snapshot: () => [{ id: info.id, name: info.name, info }],
			prepare: async () => { if (failPreparation) throw new Error("upload failed"); return [info]; },
		};
		await assert.rejects(starter.start({ title: "my topic" }, fetchLike, "model", attachments), /upload failed/);
		assert.equal(data.size, 0, "no navigation handover before all files are ready");
		failPreparation = false;
		assert.equal(await starter.start({ title: "my topic" }, fetchLike, "model", attachments), "/chat/chat_1");
		assert.equal(bodies.length, 1);
		assert.deepEqual(readOpeningPromptEntry("chat_1")?.attachments, [info]);
	});

	it("changed text, mode, picks or birth settings create a matching new session", async () => {
		const starter = new SessionStarter();
		const { bodies, fetchLike } = createFetch();
		await starter.start({ title: "original" }, fetchLike, "model-a");
		await starter.start({ title: "edited" }, fetchLike, "model-a");
		await starter.start({ title: "edited", kind: "practice" }, fetchLike, "model-a");
		const picked = { title: "edited", kind: "practice" as const, graphContext: { propositions: [{ id: "p1", name: "P", statement: "S" }] } };
		await starter.start(picked, fetchLike, "model-a");
		await starter.start(picked, fetchLike, "model-b");
		assert.equal(bodies.length, 5);
		assert.equal(readOpeningPrompt("chat_1"), undefined);
	});
	it("does not stash or navigate on a refused creation or invalid ID", async () => {
		for (const response of [new Response("unavailable", { status: 503 }), Response.json({}), Response.json({ id: "../bad?prompt=leak" })]) {
			const starter = new SessionStarter();
			await assert.rejects(starter.start({ title: "hello" }, (async () => response) as typeof fetch));
			assert.equal(data.size, 0);
		}
	});
});
