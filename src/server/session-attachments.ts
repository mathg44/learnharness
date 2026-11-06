/**
 * Browser session attachments, server side: POST /api/chats/[id]/attachments
 * prepares uploaded files for a later send, GET .../attachments/[attachmentId]
 * serves a prepared image.
 *
 * Preparation, serially per file, each success saved on its own so a retry
 * with the same client ids reuses it instead of converting again:
 *   text  - read as strict UTF-8, stored verbatim
 *   pdf   - every page transcribed by the SESSION's conversation model
 *           (transcribePdf), usage logged in ChatRecord.attachmentUsage
 *           whether the attempt succeeds or fails
 *   image - normalized by the learner-image worker (bounded, upright,
 *           metadata-free)
 * Original bytes are never stored. Nothing here touches the filesystem
 * beyond the chat record, uses graph imports, or runs agent tools.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { transcribePdf } from "../agent/subagents/pdf-transcription.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/index.ts";
import { normalizeLearnerImageBytes } from "../agent/tools/learner-image.ts";
import type { AttachmentUsage, CallUsage, ChatRecord } from "../core/contracts.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import {
	isValidAttachmentId,
	MAX_SESSION_ATTACHMENT_BODY_BYTES,
	MAX_SESSION_ATTACHMENT_BYTES,
	MAX_SESSION_ATTACHMENT_NAME,
	MAX_SESSION_ATTACHMENTS,
	ownSessionAttachment,
	sessionAttachmentInfo,
	type PreparedSessionAttachment,
	type SessionAttachmentKind,
} from "../core/session-attachments.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings, stores } from "./stores.ts";

/** Test seams: a scripted engine and page renderer, never real providers. */
export interface AttachmentPreparationDeps {
	engineFor?: (record: ChatRecord) => PiEngine;
	renderPage?: (page: PDFPageProxy, dpi: number) => Promise<Buffer>;
}

const NO_IMAGE_INPUT = "This session's model can't read images. Choose a model with image input to attach PDFs or pictures.";
const UNSUPPORTED = "Unsupported file. Attach PDFs, images, or text files.";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PDF_EXTENSION = /\.pdf$/i;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)$/i;
const TEXT_EXTENSION = /\.(?:txt|text|md|markdown|mdx|rst|org|adoc|tex|bib|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|xml|html?|css|log|py|ipynb|r|jl|m|js|mjs|cjs|jsx|ts|tsx|java|kt|scala|c|h|cc|cpp|hpp|cs|go|rs|rb|php|swift|lua|pl|sh|bash|zsh|sql|hs|ml|ex|exs|clj|el|vim|dart|vue|svelte)$/i;
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|toml|x-tex|x-sh|javascript|typescript|x-ipynb\+json|ld\+json))/i;

class UploadError extends Error {
	constructor(readonly status: number, message: string, readonly envelope?: object) { super(message); }
}

