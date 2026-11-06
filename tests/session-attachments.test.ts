/**
 * Browser session attachments: core contract, store, upload/serve routes,
 * and the send path. Scripted faux engines only: no real providers.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore, fauxAssistantMessage, fauxText, type Context } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PreparedSessionAttachment, SessionAttachmentInfo } from "../src/core/session-attachments.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-attachments-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { chatStore } = await import("../src/store/chats.ts");
const { prepareSessionAttachments, sessionAttachmentImageResponse } = await import("../src/server/session-attachments.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { piModels } = await import("../src/agent/models.ts");
const { ChatInputError, inputAppends, parseChatInput, parseUserSteerInput } = await import("../src/core/input-events.ts");
const { newUserMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");
const { serializeForSummary } = await import("../src/core/compaction.ts");
const { sessionCost } = await import("../src/core/prices.ts");
const { MAX_SESSION_ATTACHMENT_BYTES, ownSessionAttachment, sendNeedsImageInput } = await import("../src/core/session-attachments.ts");
const { POST: uploadRoute } = await import("../app/api/chats/[id]/attachments/route.ts");
const { GET: imageRoute } = await import("../app/api/chats/[id]/attachments/[attachmentId]/route.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
function picture(width = 40, height = 30): Buffer {
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

const textAttachment: PreparedSessionAttachment = { id: "t1", name: "notes.md", kind: "text", mimeType: "text/plain", size: 12, text: "# My notes" };
const pdfAttachment: PreparedSessionAttachment = { id: "p1", name: "paper.pdf", kind: "pdf", mimeType: "application/pdf", size: 900, text: "--- Page 1 ---\n\nTheorem 1" };
const imageAttachment: PreparedSessionAttachment = {
	id: "i1", name: "board.png", kind: "image", mimeType: "image/png", size: 70,
	image: { mimeType: "image/png", data: PNG_1PX.toString("base64"), width: 1, height: 1 },
};

/** A faux engine that records every context it is asked to answer. */
function scripted(replies: string[], input: ("text" | "image")[] = ["text", "image"]) {
	const faux = createFauxCore({ models: [{ id: "vision", input }], tokenSize: { min: 8, max: 8 } });
	faux.setResponses(replies.map((text) => fauxAssistantMessage([fauxText(text)])));
	const contexts: Context[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => { contexts.push(structuredClone(context)); return faux.streamSimple(model, context, options); },
	};
	return { engine, contexts };
}

function upload(chatId: string, files: { name: string; bytes: Uint8Array | string; type?: string }[], ids: string[] = files.map((_, i) => `att_${i}`)): Request {
	const form = new FormData();
	for (const f of files) form.append("files", new File([f.bytes as BlobPart], f.name, { type: f.type ?? "" }));
	for (const id of ids) form.append("ids", id);
	return new Request(`http://test/api/chats/${chatId}/attachments`, { method: "POST", body: form });
}

function newChat(model = "z-ai/glm-5.3-flash") {
	const chat = chatStore.createChat("Attachment test");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: model } });
	return chat;
}

const textOnlyModel = (() => {
	const all = (piModels() as unknown as { getModels(p: string): { id: string; input: string[] }[] }).getModels("openrouter");
	return all.find((m) => !m.id.startsWith("~") && !m.input.includes("image"))!.id;
})();

