import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import { usageWasAdmitted } from "../subscription-request-cycle.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { renderPdfPage } from "./headless.ts";
import { standardFontsDir } from "./pdf-ops.ts";

/**
 * Whole-PDF transcription: every page is rendered and sent alone to the
 * configured engine, which writes that page back as Markdown. One model call
 * per page, no tools, no filesystem access (the caller passes the bytes).
 *
 * Memory: one page at a time. Rendering, image processing and the model call
 * all run inside one shared background-LLM permit, so at most three
 * transcription page canvases exist process-wide however many transcriptions run.
 *
 * This is not the pdf-reader agent. That one answers questions with a
 * summarized brief; this one copies the page.
 */

export const MAX_TRANSCRIPTION_PAGES = 1000;
export const UNREADABLE_PDF_MESSAGE = "Could not open this PDF.";
export const TOO_LONG_PDF_MESSAGE = "Too long. Max 1,000 pages.";
export const BLANK_PAGE_MARKER = "[blank page]";

const RENDER_DPI = 150;

export const TRANSCRIPTION_INSTRUCTIONS = `You transcribe one page of a PDF into Markdown. The page arrives as an image.

Write down everything on the page, in reading order, exactly as it appears:
- Typed and printed text, word for word.
- Handwriting, word for word.
- Equations in LaTeX: $...$ inline, $$...$$ for display equations.
- Tables as Markdown tables.
- Diagrams and figures: transcribe their labels, axis titles, legends and captions. Do not describe the drawing itself.
- Headings as Markdown headings, lists as Markdown lists.

Rules:
- Transcribe. Do not summarize, explain, translate, correct or complete anything.
- Never add text that is not on the page.
- If you cannot read a word or symbol with confidence, write [unclear] in its place.
- If the page has no visible text or content, reply with exactly ${BLANK_PAGE_MARKER}
- Reply with the Markdown only. No preamble, no closing remarks, no code fences around the whole page.`;

export interface TranscribePdfOptions {
	engine: PiEngine;
	abortSignal?: AbortSignal;
	/** One call per admitted model reply, including failed and truncated ones. */
	onUsage?: (usage: Usage) => void;
	/** Fires before each page starts (1-based page, total page count). */
	onPage?: (page: number, total: number) => void;
	/** Test seam: replaces the native page renderer. */
	renderPage?: (page: PDFPageProxy, dpi: number) => Promise<Buffer>;
}

/** Transcribe every page of a PDF into page-marked Markdown
 *  ("--- Page N ---" before each page's text). Throws on the first failure. */
export async function transcribePdf(data: Uint8Array, opts: TranscribePdfOptions): Promise<string> {
	opts.abortSignal?.throwIfAborted();
	if (!opts.engine.model.input.includes("image")) {
		throw new Error("Choose a Vision model to transcribe PDFs.");
	}
	const capture = createBackgroundCapture({ role: "pdfReader", runId: randomUUID() });
	let failure: unknown;
	try {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		let task: PDFDocumentLoadingTask | undefined;
		let result = "";
		try {
			let doc;
			try {
				// pdfjs transfers the buffer it is given; copy so the caller's array stays usable.
				task = pdfjs.getDocument({ data: data.slice(), standardFontDataUrl: standardFontsDir(), verbosity: 0 });
				doc = await task.promise;
			} catch {
				opts.abortSignal?.throwIfAborted();
				throw new Error(UNREADABLE_PDF_MESSAGE);
			}
			const total = doc.numPages;
			if (total > MAX_TRANSCRIPTION_PAGES) throw new Error(TOO_LONG_PDF_MESSAGE);
			const sections: string[] = [];
			for (let pageNo = 1; pageNo <= total; pageNo++) {
				opts.abortSignal?.throwIfAborted();
				opts.onPage?.(pageNo, total);
				let markdown: string;
				try {
					markdown = await withBgLlmSlot(opts.abortSignal, async () => {
						// A queued caller can inherit a permit just as its signal aborts.
						// Do not open, render, or send that page in this race.
						opts.abortSignal?.throwIfAborted();
						const page = await doc.getPage(pageNo);
						try {
							opts.abortSignal?.throwIfAborted();
							return await transcribePage(page, pageNo, opts, capture);
						} finally {
							page.cleanup();
						}
					});
				} catch (err) {
					if (isAbort(err, opts.abortSignal)) throw err;
					const reason = err instanceof Error ? err.message : String(err);
					throw new Error(`Could not transcribe page ${pageNo} of ${total}: ${reason}`, { cause: err });
				}
				sections.push(`--- Page ${pageNo} ---\n\n${markdown}`);
			}
			result = sections.join("\n\n");
		} finally {
			await task?.destroy().catch(() => {});
		}
		// A caller can cancel while pdfjs releases the document. Do not hand its
		// otherwise complete transcription to graph extraction in that race.
		opts.abortSignal?.throwIfAborted();
		return result;
	} catch (err) {
		failure = err;
		throw err;
	} finally {
		capture?.finish(failure);
	}
}

