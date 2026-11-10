/** Actual research tools/loops/jobs with public-fetch's controlled DNS and
 * sockets. Readiness is mocked only in individual tests; production stays off. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResearchResult, SteerMessage } from "../src/core/contracts.ts";
import { installPublicHttp } from "./helpers/public-http.ts";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-public-research-"));
const saved = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE"].map((key) => [key, process.env[key]]));
const home = path.join(profile, "home");
fs.mkdirSync(home);
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"), LH_SERVER_MODE: "tailscale" });
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
const { SERVER_CAPABILITIES } = await import("../src/core/server-capabilities.ts");
const { createWebTools } = await import("../src/agent/tools/web.ts");
const { runResearcherAgent } = await import("../src/agent/subagents/researcher.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { tavilyProvider } = await import("../src/server/search.ts");

beforeEach(() => { process.env.LH_SERVER_MODE = "tailscale"; });
afterEach(() => { researchModelOverride.current = undefined; });
after(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(profile, { recursive: true, force: true });
});
const run = (tool: AgentTool<any>, args: unknown, signal?: AbortSignal) => tool.execute!("synthetic-call", args, signal);

it("production remains closed at declarations, dispatch, stale direct calls, worker entry and recovery", async (t) => {
	const fixture = installPublicHttp(t, { responses: [] });
	assert.equal(SERVER_CAPABILITIES.research.ready(), false);
	const chat = chatStore.createChat("Synthetic disabled research");
	const ctx = { chatId: chat.id, chatStore, jobStore, spawn: () => { throw new Error("Must not spawn"); } };
	assert.ok(!("research" in createTeacherTools(ctx, { research: true })));
	const dispatched = await run(jobTools(ctx).research!, { question: "synthetic" });
	assert.equal(dispatched.isError, true);
	for (const [name, params] of [["web_search", { query: "fixture" }], ["web_fetch", { url: "http://public.example/" }]] as const) {
		const result = await run(createWebTools(() => { throw new Error("Must not resolve search"); })[name]!, params);
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result), /not available on this server/);
	}
	await assert.rejects(runResearcherAgent("synthetic"), /not available on this server/);
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "recovered", input: { question: "synthetic" } });
	const steers: SteerMessage[] = [];
	await createJobRunner({ chatStore, jobStore, engineFor: () => { throw new Error("Must not resolve provider"); }, deliver: async (steer) => { steers.push(steer); } }).runJob(job.id);
	assert.equal(jobStore.getJob(job.id)!.status, "error");
	assert.equal(steers.length, 1);
	assert.match(JSON.stringify(steers), /not available on this server/);
	assert.deepEqual(fixture.connections, []);
});

it("simulated research readiness restores role declarations but not PDF, filesystem or other capabilities", (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const chat = chatStore.createChat("Synthetic readiness declarations");
	const ctx = { chatId: chat.id, chatStore, jobStore, spawn: () => {}, deliver: () => {} };
	for (const tools of [createTeacherTools(ctx), createProberTools(ctx), practiceTools({ chatId: chat.id, chatStore, jobs: ctx })]) {
		assert.ok(tools.research);
		for (const name of ["read", "ls", "find", "grep", "show_image", "pdf", "visual", "demo"]) assert.ok(!(name in tools), name);
	}
});

it("actual web_fetch reads a public text response through pinned sockets and reports final URL", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [
		{ status: 302, headers: { location: "https://other.example/final" } },
		{ body: "Synthetic approved teaching source" },
	] });
	const out = await run(createWebTools(() => null).web_fetch!, { url: "http://public.example/" });
	assert.match(String(out.details), /^Source: https:\/\/other.example\/final \(HTTP 200\)/);
	assert.match(String(out.details), /Synthetic approved teaching source/);
	assert.deepEqual(fixture.connections.map((dial) => dial.port), [80, 443]);
});

it("actual search and page tools keep provider credentials separate and distrust search-result URLs", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const key = "synthetic-tavily-key";
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [
			{ title: "Public", url: "https://public.example/source", content: "Synthetic source" },
			{ title: "Untrusted private hit", url: "http://127.0.0.1/credentials", content: "Do not fetch" },
		] }) },
		{ body: "Public source body" },
	] });
	const tools = createWebTools(() => tavilyProvider(key));
	const hits = await run(tools.web_search!, { query: "synthetic topic" });
	assert.ok(Array.isArray(hits.details));
	assert.match(JSON.stringify(hits.details), /Untrusted private hit/);
	assert.match(String((await run(tools.web_fetch!, { url: "http://127.0.0.1/credentials" })).details), /Destination denied/);
	assert.match(String((await run(tools.web_fetch!, { url: "https://public.example/source" })).details), /Public source body/);
	assert.equal(fixture.requests.length, 2);
	assert.match(fixture.requests[0]!, /synthetic-tavily-key/);
	assert.ok(!/synthetic-tavily-key|authorization:|x-api-key:/i.test(fixture.requests[1]!));
	assert.deepEqual(fixture.dnsNames, ["api.tavily.com", "public.example"]);
});

it("actual HTML extraction works, while unreadable HTML never invokes Jina or an ambient fallback", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const text = "This is a synthetic source explaining the approved lesson topic in complete sentences. ".repeat(30);
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-type": "text/html" }, body: `<html><head><title>Synthetic article</title></head><body><article><h1>Lesson source</h1><p>${text}</p></article></body></html>` },
		{ headers: { "content-type": "text/html" }, body: "<html><body><div id='root'></div><script>render()</script></body></html>" },
	] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Ambient or Jina fetch forbidden"); });
	const tool = createWebTools(() => null).web_fetch!;
	assert.match(String((await run(tool, { url: "https://public.example/article" })).details), /synthetic source explaining/);
	const unreadable = await run(tool, { url: "https://public.example/javascript" });
	assert.match(String(unreadable.details), /Could not extract readable content/);
	assert.equal(fixture.connections.length, 2);
	assert.ok(fixture.dnsNames.every((name) => name === "public.example"));
	assert.match(tool.description, /No reader fallback/);
});

it("denials and private redirects produce honest tool failures without a reader retry", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [{ status: 302, headers: { location: "http://169.254.169.254/credentials" } }] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("No fallback fetch"); });
	const tool = createWebTools(() => null).web_fetch!;
	for (const url of ["http://127.1/", "http://[::ffff:127.0.0.1]/", "http://public.example/"]) {
		const out = await run(tool, { url });
		assert.match(String(out.details), /web_fetch failed.*Destination denied/);
	}
	assert.equal(fixture.connections.length, 1);
});

it("actual web_fetch bounds chunked bytes, decompressed bodies and output characters", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const { gzipSync } = await import("node:zlib");
	const fixture = installPublicHttp(t, { responses: [
		{ raw: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n500001\r\n${"x".repeat(5 * 1024 * 1024 + 1)}\r\n0\r\n\r\n` },
		{ headers: { "content-encoding": "gzip" }, body: gzipSync("x".repeat(5 * 1024 * 1024 + 1)) },
		{ body: "x".repeat(50_000) },
	] });
	const tool = createWebTools(() => null).web_fetch!;
	for (let i = 0; i < 2; i++) assert.match(String((await run(tool, { url: "https://public.example/large" })).details), /Response too large/);
	const out = await run(tool, { url: "https://public.example/long" });
	assert.match(String(out.details), /Truncated at 40000 characters/);
	assert.equal(String(out.details).length, 40_000);
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

it("caps the complete server output including oversized titles, source URLs and error metadata", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const title = "Synthetic title ".repeat(5_000);
	installPublicHttp(t, { responses: [
		{ headers: { "content-type": "text/html" }, body: `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"Synthetic article content for the lesson. ".repeat(30)}</p></article></body></html>` },
		{ body: "Short source body" },
	] });
	const tool = createWebTools(() => null).web_fetch!;
	for (const url of ["https://public.example/title", `https://public.example/?source=${"x".repeat(45_000)}`, `invalid-url-${"x".repeat(45_000)}`]) {
		const out = await run(tool, { url });
		const text = String(out.details);
		assert.equal(text.length, 40_000);
		assert.match(text, /\[Truncated at 40000 characters\]$/);
	}
});

it("tool cancellation reaches the in-flight response body and search provider", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [{ body: "partial", headers: { "content-length": "100" }, stallBody: true }] });
	const controller = new AbortController();
	const pending = run(createWebTools(() => null).web_fetch!, { url: "https://public.example/slow" }, controller.signal);
	setImmediate(() => controller.abort());
	const out = await pending;
	assert.match(String(out.details), /cancelled/);
	assert.ok(fixture.sockets[0]!.destroyed);
	let signalSeen: AbortSignal | undefined;
	const search = createWebTools(() => ({ id: "tavily", async search(_query, _count, signal) { signalSeen = signal; return []; } })).web_search!;
	await run(search, { query: "synthetic" });
	assert.ok(signalSeen instanceof AbortSignal);
});

it("a scripted researcher receives public success and private denial through its actual tool loop", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [{ body: "Synthetic researcher source" }] });
	const faux = createFauxCore({});
	faux.setResponses([
		(context) => {
			const system = context.messages.find((message) => message.role === "system");
			assert.ok(system && system.role === "system");
			assert.ok(!system.toolsAdded?.some((tool) => tool.name === "web_fetch_pdf"));
			return fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://public.example/" }, { id: "public" })], { stopReason: "toolUse" });
		},
		(context) => {
			assert.match(JSON.stringify(context.messages), /Synthetic researcher source/);
			return fauxAssistantMessage([fauxToolCall("web_fetch", { url: "http://127.0.0.1/private" }, { id: "private" })], { stopReason: "toolUse" });
		},
		(context) => {
			const denial = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "private");
			assert.match(JSON.stringify(denial), /Destination denied/);
			return fauxAssistantMessage([fauxText("## Summary\nPublic source verified; private destination denied.\n\n## Gaps\nNo access to private services.")]);
		},
	]);
	assert.match(await runResearcherAgent("Synthetic test", { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, pdfDir: path.join(profile, "not-used") }), /private destination denied/);
	assert.equal(fixture.connections.length, 1);
});

for (const recovered of [false, true]) {
	it(`${recovered ? "recovered" : "dispatched"} research preserves durable completion and pending delivery with a synthetic public source`, async (t) => {
		t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
		const fixture = installPublicHttp(t, { responses: [{ body: "Synthetic saved source" }] });
		const url = "https://public.example/source";
		const brief = `## Summary\nSynthetic saved source verified. [Source](${url})`;
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url }, { id: "fetch" })], { stopReason: "toolUse" }),
			(context) => {
				assert.match(JSON.stringify(context.messages), /Synthetic saved source/);
				return fauxAssistantMessage([fauxText(brief)]);
			},
		]);
		researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
		const chat = chatStore.createChat("Synthetic research delivery");
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({ chatStore, jobStore, searchProvider: () => null, deliver: async (steer) => { steers.push(steer); } });
		let work: Promise<void> | undefined;
		let jobId: string;
		const input = { question: "Verify synthetic source", context: url };
		if (recovered) {
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "saved-call", input });
			jobId = job.id;
			work = runner.runJob(job.id);
		} else {
			const result = await run(jobTools({ chatId: chat.id, jobStore, spawn: (job, args) => { jobId = job.id; work = runner.runJob(job.id, args); } }).research!, input);
			assert.match(String(result.details), /^Dispatched \(job /);
		}
		assert.ok(work);
		await work;
		const done = jobStore.getJob(jobId!)!;
		assert.equal(done.status, "done");
		assert.equal((done.result as ResearchResult).brief, brief);
		assert.deepEqual(done.delivery, { kind: "result", status: "pending" });
		assert.equal(steers.length, 1);
		assert.match(JSON.stringify(steers), /Synthetic saved source verified/);
		assert.equal(fixture.connections.length, 1);
	});
}

it("research failure after a denied fetch reaches the background result and pending session delivery", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [] });
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("web_fetch", { url: "http://169.254.169.254/credentials" }, { id: "denied" })], { stopReason: "toolUse" }),
		(context) => {
			assert.match(JSON.stringify(context.messages), /Destination denied/);
			throw new Error("the supplied destination is not public; no source was retrieved");
		},
	]);
	researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
	const chat = chatStore.createChat("Synthetic research failure delivery");
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "denied-source", input: { question: "Verify the supplied synthetic URL" } });
	const steers: SteerMessage[] = [];
	await createJobRunner({ chatStore, jobStore, deliver: async (steer) => { steers.push(steer); } }).runJob(job.id);
	const failed = jobStore.getJob(job.id)!;
	assert.equal(failed.status, "error");
	assert.deepEqual(failed.delivery, { kind: "result", status: "pending" });
	assert.equal(steers.length, 1);
	assert.match(JSON.stringify(steers), /supplied destination is not public/);
	assert.deepEqual(fixture.connections, []);
});
