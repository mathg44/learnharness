/** Server research PDFs through real tools, native PDF parsing and controlled
 * public HTTP sockets. Production readiness stays off. No live providers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { installPublicHttp } from "./helpers/public-http.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-pdf-test-"));
const saved = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE"].map((key) => [key, process.env[key]]));
const home = path.join(profile, "home");
fs.mkdirSync(home);
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"), LH_SERVER_MODE: "tailscale" });
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
const { SERVER_CAPABILITIES } = await import("../src/core/server-capabilities.ts");
const { createPdfReadTools } = await import("../src/agent/tools/pdf-read.ts");
const { realHeadless } = await import("../src/agent/subagents/headless.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

beforeEach(() => { process.env.LH_SERVER_MODE = "tailscale"; });
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
function toolsForJob() {
	const dir = fs.mkdtempSync(path.join(profile, "downloads-"));
	return { dir, tools: createPdfReadTools(dir) };
}

it("a researcher downloads a public PDF, reads cited pages, searches and renders natively", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [
		{ status: 302, headers: { location: "https://papers.example/final.pdf" } },
		{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) },
	] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Ambient fetch and reader fallbacks forbidden"); });
	const { dir, tools } = toolsForJob();
	const result = await tools.web_fetch_pdf!.execute!("download", { url: "https://public.example/paper.pdf" });
	const summary = result.details as { path: string; url: string; page_count: number };
	assert.equal(summary.page_count, 2);
	assert.equal(summary.url, "https://papers.example/final.pdf");
	const extracted = await tools.pdf_extract!.execute!("extract", { path: summary.path, pages: "2" });
	assert.match(String(extracted.details), /--- Page 2 ---\n.*orthogonal complement theorem/);
	assert.doesNotMatch(String(extracted.details), /Synthetic research paper/);
	const search = await tools.pdf_search!.execute!("search", { path: summary.path, query: "theorem" });
	assert.match(JSON.stringify(search.details), /"page":2/);
	const rendered = await realHeadless.renderPdfPages(path.resolve(dir, summary.path), [2], { dpi: 72 });
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0]!.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(fixture.connections.length, 2);
});

it("denied PDF destinations and redirects never use a fallback or disclose URL credentials", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [
		{ status: 302, headers: { location: "http://169.254.169.254/fixture-private-path" } },
	] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("No fallback permitted"); });
	const { dir, tools } = toolsForJob();
	for (const url of [
		"http://127.1/fixture-private-path", "http://2130706433/", "http://[::ffff:127.0.0.1]/",
		"https://fixture-user:fixture-password@public.example/paper.pdf", "https://public.example/redirect.pdf",
	]) {
		const result = await tools.web_fetch_pdf!.execute!("denied", { url });
		assert.match(String(result.details), /web_fetch_pdf failed:/);
		assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password|fixture-private-path/);
	}
	assert.equal(fixture.connections.length, 1);
	assert.deepEqual(fs.readdirSync(dir), []);
});

it("server PDF tools reopen only their own downloads, not pre-existing files or symlink escapes", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	installPublicHttp(t, { responses: [{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) }] });
	const { dir, tools } = toolsForJob();
	const outside = path.join(profile, "fixture-private-file.pdf");
	fs.writeFileSync(outside, bytes);
	fs.writeFileSync(path.join(dir, "pre-existing.pdf"), bytes);
	fs.symlinkSync(outside, path.join(dir, "alias.pdf"));
	for (const name of ["pdf_info", "pdf_extract", "pdf_search"]) {
		for (const file of [outside, "../fixture-private-file.pdf", "pre-existing.pdf", "alias.pdf"]) {
			const result = await tools[name]!.execute!("not-owned", { path: file, pages: "1", query: "theorem" });
			assert.match(String(result.details), /only PDFs downloaded by this research job/);
			assert.doesNotMatch(JSON.stringify(result), /fixture-private-file/);
		}
	}
	const download = await tools.web_fetch_pdf!.execute!("owned", { url: "https://public.example/owned.pdf" });
	const file = path.resolve(dir, (download.details as { path: string }).path);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	fs.unlinkSync(file);
	fs.symlinkSync(outside, file);
	assert.match(String((await tools.pdf_info!.execute!("replaced", { path: file })).details), /only PDFs downloaded by this research job/);
});

it("each research job retains at most four successful downloads and removes rejected PDFs", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const longPdf = tinyPdf(Array.from({ length: 1_001 }, () => ({})));
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-type": "application/pdf" }, body: "not a PDF" },
		{ headers: { "content-type": "application/pdf" }, body: Buffer.from(longPdf) },
		...Array.from({ length: 4 }, () => ({ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) })),
	] });
	const { dir, tools } = toolsForJob();
	const download = () => tools.web_fetch_pdf!.execute!("download", { url: "https://public.example/paper.pdf" });
	assert.match(String((await download()).details), /not a readable PDF/);
	assert.deepEqual(fs.readdirSync(dir), []);
	assert.match(String((await download()).details), /1,000 pages/);
	assert.deepEqual(fs.readdirSync(dir), []);
	for (let i = 0; i < 4; i++) assert.equal(((await download()).details as { page_count: number }).page_count, 2);
	assert.match(String((await download()).details), /four PDF downloads/);
	assert.equal(fs.readdirSync(dir).length, 4);
	assert.equal(fixture.connections.length, 6);
});

it("cancelled downloads stop their sockets and remove files even when cancellation arrives after writing", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const controller = new AbortController();
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-type": "application/pdf", "content-length": "10000" }, body: "partial", stallBody: true, onRequest: () => setImmediate(() => controller.abort()) },
		{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) },
	] });
	const { dir, tools } = toolsForJob();
	const first = await tools.web_fetch_pdf!.execute!("cancel-body", { url: "https://public.example/slow.pdf" }, controller.signal);
	assert.match(String(first.details), /cancelled/);
	assert.ok(fixture.sockets[0]!.destroyed);
	assert.deepEqual(fs.readdirSync(dir), []);

	const io = await import("node:fs/promises");
	const afterWrite = new AbortController();
	const write = io.default.writeFile;
	t.mock.method(io.default, "writeFile", async (...args: Parameters<typeof write>) => {
		await write(...args);
		afterWrite.abort();
	});
	const second = await tools.web_fetch_pdf!.execute!("cancel-file", { url: "https://public.example/paper.pdf" }, afterWrite.signal);
	assert.match(String(second.details), /cancelled/);
	assert.deepEqual(fs.readdirSync(dir), []);
});

it("all server PDF text results stay within 40,000 characters", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const long = tinyPdf(Array.from({ length: 24 }, () => ({
		runs: Array.from({ length: 80 }, (_, line) => ({ text: "Synthetic source sentence.", x: 72, y: 720 - line * 8 })),
	})));
	installPublicHttp(t, { responses: [{ headers: { "content-type": "application/pdf" }, body: Buffer.from(long) }] });
	const { tools } = toolsForJob();
	const downloaded = await tools.web_fetch_pdf!.execute!("long", { url: "https://public.example/paper.pdf" });
	const file = (downloaded.details as { path: string }).path;
	const extracted = await tools.pdf_extract!.execute!("long-extract", { path: file, pages: "all" });
	const searched = await tools.pdf_search!.execute!("long-search", { path: file, query: "source" });
	for (const result of [extracted, searched]) {
		const output = result.content.map((part) => part.type === "text" ? part.text : "").join("");
		assert.ok(output.length <= 40_000);
		assert.match(output, /Truncated at 40000 characters/);
	}
});

it("DNS changes, mixed answers and mismatched socket peers cannot redirect a PDF download privately", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	let lookups = 0;
	const fixture = installPublicHttp(t, {
		lookup: () => ++lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.1", family: 4 }],
		responses: [{ status: 302, headers: { location: "/second.pdf" } }],
	});
	const { tools } = toolsForJob();
	assert.match(String((await tools.web_fetch_pdf!.execute!("rebind", { url: "https://public.example/first.pdf" })).details), /Destination denied/);
	assert.equal(fixture.connections.length, 1);
	assert.equal(lookups, 2);
});

it("public IPv6 PDFs succeed while mixed DNS and private connected peers fail before HTTP", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const fixture = installPublicHttp(t, {
		lookup: (hostname) => hostname === "mixed.example"
			? [{ address: "93.184.216.34", family: 4 }, { address: "fd7a:115c:a1e0::1", family: 6 }]
			: [{ address: "93.184.216.34", family: 4 }],
		responses: [
			{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) },
			{ peer: "127.0.0.1" },
		],
	});
	const { tools } = toolsForJob();
	const ok = await tools.web_fetch_pdf!.execute!("v6", { url: "https://[2606:4700:4700::1111]/paper.pdf" });
	assert.equal((ok.details as { page_count: number }).page_count, 2);
	assert.equal(fixture.connections[0]!.family, 6);
	for (const url of ["https://mixed.example/paper.pdf", "https://peer.example/paper.pdf"]) {
		assert.match(String((await tools.web_fetch_pdf!.execute!("denied", { url })).details), /Destination denied/);
	}
	assert.equal(fixture.connections.length, 2);
	assert.equal(fixture.requests.length, 1);
});

it("oversized declared, chunked and decompressed PDFs are bounded before creating files", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	const { gzipSync } = await import("node:zlib");
	const oversized = 25 * 1024 * 1024 + 1;
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-type": "application/pdf", "content-length": String(oversized) }, body: "partial" },
		{ raw: `HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nTransfer-Encoding: chunked\r\n\r\n${oversized.toString(16)}\r\n${"x".repeat(oversized)}\r\n0\r\n\r\n` },
		{ headers: { "content-type": "application/pdf", "content-encoding": "gzip" }, body: gzipSync("x".repeat(oversized)) },
	] });
	const { dir, tools } = toolsForJob();
	for (let i = 0; i < 3; i++) {
		const result = await tools.web_fetch_pdf!.execute!("oversized", { url: "https://public.example/paper.pdf" });
		assert.match(String(result.details), /PDF too large/);
		assert.deepEqual(fs.readdirSync(dir), []);
	}
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

it("HTTP and filesystem failures never expose response secrets or private paths", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	installPublicHttp(t, { responses: [
		{ status: 403, body: "fixture-secret-response" },
		{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) },
	] });
	const { tools } = toolsForJob();
	const forbidden = await tools.web_fetch_pdf!.execute!("http", { url: "https://public.example/paper.pdf" });
	assert.match(String(forbidden.details), /HTTP 403/);
	assert.doesNotMatch(JSON.stringify(forbidden), /fixture-secret-response/);
	const io = await import("node:fs/promises");
	t.mock.method(io.default, "realpath", () => { throw new Error("fixture-private-storage-path"); });
	const failed = await tools.web_fetch_pdf!.execute!("disk", { url: "https://public.example/paper.pdf" });
	assert.match(String(failed.details), /could not be downloaded or read/);
	assert.doesNotMatch(JSON.stringify(failed), /fixture-private-storage-path/);
});

it("a cleanup failure reports a safe tool error instead of exposing a filesystem exception", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	installPublicHttp(t, { responses: [{ headers: { "content-type": "application/pdf" }, body: "not a readable document" }] });
	const { tools } = toolsForJob();
	const io = await import("node:fs/promises");
	t.mock.method(io.default, "rm", () => { throw new Error("fixture-private-cleanup-path"); });
	const result = await tools.web_fetch_pdf!.execute!("cleanup-error", { url: "https://public.example/paper.pdf" });
	assert.match(String(result.details), /temporary PDF cleanup failed/);
	assert.doesNotMatch(JSON.stringify(result), /fixture-private-cleanup-path/);
});

it("PDF downloading uses the approved 60-second tool and network ceilings", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	installPublicHttp(t, { responses: [{ headers: { "content-type": "application/pdf" }, body: Buffer.from(bytes) }] });
	const deadlines: number[] = [];
	const timer = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof timer>) => {
		if (typeof args[1] === "number") deadlines.push(args[1]);
		return timer(...args);
	});
	const { tools } = toolsForJob();
	const result = await tools.web_fetch_pdf!.execute!("deadline", { url: "https://public.example/paper.pdf" });
	assert.equal((result.details as { page_count: number }).page_count, 2);
	assert.equal(deadlines.filter((ms) => ms === 60_000).length, 2);
	assert.ok(!deadlines.includes(30_000));
});

it("making researcher PDFs ready never grants local-file PDF dispatch or direct reader access", async (t) => {
	t.mock.method(SERVER_CAPABILITIES.pdf, "ready", () => true);
	t.mock.method(SERVER_CAPABILITIES.research, "ready", () => true);
	const fixture = installPublicHttp(t, { responses: [] });
	const privateFile = path.join(profile, "not-approved.pdf");
	fs.writeFileSync(privateFile, bytes);
	const chat = chatStore.createChat("Synthetic PDF file boundary");
	const ctx = { chatId: chat.id, chatStore, jobStore, deliver: () => {}, spawn: () => { throw new Error("Must not spawn a local reader"); } };
	for (const registry of [createTeacherTools(ctx), createProberTools(ctx)]) {
		assert.ok(registry.research);
		assert.equal(registry.pdf, undefined);
	}
	const result = await jobTools(ctx).pdf!.execute!("local", { path: privateFile, question: "Read it" });
	assert.equal(result.isError, true);
	const direct = await runPdfReaderAgent({ path: privateFile, question: "Read it" }, { engine: { get model(): never { throw new Error("No model access"); }, streamFn: () => { throw new Error("No provider access"); } } });
	assert.match(direct.brief, /not available on this server/);
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "old-local", input: { path: privateFile, question: "Read it" } });
	await createJobRunner({ chatStore, jobStore, engineFor: () => { throw new Error("No provider access"); }, deliver: async () => {} }).runJob(job.id);
	assert.equal(jobStore.getJob(job.id)!.status, "error");
	assert.match(JSON.stringify(jobStore.getJob(job.id)!.result), /not available on this server/);
	assert.deepEqual(fixture.connections, []);
});