describe("session attachment input contract", () => {
	it("accepts attachment-only text input and validates ids", () => {
		assert.deepEqual(parseChatInput({ type: "text", text: "", attachmentIds: ["a_1"] }), { type: "text", text: "", attachmentIds: ["a_1"] });
		assert.deepEqual(parseChatInput({ type: "text", text: "hi", attachmentIds: [] }), { type: "text", text: "hi" });
		assert.throws(() => parseChatInput({ type: "text", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "", attachmentIds: [] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: ["a", "a"] }), /duplicate/);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: ["../a"] }), /invalid/);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: Array.from({ length: 101 }, (_, i) => `a${i}`) }), /at most 100/);
		assert.throws(() => parseUserSteerInput({ type: "steer", id: "steer_1", text: "x", attachmentIds: ["a"] }), /cannot carry attachments/);
	});

	it("resolves ids into native content, strips app metadata at the wire, and shows chips in the view", () => {
		const record = { messages: [] as LhMessage[], attachments: { t1: textAttachment, p1: pdfAttachment, i1: imageAttachment } };
		const [message] = inputAppends(record, { type: "text", text: "Look at these", attachmentIds: ["p1", "t1", "i1"] });
		const m = message as LhMessage & { role: "user" };
		assert.deepEqual(m.content, [
			{ type: "text", text: "Look at these" },
			{ type: "text", text: "[Attached PDF: paper.pdf, transcribed page by page]\n\n--- Page 1 ---\n\nTheorem 1" },
			{ type: "text", text: "[Attached file: notes.md]\n\n# My notes" },
			{ type: "text", text: "[Attached image: board.png]" },
			{ type: "image", data: imageAttachment.image!.data, mimeType: "image/png" },
		]);
		assert.equal(m.userText, "Look at these");
		assert.deepEqual(m.sessionAttachments!.map((a) => a.id), ["p1", "t1", "i1"]);
		assert.ok(!("text" in m.sessionAttachments![0]!));

		const wire = toLlmMessages([m] as never)[0] as unknown as Record<string, unknown>;
		assert.ok(!("sessionAttachments" in wire) && !("userText" in wire) && !("id" in wire));

		const [view] = projectView([m]);
		assert.deepEqual(view!.parts.map((p) => p.type), ["text", "data-session-attachment", "data-session-attachment", "data-session-attachment"]);
		assert.equal(view!.parts[0]!.text, "Look at these");
		assert.ok(!JSON.stringify(view).includes("Theorem 1"), "transcriptions stay out of the bubble");

		const onlyFiles = newUserMessage("", [textAttachment]);
		assert.equal(onlyFiles.userText, "");
		assert.deepEqual(projectView([onlyFiles])[0]!.parts.map((p) => p.type), ["data-session-attachment"]);
		assert.deepEqual((onlyFiles.content as unknown[]).length, 1);
	});

	it("rejects unknown ids and oversized sends", () => {
		assert.throws(() => inputAppends({ messages: [] }, { type: "text", text: "", attachmentIds: ["gone"] }), /no longer available/);
		const big = { ...textAttachment, id: "big", size: MAX_SESSION_ATTACHMENT_BYTES };
		assert.throws(() => inputAppends({ messages: [], attachments: { big, t1: textAttachment } }, { type: "text", text: "", attachmentIds: ["big", "t1"] }), /25 MB/);
	});

	it("keeps complete attachment text in the compaction input", () => {
		const m = newUserMessage("Summarize", [pdfAttachment, imageAttachment]);
		const serialized = serializeForSummary([m]);
		assert.match(serialized, /Theorem 1/);
		assert.match(serialized, /\[Attached image: board\.png\]/);
		assert.ok(!serialized.includes(imageAttachment.image!.data));
	});

	it("folds attachment usage into the session cost totals, not turnCosts", () => {
		const step = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
		const pricing = sessionCost({
			turns: [{ id: "turn", messageId: "m", at: "", model: "openrouter:x", steps: [step] }],
			attachmentUsage: [{ id: "u", attachmentId: "p1", at: "", model: "openrouter:x", steps: [step, step] }],
		}, () => 1);
		assert.equal(pricing.cost, 3);
		assert.deepEqual(Object.keys(pricing.turnCosts), ["turn"]);
	});
});

