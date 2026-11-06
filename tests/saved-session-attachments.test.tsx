import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedSessionAttachments } from "../components/saved-session-attachments.tsx";

describe("saved session attachments", () => {
	it("uses guarded session image URLs and escapes uploaded names", () => {
		const html = renderToStaticMarkup(<SavedSessionAttachments chatId="chat_1" attachments={[
			{ id: "image_1", name: '<img src="https://elsewhere.invalid">', kind: "image", mimeType: "image/png", size: 4 },
			{ id: "pdf_1", name: "lesson.pdf", kind: "pdf", mimeType: "application/pdf", size: 12 },
		]} />);
		assert.match(html, /src="\/api\/chats\/chat_1\/attachments\/image_1"/);
		assert.ok(!html.includes('src="https://elsewhere.invalid"'));
		assert.match(html, /lesson.pdf/);
		assert.match(html, /Transcribed page by page/);
	});

	it("renders nothing for text-only messages without attachments", () => {
		assert.equal(renderToStaticMarkup(<SavedSessionAttachments chatId="chat_1" attachments={[]} />), "");
	});
});
