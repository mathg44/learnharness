/** Public-route durability checks. Only synthetic records and a fixture provider. */
import assert from "node:assert/strict";
import fs from "node:fs";

const [origin, mode = "fresh"] = process.argv.slice(2);
const expectedFile = "/evidence/expected.json";
async function request(route, method = "GET", body, headers = {}) {
	const response = await fetch(origin + route, {
		method, headers: { origin, "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60000),
	});
	assert.equal(response.status, 200, `${method} ${route}: ${await response.clone().text()}`);
	return response.json();
}
async function pages(id) {
	for (const route of ["/", "/settings", "/chat/new", ...(id ? [`/chat/${id}`] : [])]) {
		if (route === "/settings") {
			const redirect = await fetch(origin + route, { redirect: "manual", signal: AbortSignal.timeout(10000) });
			assert.equal(redirect.status, 307);
			assert.equal(redirect.headers.get("location"), "/chat/new", "Settings is a dialog, not a standalone page");
		}
		const response = await fetch(origin + route, { signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200, route);
		const html = await response.text();
		assert.match(html, /\/_next\/static\//, "assembled static assets referenced");
		const asset = html.match(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/)?.[1];
		assert(asset, "page must reference a static asset");
		assert.equal((await fetch(new URL(asset.replaceAll("&amp;", "&"), origin))).status, 200);
	}
}
async function settled(id) {
	const response = await fetch(`${origin}/api/chats/${id}/stream`, { signal: AbortSignal.timeout(30000) });
	assert.equal(response.status, 200);
	await response.text();
	const chat = await request(`/api/chats/${id}`);
	assert.equal(chat.turnInFlight, false);
	assert.equal(chat.turnError, undefined);
	assert(!chat.messages.some((m) => m.stopReason === "error"), "fixture inference must succeed");
	return chat;
}
async function snapshot(id) {
	const chat = await request(`/api/chats/${id}`);
	assert.equal(chat.turnInFlight, false);
	return {
		id, chat, chats: await request("/api/chats"), settings: await request("/api/settings"),
		graph: await request("/api/graph"), render: await request("/api/graph/render-settings"),
		prompts: await request("/api/settings/prompts"), custom: await request("/api/custom-provider"),
	};
}
if (mode === "fresh" || mode === "seed") {
	await pages();
	assert.deepEqual((await request("/api/chats")).chats, [], "new profile must not import records");
	assert.equal((await request("/api/settings")).settings, null, "new profile must not import settings");
	console.log("fresh production routes and static assets passed");
}
if (mode === "seed") {
	const etag = (await fetch(origin + "/api/custom-provider")).headers.get("etag");
	await request("/api/custom-provider", "POST", {
		baseUrl: "http://fixture:3080/v1", authMode: "apiKey", key: "synthetic-container-key",
	}, { "if-match": etag });
	const slot = { model: { provider: "custom", id: "fixture-teacher" }, thinkingLevel: "off" };
	await request("/api/settings/models", "PUT", { strong: slot, cheap: slot, vision: slot });
	await request("/api/settings/appearance", "PUT", { mode: "light", proseFontSize: 18 });
	await request("/api/settings/prompts/system-prompt.md", "PUT", { text: "Synthetic dormant prompt override. Do not enable." });
	await request("/api/graph/render-settings", "PUT", { sizeUnits: "world", nodeSize: 3, clusterLabels: false });
	const { id } = await request("/api/chats", "POST", { title: "Container persistence lesson" });
	await request("/api/chat", "POST", { chatId: id, input: { type: "text", text: "Teach me which planet is closest to the Sun." } });
	const chat = await settled(id);
	assert(chat.messages.some((m) => m.role === "assistant" && m.content?.some((b) => b.type === "toolCall" && b.name === "probe" && b.arguments.question === "Which planet is closest to the Sun?")));
	await pages(id);
	fs.writeFileSync(expectedFile, JSON.stringify(await snapshot(id)));
	console.log("saved pending Probe, model slots, appearance, prompt text and graph rendering through routes");
} else if (mode === "verify") {
	const expected = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
	assert.deepEqual(await snapshot(expected.id), expected, "public records must survive lifecycle change");
	await pages(expected.id);
	console.log("same conversation, settings, graph and prompt state available through routes");
} else if (mode === "answer") {
	const { id } = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
	const chat = await request(`/api/chats/${id}`);
	const call = chat.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === "toolCall" && b.name === "probe");
	assert(call, "persisted pending question is answerable after restart");
	await request("/api/chat", "POST", { chatId: id, input: { type: "answer", toolCallId: call.id, answer: {
		kind: "quiz", tool: "probe", questionText: call.arguments.question, dontKnow: false,
		answers: [{ label: "Mercury", value: "mercury", index: 1 }],
		options: [{ index: 1, label: "Mercury" }, { index: 2, label: "Venus" }],
		correct: true, correctIndices: [0], confidence: 90, thinking: "Mercury has the innermost orbit.",
		explanation: call.arguments.explanation, answeredAt: "2026-01-01T00:00:00.000Z",
	} } });
	const answered = await settled(id);
	assert(JSON.stringify(answered.messages).includes("Correct. Mercury is closest to the Sun."));
	assert(answered.messages.some((m) => m.role === "toolResult" && m.toolName === "probe"));
	const form = new FormData();
	form.append("files", new Blob(["Mercury orbits closest to the Sun."], { type: "text/plain" }), "fixture-notes.txt");
	const imported = await fetch(origin + "/api/graph/import", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
	assert.equal(imported.status, 200);
	const result = await imported.json();
	assert.equal(result.results[0].outcome, "completed", JSON.stringify(result));
	const graph = await request("/api/graph");
	assert(JSON.stringify(graph).includes("Mercury orbits closest to the Sun."), "extracted knowledge is readable through graph route");
	fs.writeFileSync(expectedFile, JSON.stringify(await snapshot(id)));
	console.log("answered the restored Probe and imported synthetic knowledge via extractor/auditor routes");
}