describe("session attachment store", () => {
	it("first write wins, does not reorder the sidebar, and stays out of list summaries", () => {
		const chat = newChat();
		chatStore.saveSessionAttachment!(chat.id, textAttachment);
		chatStore.saveSessionAttachment!(chat.id, { ...textAttachment, text: "replaced" });
		chatStore.appendAttachmentUsage!(chat.id, { id: "u1", attachmentId: "t1", at: "", model: "m", steps: [] });
		chatStore.appendAttachmentUsage!(chat.id, { id: "u1", attachmentId: "t1", at: "", model: "m", steps: [] });
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.attachments!.t1!.text, "# My notes");
		assert.equal(record.attachmentUsage!.length, 1);
		assert.equal(record.updatedAt, chat.updatedAt);
		const summary = chatStore.listChats().find((s) => s.id === chat.id)!;
		assert.ok(!("attachments" in summary) && !("attachmentUsage" in summary));
		assert.throws(() => chatStore.saveSessionAttachment!(chat.id, { ...textAttachment, id: "bad/id" }), /Invalid attachment id/);
	});
});

describe("POST /api/chats/[id]/attachments", () => {
	it("refuses unknown sessions before reading files", async () => {
		const res = await uploadRoute(upload("chat_missing", [{ name: "a.txt", bytes: "x" }]), { params: Promise.resolve({ id: "chat_missing" }) });
		assert.equal(res.status, 404);
		const invalid = await prepareSessionAttachments("../etc", upload("x", [{ name: "a.txt", bytes: "x" }]));
		assert.equal(invalid.status, 404);
	});

	it("prepares text and images, and reuses stored ids on retry", async () => {
		const chat = newChat();
		const { engine } = scripted([]);
		const req = () => upload(chat.id, [{ name: "notes.md", bytes: "\uFEFF# Notes\nline" }, { name: "board.png", bytes: picture(), type: "image/png" }], ["n1", "img1"]);
		const res = await prepareSessionAttachments(chat.id, req(), { engineFor: () => engine });
		assert.equal(res.status, 200);
		const body = await res.json() as { attachments: SessionAttachmentInfo[] };
		assert.deepEqual(body.attachments.map((a) => [a.id, a.kind, a.mimeType, a.name]), [["n1", "text", "text/plain", "notes.md"], ["img1", "image", "image/png", "board.png"]]);
		assert.ok(body.attachments.every((a) => !("text" in a) && !("image" in a)));
		const stored = chatStore.getChat(chat.id)!.attachments!;
		assert.equal(stored.n1!.text, "# Notes\nline");
		assert.equal(stored.img1!.image!.width, 40);

		const before = JSON.stringify(stored);
		const again = await prepareSessionAttachments(chat.id, req(), { engineFor: () => assert.fail("reused ids need no model") });
		assert.equal(again.status, 200);
		assert.equal(JSON.stringify(chatStore.getChat(chat.id)!.attachments), before);

		const image = await imageRoute(new Request("http://test"), { params: Promise.resolve({ id: chat.id, attachmentId: "img1" }) });
		assert.equal(image.status, 200);
		assert.equal(image.headers.get("content-type"), "image/png");
		assert.equal(image.headers.get("x-content-type-options"), "nosniff");
		assert.equal(image.headers.get("cache-control"), "private, no-store");
		assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), stored.img1!.image!.data);
		assert.equal((await imageRoute(new Request("http://test"), { params: Promise.resolve({ id: chat.id, attachmentId: "n1" }) })).status, 404);
		assert.equal(sessionAttachmentImageResponse(chat.id, "../x").status, 404);
	});

	it("transcribes PDFs with the session engine and records usage, including failures", async () => {
		const chat = newChat();
		const pdf = tinyPdf([{ runs: [{ text: "Page one", x: 72, y: 700 }] }, {}]);
		const renderPage = async () => PNG_1PX;
		const ok = scripted(["Page one", "[blank page]"]);
		const res = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "paper.pdf", bytes: pdf, type: "application/pdf" }], ["pdf1"]), { engineFor: () => ok.engine, renderPage });
		assert.equal(res.status, 200);
		assert.equal(ok.contexts.length, 2);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.attachments!.pdf1!.text, "--- Page 1 ---\n\nPage one\n\n--- Page 2 ---\n\n[blank page]");
		assert.equal(record.attachmentUsage!.length, 1);
		assert.equal(record.attachmentUsage![0]!.attachmentId, "pdf1");
		assert.equal(record.attachmentUsage![0]!.steps.length, 2);
		assert.ok(!record.turns?.length, "transcription never lands in the turn log");

		// Second file fails on its second page: the first success stays saved.
		const failing = scripted(["Only page one"]);
		const res2 = await prepareSessionAttachments(chat.id, upload(chat.id, [
			{ name: "a.txt", bytes: "kept" },
			{ name: "broken.pdf", bytes: pdf, type: "application/pdf" },
		], ["txt2", "pdf2"]), { engineFor: () => failing.engine, renderPage });
		assert.equal(res2.status, 422);
		assert.match((await res2.json() as { error: string }).error, /Could not prepare broken\.pdf/);
		const after = chatStore.getChat(chat.id)!;
		assert.equal(after.attachments!.txt2!.text, "kept");
		assert.ok(!after.attachments!.pdf2);
		assert.equal(after.attachmentUsage!.length, 2, "the failed attempt's billed page is recorded");
	});

	it("gates PDFs and images on the session model's image input", async () => {
		const chat = newChat();
		const textOnly = scripted([], ["text"]);
		const res = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "b.png", bytes: picture() }]), { engineFor: () => textOnly.engine });
		assert.equal(res.status, 400);
		assert.match((await res.json() as { error: string }).error, /can't read images/);
		const text = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "a.txt", bytes: "fine" }]), { engineFor: () => textOnly.engine });
		assert.equal(text.status, 200);
	});

	it("rejects malformed requests and files that are not what they claim", async () => {
		const chat = newChat();
		const call = (files: Parameters<typeof upload>[1], ids?: string[]) => prepareSessionAttachments(chat.id, upload(chat.id, files, ids), { engineFor: () => assert.fail("no model for rejected uploads") });
		assert.equal((await call([{ name: "a.txt", bytes: "x" }], [])).status, 400);
		assert.equal((await call([{ name: "a.txt", bytes: "x" }, { name: "b.txt", bytes: "y" }], ["same", "same"])).status, 400);
		assert.equal((await call([{ name: "a.txt", bytes: "x" }], ["bad id"])).status, 400);
		assert.equal((await call([{ name: `${"n".repeat(256)}.txt`, bytes: "x" }])).status, 400);
		assert.equal((await call([{ name: "fake.pdf", bytes: "not a pdf" }])).status, 415);
		assert.equal((await call([{ name: "fake.png", bytes: "not a png" }])).status, 415);
		assert.equal((await call([{ name: "photo.jpg", bytes: "x", type: "image/jpeg" }])).status, 415);
		assert.equal((await call([{ name: "tool.exe", bytes: "MZ text-looking" }])).status, 415);
		assert.equal((await call([{ name: "data.txt", bytes: new Uint8Array([0x61, 0x00, 0x62]) }])).status, 415);
		assert.equal((await call([{ name: "latin1.txt", bytes: new Uint8Array([0xe9, 0x74, 0xe9]) }])).status, 415);
		assert.equal((await call([{ name: "archive.zip", bytes: "PK" }])).status, 415);
		assert.equal(chatStore.getChat(chat.id)!.attachments, undefined);
		const tooBig = await call([{ name: "big.txt", bytes: new Uint8Array(MAX_SESSION_ATTACHMENT_BYTES + 1).fill(0x61) }]);
		assert.equal(tooBig.status, 413);
	});
});

