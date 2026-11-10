/** Research PDFs through the actual researcher loop and background research jobs,
 * over controlled public HTTP sockets and native PDF parsing. Readiness is mocked
 * per test; production stays off. Scripted faux engines only, no live providers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, it, type TestContext } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ResearchResult, SteerMessage } from "../src/core/contracts.ts";
import { installPublicHttp } from "./helpers/public-http.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-pdf-jobs-"));
const saved = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE", "TMPDIR"].map((key) => [key, process.env[key]]));
const home = path.join(profile, "home");
fs.mkdirSync(home);
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"), LH_SERVER_MODE: "tailscale" });
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
const { SERVER_CAPABILITIES } = await import("../src/core/server-capabilities.ts");
const { createPdfReadTools } = await import("../src/agent/tools/pdf-read.ts");
const { runResearcherAgent } = await import("../src/agent/subagents/researcher.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { abortJob } = await import("../src/server/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

/** Job temp storage lands here, so leftovers are visible and never reach the real /tmp. */
const scratch = path.join(profile, "tmp");
beforeEach(() => {
	process.env.LH_SERVER_MODE = "tailscale";
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.mkdirSync(scratch);
	process.env.TMPDIR = scratch;
});
afterEach(() => { researchModelOverride.current = undefined; });
after(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(profile, { recursive: true, force: true });
});

const bytes = tinyPdf([
	{ runs: [{ text: "Synthetic research paper", x: 72, y: 720 }] },
	{ runs: [{ text: "The orthogonal complement theorem", x: 72, y: 720 }] },
]);
const pdfReply = { headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) };
const PDF_TOOLS = ["web_fetch_pdf", "pdf_info", "pdf_extract", "pdf_search"];
const FINAL_URL = "https://papers.example/final.pdf";
const BRIEF = `## Summary\nThe synthetic paper states the orthogonal complement theorem (p. 2). [Synthetic paper](${FINAL_URL})\n\n## Gaps\nNone.`;

type Ctx = Parameters<Extract<FauxResponseStep, (...args: any[]) => unknown>>[0];
function declared(context: Ctx): string[] {
	return context.messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
}
function toolText(context: Ctx, id: string): string {
	const message = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);
	assert.ok(message && message.role === "toolResult", `tool result ${id}`);
	return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}
