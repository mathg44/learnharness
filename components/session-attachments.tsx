"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileTextIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { MAX_SESSION_ATTACHMENT_BYTES, MAX_SESSION_ATTACHMENTS, type SessionAttachmentInfo } from "@/src/core";

export { MAX_SESSION_ATTACHMENT_BYTES, MAX_SESSION_ATTACHMENTS };

/** Dispatched on a composer's PathInput root with `detail: File[]` (browser
 *  drops). The composer that owns the root stages the files. */
export const INSERT_SESSION_FILES_EVENT = "lh:insert-session-files";
/** Marks the PathInput root of a composer that accepts staged files. */
export const SESSION_ATTACHMENT_INPUT_ATTRIBUTE = "data-session-attachment-input";
export const ATTACHMENT_LIMIT_ERROR = "Attachments are limited to 25 MiB in total.";
export const ATTACHMENT_COUNT_ERROR = "You can attach up to 100 files at once.";

export type StagedSessionAttachment = {
	id: string;
	name: string;
	/** Absent for entries restored from prepared infos. */
	file?: File;
	/** Object URL for staged images, or the chat image endpoint after restore. */
	previewUrl?: string;
	/** Set once prepared for `chatId`. */
	info?: SessionAttachmentInfo;
	chatId?: string;
};

export type SessionAttachments = {
	items: readonly StagedSessionAttachment[];
	busy: boolean;
	error: string;
	addFiles: (files: Iterable<File>) => void;
	remove: (id: string) => void;
	prepare: (chatId: string) => Promise<SessionAttachmentInfo[]>;
	clear: (ids?: readonly string[]) => void;
	restore: (infos: readonly SessionAttachmentInfo[], chatId: string) => void;
	snapshot: () => readonly StagedSessionAttachment[];
	setError: (message: string) => void;
};

const noSubscribe = () => () => {};
/** The desktop path bridge is fixed for the window's life. Server renders
 *  (and hydration) are always the browser case, so markup never mismatches. */