describe("sending prepared attachments", () => {
	type AgentFactory = (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent;
	const post = (chatId: string, input: unknown) => new Request("http://test/api/chat", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }),
	});
	async function turn(engine: PiEngine, chatId: string, input: unknown): Promise<Response> {
		const factory: AgentFactory = (opts) => createTeacherAgent(undefined, { ...opts, engine });
		const ack = await handleChatRequest(post(chatId, input), factory);
		if (ack.status === 200) {
			const handle = runningTurn(chatId);
			if (handle) await new Response(handle.subscribe()).text();
		}
		return ack;
	}

	it("runs an attachment-only turn with the contents in native user content and keeps the map", async () => {
		const chat = newChat();
		chatStore.saveSessionAttachment!(chat.id, textAttachment);
		chatStore.saveSessionAttachment!(chat.id, imageAttachment);
		const { engine, contexts } = scripted(["Got it."]);
		const res = await turn(engine, chat.id, { type: "text", text: "", attachmentIds: ["t1", "i1"] });
		assert.equal(res.status, 200);
		const user = contexts[0]!.messages.find((m) => m.role === "user")!;
		assert.deepEqual((user.content as { type: string }[]).map((c) => c.type), ["text", "text", "image"]);
		assert.ok(!("sessionAttachments" in user) && !("userText" in user));
		const record = chatStore.getChat(chat.id)!;
		const saved = record.messages.find((m) => m.role === "user")!;
		assert.deepEqual(saved.sessionAttachments!.map((a) => a.id), ["t1", "i1"]);
		assert.ok(record.attachments!.t1 && record.attachments!.i1, "the map stays reusable after a send");
	});

	it("refuses image-bearing sends when the session model changed to one without image input", async () => {
		const chat = newChat(textOnlyModel);
		chatStore.saveSessionAttachment!(chat.id, imageAttachment);
		chatStore.saveSessionAttachment!(chat.id, pdfAttachment);
		const { engine } = scripted(["unused"]);
		const refused = await turn(engine, chat.id, { type: "text", text: "see", attachmentIds: ["i1"] });
		assert.equal(refused.status, 400);
		assert.match((await refused.json() as { error: string }).error, /can't read images/);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "nothing appended");
		const unknown = await turn(engine, chat.id, { type: "text", text: "", attachmentIds: ["missing"] });
		assert.equal(unknown.status, 400);
		const pdfOk = scripted(["Read it."]);
		assert.equal((await turn(pdfOk.engine, chat.id, { type: "text", text: "", attachmentIds: ["p1"] })).status, 200);
	});
});

