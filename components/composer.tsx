"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRightIcon, CornerDownLeftIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PathInput } from "@/components/path-input";
import { AttachFilesButton } from "@/components/attach-files-button";
import { INSERT_SESSION_FILES_EVENT, SessionAttachmentTray, useDesktopFilePaths, type SessionAttachments } from "@/components/session-attachments";

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	/** The between-problems pause is live: practice session, nothing
	 *  active, no turn/compaction in flight (the caller's fold). */
	nextProblem?: boolean;
	/** Staged files are waiting (being prepared, or for the turn to end).
	 *  Enter must not stop the turn or skip ahead underneath them. */
	waiting?: boolean;
}): "stop" | "send" | "next" | "none" {
	if (state.waiting && !state.canSend) return "none";
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

/**
 * Session composer with local keystroke state. The owning Chat keeps the
 * current draft in a ref for send/dictation, so typing doesn't rerender the
 * transcript; revision signals explicit parent-driven draft resets.
 */
export function ChatSessionComposer({
	busy,
	value,
	revision,
	onChange,
	onSend,
	onStop,
	sendAllowed,
	dictationActive,
	autoFocus,
	inputRef,
	onEscape,
	placeholder,
	nextProblem,
	onNext,
	attachments,
}: {
	busy: boolean;
	value: string;
	revision: number;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	sendAllowed: boolean;
	dictationActive: boolean;
	autoFocus?: boolean;
	inputRef?: React.RefObject<HTMLDivElement | null>;
	onEscape?: () => void;
	placeholder?: string;
	nextProblem?: boolean;
	onNext?: () => void;
	attachments?: SessionAttachments;
}) {
	const [draft, setDraft] = useState(value);
	useLayoutEffect(() => { setDraft(value); }, [revision, value]);
	// Staged files only send on an idle agent. Text steers mid-turn only
	// when no files are staged (the send path refuses the combination).
	const staged = (attachments?.items.length ?? 0) > 0;
	const canSend = sendAllowed && !attachments?.busy && !(busy && staged)
		&& (draft.trim().length > 0 || dictationActive || staged);
	const applyDraft = useCallback((next: string) => {
		setDraft(next);
		onChange(next);
	}, [onChange]);

	return (
		<Composer
			busy={busy}
			value={draft}
			onChange={applyDraft}
			onSend={onSend}
			onStop={onStop}
			canSend={canSend}
			autoFocus={autoFocus}
			inputRef={inputRef}
			onEscape={onEscape}
			placeholder={placeholder}
			nextProblem={nextProblem}
			onNext={onNext}
			attachments={attachments}
		/>
	);
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend: canSendProp,
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer the lesson…",
	nextProblem = false,
	onNext,
	attachments,
	sendLabel = "Send",
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLDivElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
	/** The practice pause is live (owner round 16): Enter on the empty
	 *  composer fires the next-problem signal instead of doing nothing —
	 *  the keyboard-first move-on. */
	nextProblem?: boolean;
	/** The signal's dispatcher (send({type:"next"})) — the chip and the
	 *  empty-Enter share it. */
	onNext?: () => void;
	/** Browser file staging (paperclip, image paste, drops). The caller's
	 *  onSend owns prepare() and clear(). Desktop path attachments are
	 *  unaffected. */
	attachments?: SessionAttachments;
	/** The send button's accessible name. */
	sendLabel?: string;
}) {
	const canSend = canSendProp && !attachments?.busy;
	const waiting = Boolean(attachments && (attachments.busy || (busy && attachments.items.length > 0)));
	const act = (source: "enter" | "button") => {
		// The visible Stop button always stops; only Enter defers to staged files.
		const action = source === "button" && busy && !canSend ? "stop" : enterAction({ busy, canSend, nextProblem, waiting });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	const ownInputRef = useRef<HTMLDivElement>(null);
	const editorRef = inputRef ?? ownInputRef;
	const attachmentsRef = useRef(attachments);
	useLayoutEffect(() => { attachmentsRef.current = attachments; });
	// Desktop keeps path attachments only: no File staging from paste, drops or the picker.
	const desktop = useDesktopFilePaths();
	const staging = attachments !== undefined && !desktop;
	useEffect(() => {
		const root = editorRef.current;
		if (!staging || !root) return;
		const insert = (event: Event) => {
			const files: unknown = (event as CustomEvent<unknown>).detail;
			if (Array.isArray(files) && files.every((file) => file instanceof File)) {
				attachmentsRef.current?.addFiles(files);
				root.focus();
			}
		};
		root.addEventListener(INSERT_SESSION_FILES_EVENT, insert);
		return () => root.removeEventListener(INSERT_SESSION_FILES_EVENT, insert);
	}, [staging, editorRef]);
	const form = (
		<form
			data-testid="composer"
			className="flex items-end gap-1.5 p-1.5"
			onSubmit={(e) => {
				e.preventDefault();
				act("button");
			}}
		>
			<PathInput
				ref={editorRef}
				value={value}
				onValueChange={onChange}
				defaultDropTarget
				onKeyDown={(e) => {
					// Esc ends dictation before anything else Esc might someday mean
					// here (the dictate decisions: click-again or Esc to stop).
					// stopPropagation claims the Esc (keyboard wave A): the
					// window-level chain must not also abort a turn under us.
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Chat convention: Enter sends, Shift+Enter is a newline.
					// ⌘/Ctrl+Enter also sends — the universal submit shortcut
					// across every input in the app (thinking field, answers).
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
						act("enter");
					}
				}}
				{...(staging ? {
					"data-session-attachment-input": "",
					// Capture runs before PathInput's native plaintext paste handler.
					onPasteCapture: (event: React.ClipboardEvent<HTMLDivElement>) => {
						const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
						if (images.length === 0) return;
						event.preventDefault();
						attachmentsRef.current?.addFiles(images);
					},
				} : {})}
				placeholder={placeholder}
				autoFocus={autoFocus}
				className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
			/>
			<AttachFilesButton editorRef={editorRef} onFiles={staging ? (files) => attachmentsRef.current?.addFiles(files) : undefined} />
			{/* The button follows the text (owner report 2026-10-03): while
				 a turn runs WITH text typed it stays the SEND affordance
				 (click = steer — steering must be clickable, not Enter-only);
				 only an empty composer morphs it to Stop. ESC keeps its
				 confirm-popup abort in every state, so stop is never
				 unreachable. No tooltip — the ↵ glyph is the affordance
				 (owner, subtlety round 2026-09-25).

				 THE NEXT MORPH (owner round 16 refinement, 2026-10-06): an
				 empty composer in the practice pause morphs the button into
				 a wide green NEXT PROBLEM — the affordance IS the button
				 (click and Enter share one lane), and typing anything
				 returns the regular send. The green is the app's correct-
				 answer register (answered-card's green-500/600). */}
				{nextProblem && !busy && !canSend && !waiting ? (
					<button
						type="submit"
						data-testid="next-problem-button"
						aria-label="Next problem"
						className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-green-600 px-4 font-ui text-xs font-medium uppercase tracking-wide text-white transition-colors hover:bg-green-500"
					>
						Next problem
						<ArrowRightIcon className="size-4" />
					</button>
				) : (
					<button
						type="submit"
						aria-label={busy && !canSend ? "Stop" : sendLabel}
						disabled={!busy && !canSend}
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
							busy && !canSend
								? "bg-secondary text-foreground hover:bg-accent"
								: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
						)}
					>
						{busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
					</button>
				)}
		</form>
	);
	return attachments ? <><SessionAttachmentTray attachments={attachments} agentBusy={busy} />{form}</> : form;
}
