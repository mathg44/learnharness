// POST /api/chats/[id]/attachments: prepare browser attachments for a later
// send. Multipart: one `files` entry per file, each with a matching `ids`
// entry (client-minted, stable across retries; a known id is reused, never
// converted again). Success: { attachments: SessionAttachmentInfo[] }.
import { prepareSessionAttachments } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return prepareSessionAttachments(id, request);
}