describe("session attachment hardening", () => {
	const renderPage = async () => PNG_1PX;
	const pdf = () => tinyPdf([{ runs: [{ text: "Page one", x: 72, y: 700 }] }]);

	it("never resolves inherited keys as attachments", async () => {
		const empty = { messages: [] as LhMessage[], attachments: {} as Record<string, PreparedSessionAttachment> };
		for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			assert.throws(() => inputAppends(empty, { type: "text", text: "", attachmentIds: [id] }), /no longer available/, id);
			assert.equal(sendNeedsImageInput(empty, [id]), false);
			assert.equal(ownSessionAttachment(empty, id), undefined);
		}
		const chat = newChat();
		assert.equal(sessionAttachmentImageResponse(chat.id, "constructor").status, 404);
		// Inherited-looking ids are ordinary own entries once prepared.
		const res = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "a.txt", bytes: "proto" }, { name: "b.txt", bytes: "ctor" }], ["__proto__", "constructor"]));
		assert.equal(res.status, 200);
		const record = chatStore.getChat(chat.id)!;
		assert.ok(Object.hasOwn(record.attachments!, "__proto__") && Object.hasOwn(record.attachments!, "constructor"));
		assert.equal(ownSessionAttachment(record, "__proto__")!.text, "proto");
		assert.equal(Object.getPrototypeOf(record.attachments), Object.prototype, "no prototype pollution");
		const [message] = inputAppends(record, { type: "text", text: "", attachmentIds: ["constructor", "__proto__"] });
		assert.deepEqual((message as LhMessage).sessionAttachments!.map((a) => a.id), ["constructor", "__proto__"]);
	});

	it("refuses an overlapping preparation for the same chat instead of transcribing twice", async () => {
		const chat = newChat();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const slow = async () => { await gate; return PNG_1PX; };
		const first = scripted(["Page one"]);
		const second = scripted(["Page one"]);
		const req = () => upload(chat.id, [{ name: "paper.pdf", bytes: pdf() }], ["same_pdf"]);
		const a = prepareSessionAttachments(chat.id, req(), { engineFor: () => first.engine, renderPage: slow });
		await new Promise((r) => setTimeout(r, 20));
		const b = await prepareSessionAttachments(chat.id, req(), { engineFor: () => second.engine, renderPage });
		assert.equal(b.status, 409);
		release();
		assert.equal((await a).status, 200);
		assert.equal(first.contexts.length + second.contexts.length, 1, "one transcription");
		const retry = await prepareSessionAttachments(chat.id, req(), { engineFor: () => assert.fail("a sequential retry reuses the saved PDF") });
		assert.equal(retry.status, 200);
		assert.equal(chatStore.getChat(chat.id)!.attachmentUsage!.length, 1);
		// The lock is per chat and released after failures too.
		const other = newChat();
		assert.equal((await prepareSessionAttachments(other.id, upload(other.id, [{ name: "x.exe", bytes: "MZ" }]))).status, 415);
		assert.equal((await prepareSessionAttachments(other.id, upload(other.id, [{ name: "x.txt", bytes: "ok" }]))).status, 200);
	});

	it("saves a transcription and its usage together, and surfaces a failed save", async () => {
		const chat = newChat();
		const failingSave = mock.method(chatStore as Required<typeof chatStore>, "saveSessionAttachment", () => { throw new Error("disk full"); });
		try {
			const res = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "paper.pdf", bytes: pdf() }], ["pdf_a"]), { engineFor: () => scripted(["Page one"]).engine, renderPage });
			assert.equal(res.status, 500);
			assert.match((await res.json() as { error: string }).error, /Could not save paper\.pdf/);
		} finally { failingSave.mock.restore(); }
		let record = chatStore.getChat(chat.id)!;
		assert.ok(!ownSessionAttachment(record, "pdf_a") && !record.attachmentUsage?.length, "neither contents nor usage half-landed");

		const ok = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "paper.pdf", bytes: pdf() }], ["pdf_a"]), { engineFor: () => scripted(["Page one"]).engine, renderPage });
		assert.equal(ok.status, 200);
		record = chatStore.getChat(chat.id)!;
		assert.ok(ownSessionAttachment(record, "pdf_a"));
		assert.deepEqual(record.attachmentUsage!.map((u) => u.attachmentId), ["pdf_a"]);
	});

	it("surfaces a billed failure whose usage could not be recorded", async () => {
		const chat = newChat();
		const failingAppend = mock.method(chatStore as Required<typeof chatStore>, "appendAttachmentUsage", () => { throw new Error("disk full"); });
		try {
			const twoPages = tinyPdf([{}, {}]);
			const res = await prepareSessionAttachments(chat.id, upload(chat.id, [{ name: "broken.pdf", bytes: twoPages }], ["pdf_b"]), { engineFor: () => scripted(["Only one"]).engine, renderPage });
			assert.equal(res.status, 500);
			assert.match((await res.json() as { error: string }).error, /usage could not be saved/);
		} finally { failingAppend.mock.restore(); }
	});

	it("checks attachment references before model configuration gates", async () => {
		const chat = chatStore.createChat("No model configured");
		const res = await handleChatRequest(new Request("http://test/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "", attachmentIds: ["missing"] } }),
		}));
		assert.equal(res.status, 400, "an unknown reference costs nothing, not even a 503 gate");
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 0);
	});
});