function failure(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

/** Bound actual body bytes before multipart parsing, whatever Content-Length says. */
async function readBoundedForm(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > MAX_SESSION_ATTACHMENT_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new UploadError(413, "Too big. Max 25 MB per message.");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new UploadError(400, "Missing upload body.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_SESSION_ATTACHMENT_BODY_BYTES) throw new UploadError(413, "Too big. Max 25 MB per message.");
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
	try {
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} catch {
		throw new UploadError(400, "Could not read the upload. It may be incomplete; please attach the files again.");
	}
}

interface Classified { kind: SessionAttachmentKind; bytes: Uint8Array; text?: string }

/** Kind by content, never by name alone. A file named or typed as a PDF or
 *  image must actually be one; text needs a text name or type AND strict
 *  UTF-8 without NUL bytes, so binaries are never decoded as text. */
function classify(file: File, bytes: Uint8Array): Classified {
	if (PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return { kind: "pdf", bytes };
	if (detectSupportedImageMimeType(bytes)) return { kind: "image", bytes };
	const type = file.type.toLowerCase();
	if (type === "application/pdf" || PDF_EXTENSION.test(file.name)) {
		throw new UploadError(415, `${file.name} is not a readable PDF.`);
	}
	if (type.startsWith("image/") || IMAGE_EXTENSION.test(file.name)) {
		throw new UploadError(415, `${file.name} is not a supported image (jpg, png, gif, webp, or bmp).`);
	}
	if (!TEXT_EXTENSION.test(file.name) && !TEXT_MIME.test(type)) throw new UploadError(415, UNSUPPORTED);
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
	catch { throw new UploadError(415, `${file.name} is not UTF-8 text.`); }
	if (text.includes("\0")) throw new UploadError(415, `${file.name} is not a text file.`);
	return { kind: "text", bytes, text };
}

/** The session's conversation engine, resolved exactly as a turn resolves
 *  it (chat override over the strong slot). Config refusals reuse the
 *  turn's 503 envelopes. */
async function conversationEngine(record: ChatRecord): Promise<PiEngine> {
	const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
	if (!spec) {
		const envelope = modelsNotConfigured(["strong"]);
		throw new UploadError(503, envelope.error, envelope);
	}
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) {
		const envelope = providerKeyMissing(spec.provider, ["strong"]);
		throw new UploadError(503, envelope.error, envelope);
	}
	try {
		// Foreground: the learner is waiting on this upload.
		return piEngineForSpec(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
	} catch {
		throw new UploadError(503, spec.provider === "chatgpt" ? chatGPTStreamError("model catalog")
			: isSubscriptionProvider(spec.provider) ? nativeSubscriptionError(spec.provider, "model catalog")
			: "The selected model is unavailable.");
	}
}

function callUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}

/** One preparation per chat at a time, process-wide. Lives on globalThis
 *  (the turn-liveness lesson: Next may load this module more than once).
 *  Two overlapping uploads for the same chat would both transcribe a PDF
 *  before either saved it; the second gets a 409 instead and its retry
 *  reuses what the first saved. */
interface LhAttachmentGlobal { __lhAttachmentPreparations?: Set<string> }
function preparations(): Set<string> {
	const g = globalThis as typeof globalThis & LhAttachmentGlobal;
	return (g.__lhAttachmentPreparations ??= new Set<string>());
}

function sameModel(a: ChatRecord["settings"], b: ChatRecord["settings"]): boolean {
	return a?.model?.provider === b?.model?.provider && a?.model?.id === b?.model?.id;
}

/** POST /api/chats/[id]/attachments: multipart `files` with a matching
 *  `ids` entry per file. Success: { attachments: SessionAttachmentInfo[] }
 *  in request order. Errors: { error } (plus the config envelope fields
 *  on a 503 model/key refusal). 409 while another preparation for the same
 *  chat is running. */
export async function prepareSessionAttachments(chatId: string, request: Request, deps: AttachmentPreparationDeps = {}): Promise<Response> {
	const store = stores.chatStore;
	// Known session first: no body read, no conversion for an unknown id.
	let known: ChatRecord | null;
	try { known = store.getChat(chatId); } catch { known = null; }
	if (!known) {
		void request.body?.cancel().catch(() => undefined);
		return failure(404, "Unknown chat");
	}
	const saveAttachment = store.saveSessionAttachment?.bind(store);
	const appendUsage = store.appendAttachmentUsage?.bind(store);
	if (!saveAttachment || !appendUsage) return failure(500, "Attachments are not available.");
	const running = preparations();
	if (running.has(chatId)) {
		void request.body?.cancel().catch(() => undefined);
		return failure(409, "Attachments are already being prepared for this session. Try again when they finish.");
	}
	running.add(chatId);
	try {
		const form = await readBoundedForm(request);
		const files = form.getAll("files");
		const ids = form.getAll("ids");
		if (files.length === 0) throw new UploadError(400, "No files attached.");
		if (files.length > MAX_SESSION_ATTACHMENTS) throw new UploadError(400, `Attach at most ${MAX_SESSION_ATTACHMENTS} files.`);
		if (ids.length !== files.length || !files.every((f): f is File => f instanceof File) || !ids.every(isValidAttachmentId)) {
			throw new UploadError(400, "Each file needs one valid attachment id.");
		}
		const idList = ids as string[];
		const fileList = files as File[];
		if (new Set(idList).size !== idList.length) throw new UploadError(400, "Attachment ids must be unique.");
		if (fileList.some((f) => f.name.length === 0 || f.name.length > MAX_SESSION_ATTACHMENT_NAME)) {
			throw new UploadError(400, `File names must be 1 to ${MAX_SESSION_ATTACHMENT_NAME} characters.`);
		}
		if (fileList.reduce((total, f) => total + f.size, 0) > MAX_SESSION_ATTACHMENT_BYTES) {
			throw new UploadError(413, "Too big. Max 25 MB per message.");
		}

		// Validate every new file before any conversion or model call.
		let record = store.getChat(chatId);
		if (!record) throw new UploadError(404, "Unknown chat");
		const pending: { id: string; file: File; classified?: Classified }[] = [];
		for (const [i, file] of fileList.entries()) {
			const id = idList[i]!;
			if (ownSessionAttachment(record, id)) { pending.push({ id, file }); continue; }
			pending.push({ id, file, classified: classify(file, new Uint8Array(await file.arrayBuffer())) });
		}
		const needsModel = pending.some((p) => p.classified && p.classified.kind !== "text");
		let engine: PiEngine | undefined;
		if (needsModel) {
			engine = deps.engineFor ? deps.engineFor(record) : await conversationEngine(record);
			// The catalog refresh awaited: re-read, so a model switched in the
			// meantime is never checked (or billed) as the old one.
			const fresh = store.getChat(chatId);
			if (!fresh) throw new UploadError(404, "Unknown chat");
			if (!sameModel(fresh.settings, record.settings)) {
				throw new UploadError(409, "The session's model changed while preparing. Attach the files again.");
			}
			record = fresh;
			if (!engine.model.input.includes("image")) throw new UploadError(400, NO_IMAGE_INPUT);
		}

		const prepared: PreparedSessionAttachment[] = [];
		for (const { id, file, classified } of pending) {
			record = store.getChat(chatId);
			if (!record) throw new UploadError(404, "Unknown chat");
			const existing = ownSessionAttachment(record, id);
			if (existing) { prepared.push(existing); continue; }
			prepared.push(await prepareOne(chatId, id, file, classified!, engine, request.signal, deps, saveAttachment, appendUsage));
		}
		return Response.json({ attachments: prepared.map(sessionAttachmentInfo) });
	} catch (err) {
		if (err instanceof UploadError) return Response.json(err.envelope ?? { error: err.message }, { status: err.status });
		if (request.signal.aborted) return failure(499, "Upload cancelled.");
		if (err instanceof Error && /^Chat not found/.test(err.message)) return failure(404, "Unknown chat");
		console.error(`[chat ${chatId}] attachment preparation failed:`, err);
		return failure(500, "Could not prepare the attachments.");
	} finally {
		running.delete(chatId);
	}
}

type SaveAttachment = NonNullable<typeof stores.chatStore.saveSessionAttachment>;
type AppendUsage = NonNullable<typeof stores.chatStore.appendAttachmentUsage>;

/** Prepare and save one file. A billed PDF saves its contents and usage in
 *  ONE write, so the record never holds a transcription whose spend is
 *  missing; a failed save is surfaced, never reported as prepared. */
async function prepareOne(
	chatId: string,
	id: string,
	file: File,
	classified: Classified,
	engine: PiEngine | undefined,
	signal: AbortSignal,
	deps: AttachmentPreparationDeps,
	save: SaveAttachment,
	appendUsage: AppendUsage,
): Promise<PreparedSessionAttachment> {
	const base = { id, name: file.name, size: file.size };
	const persist = (attachment: PreparedSessionAttachment, usage?: AttachmentUsage): PreparedSessionAttachment => {
		try { save(chatId, attachment, usage); }
		catch (err) {
			if (err instanceof Error && /^Chat not found/.test(err.message)) throw err;
			console.error(`[chat ${chatId}] attachment save failed:`, err);
			throw new UploadError(500, `Could not save ${file.name}. Try again.`);
		}
		return ownSessionAttachment(stores.chatStore.getChat(chatId), id) ?? attachment;
	};
	if (classified.kind === "text") {
		return persist({ ...base, kind: "text", mimeType: "text/plain", text: classified.text!.replace(/^\uFEFF/, "") });
	}
	if (classified.kind === "image") {
		let image;
		try { image = await normalizeLearnerImageBytes(classified.bytes, signal); }
		catch (err) {
			if (signal.aborted) throw err;
			throw new UploadError(422, `Could not prepare ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const { snapshotId: _snapshotId, ...snapshot } = image;
		return persist({ ...base, kind: "image", mimeType: snapshot.mimeType, image: snapshot });
	}
	const steps: CallUsage[] = [];
	const model = `${engine!.model.provider}:${engine!.model.id}`;
	const usageEntry = (): AttachmentUsage | undefined => steps.length > 0
		? { id: crypto.randomUUID(), attachmentId: id, at: new Date().toISOString(), model, steps }
		: undefined;
	let text: string;
	try {
		text = await transcribePdf(classified.bytes, {
			engine: engine!,
			abortSignal: signal,
			onUsage: (usage) => steps.push(callUsage(usage)),
			...(deps.renderPage ? { renderPage: deps.renderPage } : {}),
		});
	} catch (err) {
		// A failed attempt can still have billed pages: record them on their own.
		const usage = usageEntry();
		let usageSaved = true;
		if (usage) {
			try { appendUsage(chatId, usage); }
			catch (appendErr) { usageSaved = false; console.error(`[chat ${chatId}] attachment usage append failed:`, appendErr); }
		}
		if (!usageSaved) throw new UploadError(500, `Could not prepare ${file.name}, and its model usage could not be saved.`);
		if (signal.aborted) throw err;
		throw new UploadError(422, `Could not prepare ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return persist({ ...base, kind: "pdf", mimeType: "application/pdf", text }, usageEntry());
}

/** GET /api/chats/[id]/attachments/[attachmentId]: the normalized image of
 *  a prepared image attachment. Never serves text or PDF contents. */
export function sessionAttachmentImageResponse(chatId: string, attachmentId: string): Response {
	const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
	if (!isValidAttachmentId(attachmentId)) return notFound();
	let record: ChatRecord | null;
	try { record = stores.chatStore.getChat(chatId); } catch { return notFound(); }
	const image = ownSessionAttachment(record, attachmentId)?.image;
	if (!image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")) return notFound();
	return new Response(Buffer.from(image.data, "base64"), {
		headers: {
			"Content-Type": image.mimeType,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
			"Content-Disposition": "inline",
		},
	});
}

export const SEND_IMAGE_INPUT_ERROR = "This session's model can't read images. Choose a model with image input, or remove the pictures.";