export function useDesktopFilePaths(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

export function sessionAttachmentUrl(chatId: string, attachmentId: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Called from event handlers only, so server renders never draw ids. */
function newAttachmentId(): string {
	const cryptoApi = globalThis.crypto;
	// randomUUID needs a secure context; plain-http hosts still have getRandomValues.
	if (typeof cryptoApi?.randomUUID === "function") {
		try { return cryptoApi.randomUUID(); } catch { /* fall through */ }
	}
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entrySize(entry: StagedSessionAttachment): number {
	return entry.file?.size ?? entry.info?.size ?? 0;
}

async function responseError(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
	} catch { /* non-JSON body */ }
	return `Could not prepare attachments (${response.status}).`;
}

/**
 * Files staged in a composer until Send. Entries live in memory only (Files
 * and object URLs are never persisted). The caller's send path owns
 * prepare() and clear(ids).
 */
export function useSessionAttachments(): SessionAttachments {
	const [items, setItems] = useState<readonly StagedSessionAttachment[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setErrorState] = useState("");
	const latest = useRef<readonly StagedSessionAttachment[]>([]);
	const objectUrls = useRef(new Set<string>());
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		const urls = objectUrls.current;
		return () => {
			mounted.current = false;
			for (const url of urls) URL.revokeObjectURL(url);
			urls.clear();
		};
	}, []);

	const commit = useCallback((next: readonly StagedSessionAttachment[]) => {
		latest.current = next;
		if (mounted.current) setItems(next);
	}, []);
	const setError = useCallback((message: string) => { if (mounted.current) setErrorState(message); }, []);
	const release = useCallback((entries: readonly StagedSessionAttachment[]) => {
		for (const entry of entries) {
			if (entry.previewUrl && objectUrls.current.delete(entry.previewUrl)) URL.revokeObjectURL(entry.previewUrl);
		}
	}, []);

	const addFiles = useCallback((files: Iterable<File>) => {
		let total = latest.current.reduce((sum, entry) => sum + entrySize(entry), 0);
		const added: StagedSessionAttachment[] = [];
		let count = latest.current.length;
		let overLimit = "";
		for (const file of files) {
			if (count >= MAX_SESSION_ATTACHMENTS) { overLimit = ATTACHMENT_COUNT_ERROR; break; }
			if (total + file.size > MAX_SESSION_ATTACHMENT_BYTES) { overLimit = ATTACHMENT_LIMIT_ERROR; continue; }
			count++;
			total += file.size;
			let previewUrl: string | undefined;
			if (file.type.startsWith("image/") && typeof URL.createObjectURL === "function") {
				previewUrl = URL.createObjectURL(file);
				objectUrls.current.add(previewUrl);
			}
			added.push({ id: newAttachmentId(), name: file.name || "Pasted image", file, ...(previewUrl ? { previewUrl } : {}) });
		}
		if (added.length > 0) commit([...latest.current, ...added]);
		setError(overLimit);
	}, [commit, setError]);

	const remove = useCallback((id: string) => {
		const gone = latest.current.filter((entry) => entry.id === id);
		if (gone.length === 0) return;
		release(gone);
		commit(latest.current.filter((entry) => entry.id !== id));
		setError("");
	}, [commit, release, setError]);

	const clear = useCallback((ids?: readonly string[]) => {
		const drop = ids ? new Set(ids) : null;
		const gone = drop ? latest.current.filter((entry) => drop.has(entry.id)) : latest.current;
		release(gone);
		commit(drop ? latest.current.filter((entry) => !drop.has(entry.id)) : []);
		setError("");
	}, [commit, release, setError]);

	const restore = useCallback((infos: readonly SessionAttachmentInfo[], chatId: string) => {
		const present = new Set(latest.current.map((entry) => entry.id));
		const restored = infos.filter((info) => !present.has(info.id)).map((info): StagedSessionAttachment => ({
			id: info.id,
			name: info.name,
			info,
			chatId,
			...(info.kind === "image" ? { previewUrl: sessionAttachmentUrl(chatId, info.id) } : {}),
		}));
		if (restored.length > 0) commit([...latest.current, ...restored]);
	}, [commit]);

	const prepare = useCallback(async (chatId: string): Promise<SessionAttachmentInfo[]> => {
		const entries = latest.current;
		const pending = entries.filter((entry) => !(entry.info && entry.chatId === chatId));
		if (pending.length === 0) return entries.map((entry) => entry.info!);
		const missing = pending.find((entry) => !entry.file);
		if (missing) {
			const message = `${missing.name} is no longer available. Remove it and attach it again.`;
			setError(message);
			throw new Error(message);
		}
		if (mounted.current) setBusy(true);
		setError("");
		try {
			const form = new FormData();
			for (const entry of pending) {
				form.append("files", entry.file!, entry.name);
				form.append("ids", entry.id);
			}
			let response: Response;
			try {
				response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/attachments`, { method: "POST", body: form });
			} catch {
				throw new Error("Could not upload attachments. Check your connection and try again.");
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = await response.json() as { attachments?: SessionAttachmentInfo[] };
			const byId = new Map((body.attachments ?? []).map((info) => [info.id, info]));
			if (pending.some((entry) => !byId.has(entry.id))) throw new Error("The server did not return every attachment.");
			// Merge into the latest list: newer additions and removals during the request survive.
			commit(latest.current.map((entry) => {
				const info = byId.get(entry.id);
				return info ? { ...entry, info, chatId } : entry;
			}));
			return entries.map((entry) => byId.get(entry.id) ?? entry.info!);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "Could not prepare attachments.";
			setError(message);
			throw cause instanceof Error ? cause : new Error(message);
		} finally {
			if (mounted.current) setBusy(false);
		}
	}, [commit, setError]);

	const snapshot = useCallback(() => latest.current, []);

	return useMemo(() => ({ items, busy, error, addFiles, remove, prepare, clear, restore, snapshot, setError }),
		[items, busy, error, addFiles, remove, prepare, clear, restore, snapshot, setError]);
}

/** Staged files above the composer row: names, image previews, removal,
 *  preparation progress and errors. */
export function SessionAttachmentTray({ attachments, agentBusy }: { attachments: SessionAttachments; agentBusy: boolean }) {
	const { items, busy, error } = attachments;
	if (items.length === 0 && !error) return null;
	return (
		<div data-testid="session-attachments" className="flex flex-col gap-1.5 px-3 pt-2.5 font-ui text-xs">
			{items.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Attached files">
				{items.map((item) => (
					<li key={item.id} data-attachment-id={item.id} className="flex max-w-56 items-center gap-1.5 rounded-lg border bg-background py-1 pl-1 pr-0.5">
						{item.previewUrl
							// eslint-disable-next-line @next/next/no-img-element -- blob/authenticated previews
							? <img src={item.previewUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
							: <FileTextIcon className="ml-1 size-4 shrink-0 text-muted-foreground" aria-hidden />}
						<span className="min-w-0 truncate" title={item.name}>{item.name}</span>
						<button
							type="button"
							aria-label={`Remove ${item.name}`}
							disabled={busy}
							onClick={() => attachments.remove(item.id)}
							className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
						>
							<XIcon className="size-3" aria-hidden />
						</button>
					</li>
				))}
			</ul>}
			{busy && <p role="status" className="flex items-center gap-1.5 text-muted-foreground">
				<LoaderCircleIcon className="size-3 animate-spin" aria-hidden />Preparing attachments…
			</p>}
			{!busy && agentBusy && items.length > 0 && <p role="status" className="text-muted-foreground">
				Files can be sent once the current reply finishes.
			</p>}
			{error && <p role="alert" className="text-destructive">{error}</p>}
		</div>
	);
}

/** A prepared attachment already sent in a chat: filename, plus the
 *  normalized image from the chat's attachment endpoint for images. */
export function SavedSessionAttachment({ chatId, attachment }: { chatId: string; attachment: SessionAttachmentInfo }) {
	return (
		<figure data-attachment-id={attachment.id} className="inline-flex max-w-full flex-col gap-1 font-ui text-xs">
			{attachment.kind === "image"
				// eslint-disable-next-line @next/next/no-img-element -- authenticated chat image endpoint
				? <img src={sessionAttachmentUrl(chatId, attachment.id)} alt={attachment.name} className="max-h-64 max-w-full rounded-lg border object-contain" />
				: null}
			<figcaption className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
				{attachment.kind !== "image" && <FileTextIcon className="size-3.5 shrink-0" aria-hidden />}
				<span className="truncate" title={attachment.name}>{attachment.name}</span>
			</figcaption>
		</figure>
	);
}
