/**
 * Existing-chat attachment sends whose acknowledgment was lost. The server
 * may have saved the input anyway; a later canonical read then shows it.
 * Only attachment ids that a server-resolved user message carries count as
 * sent, and the submitted text clears only when that message saved it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provenAttachmentSend } from "../components/chat.tsx";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const info = (id: string) => ({ id, name: `${id}.png`, kind: "image" as const, mimeType: "image/png", size: 4 });
const saved = (id: string, ids: string[], userText: string): LhMessage => ({
	...newUserMessage(userText || "(attachments)"),
	id,
	userText,
	sessionAttachments: ids.map(info),
});

describe("provenAttachmentSend", () => {
	it("is null until a canonical user message carries a submitted id", () => {
		const attempt = { ids: ["file_a"], text: "hello" };
		assert.equal(provenAttachmentSend(attempt, []), null);
		assert.equal(provenAttachmentSend(attempt, [{ ...newUserMessage("hello"), id: "local_1" }]), null);
		assert.equal(provenAttachmentSend(attempt, [saved("s1", ["file_other"], "hello")]), null);
	});

	it("returns only the submitted ids the saved message carries", () => {
		const proof = provenAttachmentSend({ ids: ["file_a", "file_b"], text: "hello" }, [saved("s1", ["file_b", "file_x"], "hello")]);
		assert.deepEqual(proof, { ids: ["file_b"], sameText: true });
	});

	it("matches the saved text after trimming, and reports a different text", () => {
		assert.deepEqual(provenAttachmentSend({ ids: ["file_a"], text: "hello" }, [saved("s1", ["file_a"], "hello\n")]), { ids: ["file_a"], sameText: true });
		assert.deepEqual(provenAttachmentSend({ ids: ["file_a"], text: "" }, [saved("s1", ["file_a"], "")]), { ids: ["file_a"], sameText: true });
		assert.deepEqual(provenAttachmentSend({ ids: ["file_a"], text: "hello" }, [saved("s1", ["file_a"], "other")]), { ids: ["file_a"], sameText: false });
	});

	it("ignores assistant and tool messages", () => {
		const assistant = { ...saved("s1", ["file_a"], "hello"), role: "assistant" } as unknown as LhMessage;
		assert.equal(provenAttachmentSend({ ids: ["file_a"], text: "hello" }, [assistant]), null);
	});
});