function engine(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
/** Records every file the PDF tools write, passing the write through unchanged. */
function recordWrites(t: TestContext): string[] {
	const written: string[] = [];
	const write = io.writeFile;
	t.mock.method(io, "writeFile", async (...args: Parameters<typeof write>) => {
		written.push(String(args[0]));
		return write(...args);
	});
	return written;
}
function readyForPdfResearch(t: TestContext) {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
}

/** Scripted researcher: download, search, extract the cited page, then the final brief. */
function readingSteps(onDownloaded: () => void = () => {}): FauxResponseStep[] {
	let file = "";
	return [
		(context) => {
			for (const name of PDF_TOOLS) assert.ok(declared(context).includes(name), name);
			assert.ok(!declared(context).includes("pdf_render"));
			return fauxAssistantMessage([fauxToolCall("web_fetch_pdf", { url: "https://public.example/paper.pdf" }, { id: "download" })], { stopReason: "toolUse" });
		},
		(context) => {
			const summary = JSON.parse(toolText(context, "download")) as { path: string; url: string; page_count: number };
			assert.equal(summary.url, FINAL_URL);
			assert.equal(summary.page_count, 2);
			assert.equal(summary.path, path.basename(summary.path));
			file = summary.path;
			onDownloaded();
			return fauxAssistantMessage([fauxToolCall("pdf_search", { path: file, query: "theorem" }, { id: "search" })], { stopReason: "toolUse" });
		},
		(context) => {
			assert.match(toolText(context, "search"), /"page":2/);
			return fauxAssistantMessage([fauxToolCall("pdf_extract", { path: file, pages: "2" }, { id: "extract" })], { stopReason: "toolUse" });
		},
		(context) => {
			const page = toolText(context, "extract");
			assert.match(page, /--- Page 2 ---\n.*orthogonal complement theorem/);
			assert.doesNotMatch(page, /Synthetic research paper/);
			return fauxAssistantMessage([fauxText(BRIEF)]);
		},
	];
}

it("production readiness refuses direct PDF tool calls without connecting or writing", async (t) => {
	assert.equal(SERVER_CAPABILITIES.pdf.ready(), false);
	const fixture = installPublicHttp(t, { responses: [] });
	const written = recordWrites(t);
	const dir = fs.mkdtempSync(path.join(profile, "direct-"));
	const tools = createPdfReadTools(dir);
	for (const [name, args] of [
		["web_fetch_pdf", { url: "https://public.example/paper.pdf" }],
		["pdf_info", { path: "paper.pdf" }],
		["pdf_extract", { path: "paper.pdf", pages: "1" }],
		["pdf_search", { path: "paper.pdf", query: "theorem" }],
	] as const) {
		const result = await tools[name]!.execute!("stale", args);
		assert.equal(result.isError, true, name);
		assert.match(JSON.stringify(result), /not available on this server/);
	}
	assert.deepEqual(fixture.connections, []);
	assert.deepEqual(written, []);
	assert.deepEqual(fs.readdirSync(dir), []);
});

it("research without PDF readiness declares no PDF tools and a stale web_fetch_pdf call reaches no network", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [] });
	const brief = await runResearcherAgent("Synthetic PDF question", {
		pdfDir: fs.mkdtempSync(path.join(profile, "research-only-")),
		engine: engine([
			(context) => {
				for (const name of [...PDF_TOOLS, "pdf_render"]) assert.ok(!declared(context).includes(name), name);
				return fauxAssistantMessage([fauxToolCall("web_fetch_pdf", { url: "https://public.example/paper.pdf" }, { id: "stale" })], { stopReason: "toolUse" });
			},
			(context) => {
				const stale = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "stale");
				assert.ok(stale && stale.role === "toolResult" && stale.isError);
				return fauxAssistantMessage([fauxText("## Summary\nThe PDF could not be read on this server.")]);
			},
		]),
	});
	assert.match(brief, /could not be read/);
	assert.deepEqual(fixture.connections, []);
});

