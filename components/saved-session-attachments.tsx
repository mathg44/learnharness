"use client";

import { SavedSessionAttachment } from "@/components/session-attachments";
import type { SessionAttachmentInfo } from "@/src/core";

export function SavedSessionAttachments({ chatId, attachments }: {
	chatId: string;
	attachments: readonly SessionAttachmentInfo[];
}) {
	if (attachments.length === 0) return null;
	return <div className="mt-2 flex flex-wrap items-start gap-2" data-testid="saved-session-attachments">
		{attachments.map((attachment) => <div key={attachment.id} className="max-w-full rounded-md border bg-background/60 p-2">
			<SavedSessionAttachment chatId={chatId} attachment={attachment} />
			{attachment.kind === "pdf" && <p className="mt-1 text-xs text-muted-foreground">Transcribed page by page. Check important details against the original.</p>}
		</div>)}
	</div>;
}
