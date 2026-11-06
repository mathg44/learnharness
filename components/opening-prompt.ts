/**
 * Same-tab handover of a new session's full opening text. Never put the
 * message in the navigation URL: long query payloads can be rejected before
 * the chat page loads. Storage is required for automatic delivery, not an
 * optional best-effort side effect of navigating away from the source draft.
 */
import type { SessionAttachmentInfo } from "@/src/core";

export const OPENING_PROMPT_FAILURE = "Couldn’t open the session. Your message is still here. Try sending again.";

export interface OpeningPrompt {
	text: string;
	/** Written BEFORE sending. A later mount restores a draft, never reposts. */
	attempted: boolean;
	/** Prepared server-owned attachments. Never store file bytes in browser storage. */
	attachments?: SessionAttachmentInfo[];
}

const keyFor = (id: string) => `lh.openingPrompt.${id}`;

function isAttachmentInfo(value: unknown): value is SessionAttachmentInfo {
	if (!value || typeof value !== "object") return false;
	const info = value as Record<string, unknown>;
	return typeof info.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(info.id) &&
		typeof info.name === "string" && typeof info.mimeType === "string" &&
		(info.kind === "text" || info.kind === "pdf" || info.kind === "image") &&
		typeof info.size === "number" && Number.isSafeInteger(info.size) && info.size >= 0;
}

export function stashOpeningPrompt(id: string, text: string, attempted = false, attachments?: readonly SessionAttachmentInfo[]): boolean {
	try {
		const value = JSON.stringify({ text, attempted, ...(attachments?.length ? { attachments: [...attachments] } : {}) } satisfies OpeningPrompt);
		// Catch both the storage getter and its methods (quota/security errors).
		const storage = globalThis.sessionStorage;
		storage.setItem(keyFor(id), value);
		return storage.getItem(keyFor(id)) === value;
	} catch {
		return false;
	}
}

export function readOpeningPromptEntry(id: string): OpeningPrompt | undefined {
	try {
		const value = globalThis.sessionStorage.getItem(keyFor(id));
		if (!value) return undefined;
		try {
			const entry: unknown = JSON.parse(value);
			if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" &&
				"attempted" in entry && typeof entry.attempted === "boolean") {
				const attachments = "attachments" in entry && Array.isArray(entry.attachments)
					? entry.attachments.filter(isAttachmentInfo) : [];
				if (entry.text.length > 0 || attachments.length > 0) {
					return { text: entry.text, attempted: entry.attempted, ...(attachments.length ? { attachments } : {}) };
				}
			}
		} catch { /* Old raw-text stashes have no proof that sending never began. */ }
		return { text: value, attempted: true };
	} catch {
		return undefined;
	}
}

export function readOpeningPrompt(id: string): string | undefined {
	return readOpeningPromptEntry(id)?.text;
}

export function clearOpeningPrompt(id: string): boolean {
	try {
		globalThis.sessionStorage.removeItem(keyFor(id));
		return true;
	} catch {
		// Canonical conversation/acknowledgment remains the truth. A later
		// mount with real conversation can try cleanup again; never crash it.
		return false;
	}
}
