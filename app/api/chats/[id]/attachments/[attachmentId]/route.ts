// GET /api/chats/[id]/attachments/[attachmentId]: a prepared image
// attachment's normalized picture (png/jpeg, nosniff, private no-store).
import { sessionAttachmentImageResponse } from "@/src/server";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; attachmentId: string }> }): Promise<Response> {
	const { id, attachmentId } = await ctx.params;
	return sessionAttachmentImageResponse(id, attachmentId);
}
