/**
 * Browser file staging: the shared useSessionAttachments controller, the
 * composer's tray/paste/paperclip/Enter wiring, and browser drops. Same
 * linkedom shims as composer-attach.test.tsx; fetch is a local fake, so
 * no route or provider runs.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatSessionComposer, Composer, enterAction } from "../components/composer.tsx";
import { FilePathDropZone, BROWSER_FOLDER_NOTICE, BROWSER_COMPOSER_NOTICE } from "../components/file-path-drop-zone.tsx";
import {
	ATTACHMENT_COUNT_ERROR, ATTACHMENT_LIMIT_ERROR, MAX_SESSION_ATTACHMENT_BYTES, MAX_SESSION_ATTACHMENTS, SavedSessionAttachment, useSessionAttachments, type SessionAttachments,
} from "../components/session-attachments.tsx";
import type { SessionAttachmentInfo } from "../src/core";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

type Upload = { url: string; ids: string[]; names: string[] };
type Reply = { status: number; body: unknown } | Error;

function info(id: string, name: string, kind: SessionAttachmentInfo["kind"] = "text", size = 4): SessionAttachmentInfo {
	return { id, name, kind, mimeType: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain", size };
}

async function fixture({ busy = false, desktop = false, sendAllowed = true, withZone = false } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 600, left: 0, right: 40, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const uploads: Upload[] = [];
	const replies: Reply[] = [];
	const created: string[] = [];
	const revoked: string[] = [];
	let urls = 0;
	let sends = 0;
	let stops = 0;
	let pickerClicks = 0;
	let value = "draft";
	let isBusy = busy;
	let attachments!: SessionAttachments;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800,
		fetch: async (url: string, init: RequestInit) => {
			const form = init.body as FormData;
			uploads.push({ url, ids: form.getAll("ids") as string[], names: (form.getAll("files") as File[]).map((file) => file.name) });
			const reply = replies.shift() ?? { status: 200, body: { attachments: (form.getAll("ids") as string[]).map((id, index) => info(id, (form.getAll("files")[index] as File).name)) } };
			if (reply instanceof Error) throw reply;
			return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const urlStatics = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
	URL.createObjectURL = () => { const url = `blob:test/${++urls}`; created.push(url); return url; };
	URL.revokeObjectURL = (url: string) => { revoked.push(url); };
	Object.defineProperty(win, "lh", { configurable: true, value: desktop ? { getPathForFile: () => "/desktop/file.pdf" } : undefined });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function Harness({ mounted }: { mounted: boolean }) {
		attachments = useSessionAttachments();
		if (!mounted) return withZone ? <FilePathDropZone><div data-testid="content">Content</div></FilePathDropZone> : null;
		const composer = <div data-attachment-composer="">
			<ChatSessionComposer busy={isBusy} value={value} revision={0} onChange={(next) => { value = next; }}
				onSend={() => { sends++; }} onStop={() => { stops++; }} sendAllowed={sendAllowed} dictationActive={false} attachments={attachments} />
		</div>;
		return withZone ? <FilePathDropZone>{composer}<div data-testid="content">Content</div></FilePathDropZone> : composer;
	}
	let mounted = true;
	const draw = () => root.render(<Harness mounted={mounted} />);
	await act(async () => { draw(); });
	const picker = () => {
		const input = doc.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
		input.click = () => { pickerClicks++; };
		return input;
	};
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		URL.createObjectURL = urlStatics.create;
		URL.revokeObjectURL = urlStatics.revoke;
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = () => doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		doc, win, uploads, replies, created, revoked,
		get attachments() { return attachments; },
		get value() { return value; },
		get sends() { return sends; },
		get stops() { return stops; },
		get pickerClicks() { return pickerClicks; },
		editor,
		async clearDraft() {
			editor().textContent = "";
			await act(async () => { editor().dispatchEvent(new win.Event("input", { bubbles: true })); });
		},
		names() { return attachments.items.map((item) => item.name); },
		async run<T>(fn: () => T | Promise<T>): Promise<T> { let result!: T; await act(async () => { result = await fn(); }); return result; },
		async setBusy(next: boolean) { isBusy = next; await act(async () => { draw(); }); },
		async unmountComposer() { mounted = false; await act(async () => { draw(); }); },
		async unmountAll() { await act(async () => { root.unmount(); }); cleanup = async () => {
			URL.createObjectURL = urlStatics.create;
			URL.revokeObjectURL = urlStatics.revoke;
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete (globalThis as Record<string, unknown>)[name];
			}
		}; },
		async paste(files: File[], text = "") {
			const event = Object.assign(new win.Event("paste", { bubbles: true, cancelable: true }), {
				clipboardData: { files, getData: (type: string) => type === "text/plain" ? text : "" },
			});
			editor().focus();
			await act(async () => { editor().dispatchEvent(event); });
			return event;
		},
		async key(key: string) {
			const event = Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key });
			await act(async () => { editor().dispatchEvent(event); });
			return event;
		},
		async clickSubmit() {
			// linkedom has no implicit submission; the submit button's click is a form submit.
			await act(async () => { doc.querySelector('[data-testid="composer"]')!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
		},
		async pick(files: File[]) {
			const input = picker();
			await act(async () => { doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!.click(); });
			Object.defineProperty(input, "files", { configurable: true, value: files });
			await act(async () => { input.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
		async drop(files: File[], directories: number[] = [], target: Element = doc.querySelector('[data-testid="content"]')!) {
			const dataTransfer = {
				types: ["Files"], dropEffect: "none",
				files: Object.assign([...files], { item: (index: number) => files[index] ?? null }),
				items: files.map((file, index) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directories.includes(index), isFile: !directories.includes(index) }) })),
			};
			for (const type of ["dragenter", "drop"]) {
				const event = Object.assign(new win.Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
				await act(async () => { target.dispatchEvent(event); });
			}
		},
		get status() { return doc.querySelector('main [role="status"]')?.textContent ?? ""; },
	};
}

const png = (name = "board.png", size = 4) => new File([new Uint8Array(size)], name, { type: "image/png" });
const text = (name = "notes.txt") => new File(["abcd"], name, { type: "text/plain" });

describe("useSessionAttachments", () => {
	it("stages additively with stable unique ids and image previews only", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text(), png()]));
		await f.run(() => f.attachments.addFiles([png("second.png")]));
		assert.deepEqual(f.names(), ["notes.txt", "board.png", "second.png"]);
		const ids = f.attachments.items.map((item) => item.id);
		assert.equal(new Set(ids).size, 3);
		assert.equal(f.attachments.items[0]!.previewUrl, undefined);
		assert.deepEqual(f.attachments.items.slice(1).map((item) => item.previewUrl), f.created);
		await f.setBusy(false);
		assert.deepEqual(f.attachments.items.map((item) => item.id), ids, "rerenders keep ids");
	});

	it("enforces the 25 MiB aggregate: files that fit stage, the rest report an error", async () => {
		const f = await fixture();
		const half = MAX_SESSION_ATTACHMENT_BYTES / 2;
		await f.run(() => f.attachments.addFiles([new File([new Uint8Array(half)], "a.pdf", { type: "application/pdf" })]));
		await f.run(() => f.attachments.addFiles([new File([new Uint8Array(half + 1)], "b.pdf"), new File([new Uint8Array(half)], "c.pdf")]));
		assert.deepEqual(f.names(), ["a.pdf", "c.pdf"]);
		assert.equal(f.attachments.error, ATTACHMENT_LIMIT_ERROR);
		await f.run(() => f.attachments.remove(f.attachments.items[1]!.id));
		assert.equal(f.attachments.error, "");
	});

	it("caps a send at 100 files", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles(Array.from({ length: MAX_SESSION_ATTACHMENTS + 2 }, (_, index) => text(`${index}.txt`))));
		assert.equal(f.attachments.items.length, MAX_SESSION_ATTACHMENTS);
		assert.equal(f.attachments.error, ATTACHMENT_COUNT_ERROR);
	});

	it("prepare uploads files with matching ids in one request and caches per chat", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text(), png()]));
		const ids = f.attachments.items.map((item) => item.id);
		const prepared = await f.run(() => f.attachments.prepare("chat/1"));
		assert.deepEqual(f.uploads, [{ url: "/api/chats/chat%2F1/attachments", ids, names: ["notes.txt", "board.png"] }]);
		assert.deepEqual(prepared.map((entry) => entry.id), ids);
		assert.equal(f.attachments.busy, false);
		assert.deepEqual(f.attachments.items.map((item) => item.chatId), ["chat/1", "chat/1"]);
		await f.run(() => f.attachments.addFiles([text("later.txt")]));
		const again = await f.run(() => f.attachments.prepare("chat/1"));
		assert.equal(f.uploads.length, 2);
		assert.deepEqual(f.uploads[1]!.names, ["later.txt"], "cached entries are not uploaded again");
		assert.equal(again.length, 3);
		await f.run(() => f.attachments.prepare("other"));
		assert.deepEqual(f.uploads[2]!.names, ["notes.txt", "board.png", "later.txt"], "another chat prepares its own copies");
	});

	it("a failed prepare throws, reports the server error and keeps the draft for a same-id retry", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text()]));
		const id = f.attachments.items[0]!.id;
		f.replies.push({ status: 413, body: { error: "Attachments are too large." } });
		assert.match(String(await f.run(() => f.attachments.prepare("c").catch((error: Error) => error.message))), /too large/);
		assert.equal(f.attachments.error, "Attachments are too large.");
		assert.equal(f.attachments.busy, false);
		assert.equal(f.attachments.items[0]!.info, undefined);
		f.replies.push(new Error("offline"));
		assert.match(String(await f.run(() => f.attachments.prepare("c").catch((error: Error) => error.message))), /Could not upload/);
		await f.run(() => f.attachments.prepare("c"));
		assert.deepEqual(f.uploads.map((upload) => upload.ids), [[id], [id], [id]]);
		assert.equal(f.attachments.error, "");
	});

	it("rejects a response that omits a submitted id", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text(), text("b.txt")]));
		f.replies.push({ status: 200, body: { attachments: [info(f.attachments.items[0]!.id, "notes.txt")] } });
		await assert.rejects(f.run(() => f.attachments.prepare("c")), /did not return every attachment/);
	});

	it("clear(ids) removes only submitted entries, preserving files added during the send", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([png("sent.png")]));
		const submitted = f.attachments.snapshot().map((item) => item.id);
		await f.run(() => f.attachments.addFiles([png("newer.png")]));
		await f.run(() => f.attachments.clear(submitted));
		assert.deepEqual(f.names(), ["newer.png"]);
		assert.deepEqual(f.revoked, [f.created[0]]);
		await f.run(() => f.attachments.clear());
		assert.deepEqual(f.names(), []);
		assert.deepEqual(f.revoked, f.created);
	});

	it("restore re-stages prepared infos without Files; images preview via the chat endpoint and prepare skips upload", async () => {
		const f = await fixture();
		const infos = [info("a1", "photo.png", "image"), info("a2", "paper.pdf", "pdf")];
		await f.run(() => f.attachments.restore(infos, "chat 1"));
		await f.run(() => f.attachments.restore(infos, "chat 1"));
		assert.deepEqual(f.names(), ["photo.png", "paper.pdf"], "duplicate ids are ignored");
		assert.equal(f.attachments.items[0]!.file, undefined);
		assert.equal(f.attachments.items[0]!.previewUrl, "/api/chats/chat%201/attachments/a1");
		assert.equal(f.attachments.items[1]!.previewUrl, undefined);
		assert.deepEqual(await f.run(() => f.attachments.prepare("chat 1")), infos);
		assert.equal(f.uploads.length, 0);
		await assert.rejects(f.run(() => f.attachments.prepare("other chat")), /no longer available/);
		await f.run(() => f.attachments.clear());
		assert.deepEqual(f.revoked, [], "server URLs are never revoked");
	});

	it("revokes object URLs on unmount and ignores a prepare that settles afterwards", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([png()]));
		const pending = f.attachments.prepare("c");
		await f.unmountAll();
		assert.deepEqual(f.revoked, f.created);
		assert.equal((await pending).length, 1);
	});
});

describe("composer with staged files", () => {
	it("static render without attachments is unchanged: inert browser paperclip, no tray", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.ok(!html.includes("data-session-attachment-input"));
		assert.ok(!html.includes("session-attachments"));
		assert.match(html, /aria-disabled="true"/);
	});

	it("sendLabel names the send button", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend sendLabel="Start session" />);
		assert.ok(html.includes('aria-label="Start session"'));
		assert.ok(!html.includes('aria-label="Send"'));
	});

	it("SavedSessionAttachment renders the filename and an encoded endpoint image for images only", () => {
		const image = renderToStaticMarkup(<SavedSessionAttachment chatId="c/1" attachment={info("x?y", "board.png", "image")} />);
		assert.ok(image.includes('src="/api/chats/c%2F1/attachments/x%3Fy"'));
		assert.ok(image.includes("board.png"));
		const pdf = renderToStaticMarkup(<SavedSessionAttachment chatId="c" attachment={info("p", "paper.pdf", "pdf")} />);
		assert.ok(!pdf.includes("<img") && pdf.includes("paper.pdf"));
	});

	it("browser paperclip opens the picker directly and stages picked files", async () => {
		const f = await fixture();
		const button = f.doc.querySelector('[data-testid="attach-files"]')!;
		assert.equal(button.getAttribute("aria-disabled"), "false");
		assert.equal(button.getAttribute("aria-haspopup"), null);
		await f.pick([text(), png()]);
		assert.equal(f.doc.activeElement, f.editor(), "ready for an image paste immediately after choosing files");
		assert.equal(f.pickerClicks, 1);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.deepEqual(f.names(), ["notes.txt", "board.png"]);
		assert.equal(f.value, "draft");
	});

	it("desktop keeps the Files/Folder menu and never stages Files", async () => {
		const f = await fixture({ desktop: true });
		await act(async () => { f.doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!.click(); });
		assert.deepEqual(Array.from(f.doc.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent), ["Files", "Folder"]);
		assert.deepEqual(f.names(), []);
	});

	it("desktop: image paste stages nothing, the composer carries no staging marker, and drops stay paths", async () => {
		const f = await fixture({ desktop: true, withZone: true });
		assert.equal(f.doc.querySelector("[data-session-attachment-input]"), null);
		await f.paste([png("pasted.png")]);
		assert.deepEqual(f.names(), []);
		assert.equal(f.value, "draft");
		f.editor().focus();
		await f.drop([png()]);
		assert.deepEqual(f.names(), []);
		assert.match(f.value, /`\/desktop\/file\.pdf`/);
		f.editor().dispatchEvent(new f.win.CustomEvent("lh:insert-session-files", { detail: [png()] }));
		assert.deepEqual(f.names(), [], "no File listener on desktop");
	});

	it("tray lists names, previews images and removes entries", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text(), png()]));
		const tray = f.doc.querySelector('[data-testid="session-attachments"]')!;
		assert.ok(tray.textContent!.includes("notes.txt") && tray.textContent!.includes("board.png"));
		assert.equal(tray.querySelectorAll("img").length, 1);
		await act(async () => { f.doc.querySelector<HTMLButtonElement>('[aria-label="Remove notes.txt"]')!.click(); });
		assert.deepEqual(f.names(), ["board.png"]);
	});

	it("pasting images adds to existing files and keeps the draft; text paste stays native", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([text()]));
		const imagePaste = await f.paste([png("pasted.png"), text("ignored.txt")]);
		assert.equal(imagePaste.defaultPrevented, true);
		assert.deepEqual(f.names(), ["notes.txt", "pasted.png"]);
		assert.equal(f.value, "draft");
		const textPaste = await f.paste([], " more");
		assert.deepEqual(f.names(), ["notes.txt", "pasted.png"]);
		assert.equal(f.value.includes("more"), true, "PathInput still handles plaintext");
		assert.equal(textPaste.defaultPrevented, true, "PathInput's own handler prevents the native insert");
	});

	it("attachment-only sends work on an idle agent", async () => {
		const f = await fixture();
		await f.clearDraft();
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, true);
		await f.run(() => f.attachments.addFiles([png()]));
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, false);
		await f.key("Enter");
		assert.equal(f.sends, 1);
	});

	it("ChatSessionComposer: files do not override sendAllowed=false", async () => {
		const f = await fixture({ sendAllowed: false });
		await f.clearDraft();
		await f.run(() => f.attachments.addFiles([png()]));
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, true);
		await f.key("Enter");
		assert.equal(f.sends, 0);
	});

	it("base Composer keeps a caller's canSend=false even with staged files", () => {
		const staged = { items: [{ id: "a", name: "a.png" }], busy: false, error: "" } as unknown as SessionAttachments;
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} attachments={staged} sendLabel="Start session" />);
		assert.match(html, /aria-label="Start session"[^>]*disabled|disabled[^>]*aria-label="Start session"/);
		assert.ok(html.includes("a.png") && html.includes("data-session-attachment-input"));
	});

	it("an idle send with only staged files is enabled; while preparing, send is disabled and Enter does nothing", async () => {
		const f = await fixture();
		await f.run(() => f.attachments.addFiles([png()]));
		let release!: () => void;
		f.replies.push({ status: 200, body: { attachments: [] } });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (...args: Parameters<typeof fetch>) => { await gate; return realFetch(...args); };
		let preparing!: Promise<unknown>;
		await act(async () => { preparing = f.attachments.prepare("c").catch(() => {}); });
		assert.equal(f.attachments.busy, true);
		assert.match(f.doc.querySelector('[data-testid="session-attachments"]')!.textContent!, /Preparing attachments/);
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, true);
		await f.key("Enter");
		assert.equal(f.sends, 0);
		assert.equal(f.stops, 0);
		await act(async () => { release(); await preparing; });
	});

	it("busy turn with staged files: Enter never stops or sends, Stop button still stops", async () => {
		const f = await fixture({ busy: true });
		await f.run(() => f.attachments.addFiles([png()]));
		for (const draft of ["", "steer"]) {
			f.editor().textContent = draft;
			await act(async () => { f.editor().dispatchEvent(new f.win.Event("input", { bubbles: true })); });
			assert.equal(f.value, draft);
			await f.key("Enter");
			assert.equal(f.stops, 0, `Enter with draft ${JSON.stringify(draft)} must not stop`);
			assert.equal(f.sends, 0, "text plus waiting files does not send mid-turn");
			assert.match(f.doc.querySelector('[data-testid="session-attachments"]')!.textContent!, /once the current reply finishes/);
			assert.ok(f.doc.querySelector('button[aria-label="Stop"]'));
		}
		await f.clickSubmit();
		assert.equal(f.stops, 1);
		await f.setBusy(false);
		assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, false);
		await f.key("Enter");
		assert.equal(f.sends, 1);
	});

	it("busy turn without staged files: text steering is unchanged", async () => {
		const f = await fixture({ busy: true });
		await f.key("Enter");
		assert.equal(f.sends, 1, "the fixture draft steers");
		await f.clearDraft();
		await f.key("Enter");
		assert.equal(f.stops, 1, "empty composer Enter still stops");
	});

	it("enterAction: waiting files suppress stop and next, never a text send", () => {
		assert.equal(enterAction({ busy: true, canSend: false, waiting: true }), "none");
		assert.equal(enterAction({ busy: false, canSend: false, nextProblem: true, waiting: true }), "none");
		assert.equal(enterAction({ busy: true, canSend: true, waiting: true }), "send");
	});
});

describe("browser drops", () => {
	it("stage dropped Files on the marked composer, adding to existing ones", async () => {
		const f = await fixture({ withZone: true });
		await f.run(() => f.attachments.addFiles([text()]));
		await f.drop([png(), text("b.md")]);
		assert.equal(f.doc.activeElement, f.editor(), "dropping files returns focus to the composer for image paste");
		assert.deepEqual(f.names(), ["notes.txt", "board.png", "b.md"]);
		assert.equal(f.status, "");
		assert.equal(f.value, "draft", "no paths enter the draft");
	});

	it("refuse folders with a notice while still staging the files", async () => {
		const f = await fixture({ withZone: true });
		await f.drop([png(), new File([], "folder")], [1]);
		assert.deepEqual(f.names(), ["board.png"]);
		assert.equal(f.status.replace("Dismiss attachment notice", ""), BROWSER_FOLDER_NOTICE);
	});

	it("does not add dropped files to a new-session composer locked during navigation", async () => {
		const f = await fixture({ withZone: true });
		await f.run(() => f.attachments.addFiles([text()]));
		f.doc.querySelector("[data-attachment-composer]")!.setAttribute("inert", "");
		await f.drop([png()]);
		assert.deepEqual(f.names(), ["notes.txt"]);
		assert.equal(f.status.replace("Dismiss attachment notice", ""), BROWSER_COMPOSER_NOTICE);
	});

	it("without a staging composer, asks to open the composer", async () => {
		const f = await fixture({ withZone: true });
		await f.unmountComposer();
		await f.drop([png()]);
		assert.equal(f.status.replace("Dismiss attachment notice", ""), BROWSER_COMPOSER_NOTICE);
		assert.deepEqual(f.names(), []);
	});
});