it("a researcher with PDF readiness downloads, searches and extracts a public PDF, then cites its page", async (t) => {
	readyForPdfResearch(t);
	const fixture = installPublicHttp(t, { responses: [{ status: 302, headers: { location: FINAL_URL } }, pdfReply] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Ambient fetch and reader fallbacks forbidden"); });
	const brief = await runResearcherAgent("Synthetic PDF question", {
		pdfDir: fs.mkdtempSync(path.join(profile, "researcher-")),
		engine: engine(readingSteps()),
	});
	assert.equal(brief, BRIEF);
	assert.deepEqual(fixture.dnsNames, ["public.example", "papers.example"]);
	assert.equal(fixture.connections.length, 2);
});

for (const recovered of [false, true]) {
	it(`${recovered ? "recovered" : "dispatched"} research reads a PDF, saves a durable brief with sources and removes its download dir`, async (t) => {
		readyForPdfResearch(t);
		const fixture = installPublicHttp(t, { responses: [{ status: 302, headers: { location: FINAL_URL } }, pdfReply] });
		const written = recordWrites(t);
		let downloadDir = "";
		researchModelOverride.current = engine(readingSteps(() => {
			assert.equal(written.length, 1);
			downloadDir = path.dirname(written[0]!);
			assert.ok(fs.existsSync(written[0]!));
		}));
		const chat = chatStore.createChat("Synthetic PDF research delivery");
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({ chatStore, jobStore, searchProvider: () => null, deliver: async (steer) => { steers.push(steer); } });
		const input = { question: "What does the synthetic paper state?", context: "https://public.example/paper.pdf" };
		let jobId = "";
		let work: Promise<void> | undefined;
		if (recovered) {
			jobId = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "saved-pdf-call", input }).id;
			work = runner.runJob(jobId);
		} else {
			const result = await jobTools({ chatId: chat.id, jobStore, spawn: (job, args) => { jobId = job.id; work = runner.runJob(job.id, args); } }).research!.execute!("pdf-call", input);
			assert.match(String(result.details), /^Dispatched \(job /);
		}
		assert.ok(work);
		await work;
		const done = jobStore.getJob(jobId)!;
		assert.equal(done.status, "done");
		assert.deepEqual(done.result as ResearchResult, { brief: BRIEF, sources: [{ title: "Synthetic paper", url: FINAL_URL }] });
		assert.deepEqual(done.delivery, { kind: "result", status: "pending" });
		assert.equal(steers.length, 1);
		assert.match(JSON.stringify(steers), /orthogonal complement theorem \(p\. 2\)/);
		assert.ok(downloadDir);
		assert.equal(fs.existsSync(downloadDir), false);
		assert.deepEqual(fs.readdirSync(scratch), []);
		assert.equal(fixture.connections.length, 2);
	});
}

it("a research job that fails after downloading a PDF saves the failure for delivery and removes its download dir", async (t) => {
	readyForPdfResearch(t);
	installPublicHttp(t, { responses: [pdfReply] });
	const written = recordWrites(t);
	researchModelOverride.current = engine([
		fauxAssistantMessage([fauxToolCall("web_fetch_pdf", { url: "https://public.example/paper.pdf" }, { id: "download" })], { stopReason: "toolUse" }),
		() => {
			assert.equal(written.length, 1);
			assert.ok(fs.existsSync(written[0]!));
			throw new Error("synthetic provider failure after the download");
		},
	]);
	const chat = chatStore.createChat("Synthetic PDF research failure");
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "failing-pdf-call", input: { question: "Read the synthetic paper" } });
	const steers: SteerMessage[] = [];
	await createJobRunner({ chatStore, jobStore, deliver: async (steer) => { steers.push(steer); } }).runJob(job.id);
	const failed = jobStore.getJob(job.id)!;
	assert.equal(failed.status, "error");
	assert.deepEqual(failed.delivery, { kind: "result", status: "pending" });
	assert.match((failed.result as ResearchResult).brief, /^Research failed: .*synthetic provider failure/);
	assert.equal(steers.length, 1);
	assert.equal(fs.existsSync(path.dirname(written[0]!)), false);
	assert.deepEqual(fs.readdirSync(scratch), []);
});

it("cancelling a research job after a PDF download records the abort and removes its download dir", async (t) => {
	readyForPdfResearch(t);
	installPublicHttp(t, { responses: [pdfReply] });
	const written = recordWrites(t);
	const chat = chatStore.createChat("Synthetic PDF research cancellation");
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "cancelled-pdf-call", input: { question: "Read the synthetic paper" } });
	const cancelled = ((_context: Ctx, options: { signal?: AbortSignal } | undefined) => new Promise<AssistantMessage>((resolve) => {
		assert.equal(written.length, 1);
		assert.ok(fs.existsSync(written[0]!));
		options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		assert.deepEqual(abortJob(job.id), { ok: true });
	})) as unknown as FauxResponseStep;
	researchModelOverride.current = engine([
		fauxAssistantMessage([fauxToolCall("web_fetch_pdf", { url: "https://public.example/paper.pdf" }, { id: "download" })], { stopReason: "toolUse" }),
		cancelled,
	]);
	await createJobRunner({ chatStore, jobStore, deliver: async () => { throw new Error("A cancelled job must not deliver a result"); } }).runJob(job.id);
	const aborted = jobStore.getJob(job.id)!;
	assert.equal(aborted.status, "error");
	assert.equal(aborted.error, "Aborted by learner");
	assert.equal(aborted.result, undefined);
	assert.deepEqual(aborted.delivery, { kind: "abort", status: "pending" });
	assert.equal(fs.existsSync(path.dirname(written[0]!)), false);
	assert.deepEqual(fs.readdirSync(scratch), []);
});
