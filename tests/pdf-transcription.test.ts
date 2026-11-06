import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { backgroundCaptureDir } from "../src/agent/background-capture.ts";
import type { PiEngine } from "../src/agent/models.ts";
import {
	BLANK_PAGE_MARKER,
	transcribePdf,
} from "../src/agent/subagents/pdf-transcription.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");

function engineFor(responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = createFauxCore({
		models: [{ id: "vision", input: ["text", "image"] }],
		tokenSize: { min: 64, max: 64 },
	});
	faux.setResponses(responses);
	const contexts: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			contexts.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, contexts };
}

function images(context: TranscriptContext) {
	return context.messages.flatMap((message) => Array.isArray(message.content)
		? message.content.filter((part) => part.type === "image")
		: []);
}

function pageRenderer(seen: number[]) {
	return async (page: { pageNumber: number }) => {
		seen.push(page.pageNumber);
		return PNG_1PX;
	};
}

const threePages = () => tinyPdf([
	{ runs: [{ text: "Typed notes", x: 72, y: 700 }] },
	{},
	{ image: true },
]);

describe("PDF transcription", () => {
	it("renders and transcribes every typed, blank, and image page in order", async () => {
		const { engine, contexts } = engineFor([
			fauxAssistantMessage([fauxText("Typed notes")]),
			fauxAssistantMessage([fauxText(BLANK_PAGE_MARKER)]),
			fauxAssistantMessage([fauxText("Figure label")]),
		]);
		const data = threePages();
		const original = data.slice();
		const pages: number[] = [];
		const out = await transcribePdf(data, { engine, onPage: (page) => pages.push(page) });

		assert.deepEqual(data, original, "pdfjs must not detach the caller's bytes");
		assert.deepEqual(pages, [1, 2, 3]);
		assert.equal(contexts.length, 3);
		for (const [index, context] of contexts.entries()) {
			assert.equal(images(context).length, 1, `page ${index + 1} image reaches the model`);
			assert.match(JSON.stringify(context), new RegExp(`Page ${index + 1}\\. Transcribe this page\\.`));
		}
		assert.match(JSON.stringify(contexts[0]), /If you cannot read a word or symbol with confidence/);
		assert.equal(out, "--- Page 1 ---\n\nTyped notes\n\n--- Page 2 ---\n\n[blank page]\n\n--- Page 3 ---\n\nFigure label");
	});

	for (const [name, reply, pattern] of [
		["empty", fauxAssistantMessage([fauxText("   ")]), /returned no text/],
		["truncated", fauxAssistantMessage([fauxText("partial")], { stopReason: "length" }), /cut off/],
		["tool call", fauxAssistantMessage([fauxToolCall("read", {}, { id: "no-tools" })], { stopReason: "toolUse" }), /tried to call a tool/],
		["provider failure", fauxAssistantMessage([fauxText("partial")], { stopReason: "error", errorMessage: "provider down" }), /provider down/],
	] as const) {
		it(`fails ${name} replies without starting a later page and retains usage`, async () => {
			const { engine } = engineFor([reply]);
			const rendered: number[] = [];
			const usage: Usage[] = [];
			await assert.rejects(
				transcribePdf(threePages(), { engine, renderPage: pageRenderer(rendered), onUsage: (item) => usage.push(item) }),
				pattern,
			);
			assert.deepEqual(rendered, [1]);
			assert.equal(usage.length, 1);
		});
	}

	it("writes one capture with both page requests", async () => {
		const { engine } = engineFor([
			fauxAssistantMessage([fauxText("first")]),
			fauxAssistantMessage([fauxText("second")]),
		]);
		const directory = mkdtempSync(path.join(tmpdir(), "lh-pdf-capture-"));
		const previousDirectory = backgroundCaptureDir.current;
		const previousSetting = process.env.LH_BACKGROUND_CAPTURE;
		backgroundCaptureDir.current = directory;
		process.env.LH_BACKGROUND_CAPTURE = "pdfReader";
		try {
			await transcribePdf(tinyPdf([{}, {}]), { engine, renderPage: pageRenderer([]) });
			const files = readdirSync(directory);
			assert.equal(files.length, 1);
			const capture = JSON.parse(readFileSync(path.join(directory, files[0]!), "utf8")) as { timings: unknown[] };
			assert.equal(capture.timings.length, 2);
		} finally {
			backgroundCaptureDir.current = previousDirectory;
			if (previousSetting === undefined) delete process.env.LH_BACKGROUND_CAPTURE;
			else process.env.LH_BACKGROUND_CAPTURE = previousSetting;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("records a completed reply then honors cancellation before accepting it", async () => {
		const { engine } = engineFor([fauxAssistantMessage([fauxText("first")])]);
		const controller = new AbortController();
		const rendered: number[] = [];
		let usages = 0;
		await assert.rejects(
			transcribePdf(threePages(), {
				engine,
				abortSignal: controller.signal,
				renderPage: pageRenderer(rendered),
				onUsage: () => { usages++; controller.abort(); },
			}),
			(err: Error) => err.name === "AbortError",
		);
		assert.equal(usages, 1);
		assert.deepEqual(rendered, [1]);
	});

	it("honors cancellation that races PDF teardown after the final reply", async () => {
		const { engine } = engineFor([fauxAssistantMessage([fauxText("only page")])]);
		const controller = new AbortController();
		let wrappedDestroy = false;
		await assert.rejects(
			transcribePdf(tinyPdf([{ runs: [{ text: "Only page", x: 72, y: 700 }] }]), {
				engine,
				abortSignal: controller.signal,
				renderPage: async (page) => {
					const transport = (page as unknown as { _transport: { destroy: () => Promise<void> } })._transport;
					const destroy = transport.destroy.bind(transport);
					transport.destroy = async () => {
						wrappedDestroy = true;
						controller.abort();
						return destroy();
					};
					return PNG_1PX;
				},
			}),
			(err: Error) => err.name === "AbortError",
		);
		assert.equal(wrappedDestroy, true);
	});

	it("rejects PDFs over 1,000 pages before rendering or dispatch", async () => {
		const { engine, contexts } = engineFor([fauxAssistantMessage([fauxText("never used")])]);
		const rendered: number[] = [];
		await assert.rejects(
			transcribePdf(tinyPdf(Array.from({ length: 1001 }, () => ({}))), {
				engine,
				renderPage: pageRenderer(rendered),
			}),
			/Too long\. Max 1,000 pages/,
		);
		assert.deepEqual(rendered, []);
		assert.deepEqual(contexts, []);
	});

	it("rejects a text-only engine before rendering", async () => {
		const { engine } = engineFor([fauxAssistantMessage([fauxText("never used")])]);
		engine.model = { ...engine.model, input: ["text"] };
		const rendered: number[] = [];
		await assert.rejects(
			transcribePdf(threePages(), { engine, renderPage: pageRenderer(rendered) }),
			/Choose a Vision model/,
		);
		assert.deepEqual(rendered, []);
	});

	it("reports an unreadable PDF without dispatching a page", async () => {
		const { engine, contexts } = engineFor([fauxAssistantMessage([fauxText("never used")])]);
		await assert.rejects(transcribePdf(Uint8Array.of(1, 2, 3), { engine }), /Could not open this PDF/);
		assert.deepEqual(contexts, []);
	});
});
