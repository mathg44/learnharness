/**
 * Browser session attachments: files the learner attaches to one composer
 * message. Upload prepares each file once (text read as-is, PDFs
 * transcribed by the session's model, images normalized) and stores the
 * processed result in ChatRecord.attachments. Send references prepared
 * attachments by their client-minted ids; the user message then carries the
 * processed contents natively, so the model reads them like any user text.
 *
 * Original PDFs and image bytes are never stored. Pure and browser-safe.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ImageSnapshot } from "./contracts/chat.ts";

export type SessionAttachmentKind = "text" | "pdf" | "image";

/** What the browser sees: enough to render a chip or a thumbnail. */
export interface SessionAttachmentInfo {
	/** Client-minted, stable across retries: [A-Za-z0-9_-]{1,64}. */
	id: string;
	name: string;
	kind: SessionAttachmentKind;
	/** The stored type: text/plain for text, application/pdf for PDFs, and
	 *  the normalized image/png or image/jpeg for images. */
	mimeType: string;
	/** Original upload size in bytes. */
	size: number;
}

/** A prepared attachment as stored in the session record. `text` carries a
 *  text file's contents or a PDF's transcription; `image` an image's
 *  normalized snapshot. */
export interface PreparedSessionAttachment extends SessionAttachmentInfo {
	text?: string;
	image?: ImageSnapshot;
}

/** Original bytes allowed per upload request and per sent message. */
export const MAX_SESSION_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Upload body allowance: file bytes plus multipart overhead. */
export const MAX_SESSION_ATTACHMENT_BODY_BYTES = 26 * 1024 * 1024;
/** Server safety bound on files per upload request and ids per send. */
export const MAX_SESSION_ATTACHMENTS = 100;
export const MAX_SESSION_ATTACHMENT_NAME = 255;

export function isValidAttachmentId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** The record's prepared attachment for an id: own keys only, so ids like
 *  "constructor" or "__proto__" never resolve to inherited properties. */
export function ownSessionAttachment(
	record: { attachments?: Record<string, PreparedSessionAttachment> } | null | undefined,
	id: string,
): PreparedSessionAttachment | undefined {
	const map = record?.attachments;
	return map && Object.hasOwn(map, id) ? map[id] : undefined;
}

/** Does a send referencing these ids carry pictures (needs image input)?
 *  PDFs are text by then and need none. */
export function sendNeedsImageInput(
	record: { attachments?: Record<string, PreparedSessionAttachment> },
	ids: readonly string[] | undefined,
): boolean {
	return (ids ?? []).some((id) => ownSessionAttachment(record, id)?.kind === "image");
}

/** The browser-facing part of a prepared attachment (never its contents). */
export function sessionAttachmentInfo(attachment: PreparedSessionAttachment): SessionAttachmentInfo {
	const { id, name, kind, mimeType, size } = attachment;
	return { id, name, kind, mimeType, size };
}

/** The one-line label each attachment gets in the model-facing content. */
export function sessionAttachmentLabel(info: Pick<SessionAttachmentInfo, "kind" | "name">): string {
	switch (info.kind) {
		case "pdf": return `[Attached PDF: ${info.name}, transcribed page by page]`;
		case "image": return `[Attached image: ${info.name}]`;
		default: return `[Attached file: ${info.name}]`;
	}
}

/** Native user content for a message with attachments: the learner's own
 *  text first (when non-empty), then each attachment in the sent order. */
export function sessionAttachmentContent(
	userText: string,
	attachments: readonly PreparedSessionAttachment[],
): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	if (userText.trim()) content.push({ type: "text", text: userText });
	for (const attachment of attachments) {
		const label = sessionAttachmentLabel(attachment);
		if (attachment.kind === "image") {
			content.push({ type: "text", text: label });
			if (attachment.image) content.push({ type: "image", data: attachment.image.data, mimeType: attachment.image.mimeType });
		} else {
			content.push({ type: "text", text: `${label}\n\n${attachment.text ?? ""}` });
		}
	}
	return content;
}