async function transcribePage(page: PDFPageProxy, pageNo: number, opts: TranscribePdfOptions, capture: ReturnType<typeof createBackgroundCapture>): Promise<string> {
	const { engine, abortSignal } = opts;
	const png = await (opts.renderPage ?? renderPdfPage)(page, RENDER_DPI);
	abortSignal?.throwIfAborted();
	const image = await processImage(png, "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
	abortSignal?.throwIfAborted();
	if (!image.ok) throw new Error(image.message);

	const messages: Message[] = [{
		role: "user",
		content: [
			{ type: "text", text: [`Page ${pageNo}. Transcribe this page.`, ...image.hints].join("\n") },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
		timestamp: Date.now(),
	}];
	const sessionId = randomUUID();
	const reply = await streamPage(engine, messages, sessionId, opts, capture);
	const markdown = pageText(reply);
	// Do not accept the final page when cancellation raced its completed reply.
	abortSignal?.throwIfAborted();
	return markdown;
}

/** One raw model call. Usage reaches onUsage for every admitted reply,
 *  whether it ends in success, truncation, tool calls or a provider error. */
async function streamPage(
	engine: PiEngine,
	messages: Message[],
	sessionId: string,
	opts: TranscribePdfOptions,
	capture: ReturnType<typeof createBackgroundCapture>,
): Promise<AssistantMessage> {
	const streamFn = backgroundCaptureStream(engine.streamFn, capture);
	const reasoning = engine.level && engine.level !== "off" ? engine.level : undefined;
	const stream = streamFn(engine.model, normalizeContext({ systemPrompt: TRANSCRIPTION_INSTRUCTIONS, messages, tools: [] }), {
		sessionId,
		reasoning,
		signal: opts.abortSignal,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") {
			capture?.reply(event.message);
			if (usageWasAdmitted(event.message.usage)) opts.onUsage?.(event.message.usage);
			return event.message;
		}
		if (event.type === "error") {
			capture?.reply(event.error);
			// Providers can return billable partial usage with an error or abort.
			// Record it before translating the abort into the caller's signal error.
			if (usageWasAdmitted(event.error.usage)) opts.onUsage?.(event.error.usage);
			if (event.reason === "aborted") throw abortError();
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	opts.abortSignal?.throwIfAborted();
	throw new Error("the model stream ended without a result");
}

function pageText(reply: AssistantMessage): string {
	if (reply.stopReason === "length") throw new Error("the model's reply was cut off");
	if (reply.content.some((c) => c.type === "toolCall") || reply.stopReason === "toolUse") {
		throw new Error("the model tried to call a tool");
	}
	if (reply.stopReason !== "stop") throw new Error(`the model stopped unexpectedly (${reply.stopReason})`);
	const text = reply.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!text) throw new Error("the model returned no text");
	return text;
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}
