/** Runtime check for browser session attachments: the REAL Next routes, real
 * text/image normalization and native PDF page rendering, with only the model
 * replaced by a synthetic OpenAI-compatible endpoint on 127.0.0.1.
 *
 * Phase 1 (normal mode): connect the fixture through /api/custom-provider
 * (image input comes from its /models metadata), pin the slots through
 * /api/settings/models, upload text + PNG + a two-page PDF through
 * /api/chats/:id/attachments, retry the same ids, send them through
 * /api/chat, then upload and send again from Chromium's real file picker.
 * Phase 2: stop the owned server, restart it on the same port and scratch
 * profile in trial mode (synthetic owner/origin; fake Tailscale headers), and
 * check the record, image endpoint, upload retry and browser previews are
 * identical, with zero new model calls.
 *
 * Requirements:
 * - Run from a DISPOSABLE source copy with no other dev server in it. The
 *   script refuses a checkout with .git or a symlinked node_modules (a symlink
 *   escapes Turbopack's root). Copy only git-controlled files, never a blanket
 *   copy (ignored files hold keys, records, uploads, backups), and hardlink the
 *   deps so no bytes are duplicated (same filesystem):
 *     copy=~/lh-attach-copy; mkdir "$copy"
 *     git archive HEAD | tar -x -C "$copy"         # a committed snapshot, or
 *     git ls-files -z -co --exclude-standard -- . ':!:.pi' | tar --null -T - -c | tar -x -C "$copy"
 *                                                  # tracked + unignored working tree
 *     cp -al node_modules "$copy/node_modules"
 *     cd "$copy" && LH_SMOKE_POLL=1 node scripts/smoke-session-attachments-runtime.mjs
 *   Delete "$copy" (including its .next) afterwards.
 * - Chromium (LH_TEST_CHROME, default /snap/bin/chromium). The scratch dir is
 *   under $HOME because snap Chromium has a private /tmp.
 *
 * Isolation: app HOME, data and auth are a fresh scratch dir; the app env is
 * an allowlist (no ambient keys, LH_IGNORE_ENV_KEYS=1); app, fixture and
 * browser use loopback only and the browser aborts any other origin. The
 * fixture key is synthetic. Ownership: the Next server is spawned detached and
 * only that process group is stopped (scripts/lib/owned-smoke-lifetime.mjs);
 * the scratch dir is removed on success and failure. The copy's .next is left
 * for the caller to delete; Turbopack's dev filesystem cache is off to keep it
 * small. Evidence (no file bytes) is written outside the
 * checkout to LH_SMOKE_EVIDENCE or ~/lh-attachment-runtime-evidence-*.json.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { stopOwnedSmokeServer } from "./lib/owned-smoke-lifetime.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (fs.existsSync(path.join(root, ".git"))) throw new Error("Run from a disposable source copy, not a git checkout (see the header).");
if (fs.lstatSync(path.join(root, "node_modules")).isSymbolicLink()) throw new Error("node_modules must be a hardlinked copy, not a symlink.");
const { tinyPdf } = await import("../tests/helpers/tiny-pdf.ts"); // Node's native type stripping
const chrome = process.env.LH_TEST_CHROME || "/snap/bin/chromium";
if (!fs.existsSync(chrome)) throw new Error(`No Chromium at ${chrome}; set LH_TEST_CHROME.`);

const scratch = fs.mkdtempSync(path.join(os.homedir(), "lh-attachments-runtime-"));
const home = path.join(scratch, "home");
const dataDir = path.join(scratch, "data");
const files = path.join(scratch, "files");
for (const dir of [home, dataDir, files]) fs.mkdirSync(dir);
const authFile = path.join(scratch, "auth.json");
fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
const evidenceFile = process.env.LH_SMOKE_EVIDENCE
	?? path.join(os.homedir(), `lh-attachment-runtime-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

function png(width, height, seed) {
	const chunk = (type, data) => {
		const buffer = Buffer.alloc(data.length + 12);
		buffer.writeUInt32BE(data.length);
		buffer.write(type, 4, "ascii");
		data.copy(buffer, 8);
		let crc = ~0;
		for (const byte of buffer.subarray(4, -4)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
		buffer.writeUInt32BE(~crc >>> 0, buffer.length - 4);
		return buffer;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
	header[8] = 8; header[9] = 2; // 8-bit RGB
	const rows = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) rows.push((x * 40 + seed) & 255, (y * 60) & 255, seed & 255);
	}
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const pngSize = bytes => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

const NOTES = "Synthetic notes: LH-TEXT-MARKER mitochondria.\n";
const PDF = Buffer.from(tinyPdf([
	{ runs: [{ text: "Synthetic PDF page one", x: 72, y: 700, size: 24 }] },
	{ runs: [{ text: "Second page, different words", x: 72, y: 500, size: 18 }], image: true },
]));
const BOARD = png(8, 6, 17);
const PICKED = png(5, 5, 200);
const fixture = {
	notes: path.join(files, "notes.txt"), board: path.join(files, "board.png"), pdf: path.join(files, "paper.pdf"),
	picked: path.join(files, "picked.png"), pickedText: path.join(files, "picked.md"),
};
fs.writeFileSync(fixture.notes, NOTES);
fs.writeFileSync(fixture.board, BOARD);
fs.writeFileSync(fixture.pdf, PDF);
fs.writeFileSync(fixture.picked, PICKED);
fs.writeFileSync(fixture.pickedText, "# Picked\n\nLH-PICKED-MARKER\n");

// ── Synthetic model endpoint: the only fake in this smoke ──
const KEY = "synthetic-attachment-runtime-key";
const MODEL = "fixture-vision";
const calls = [];
const unexpected = [];
const provider = http.createServer(async (req, res) => {
	try {
		assert.equal(req.headers.authorization, `Bearer ${KEY}`);
		if (req.method === "GET" && req.url === "/v1/models") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: MODEL, context_window: 65536, max_output_tokens: 4096, input_modalities: ["text", "image"] }] }));
			return;
		}
		assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
		let data = "";
		for await (const chunk of req) { data += chunk; assert(data.length < 20_000_000); }
		const body = JSON.parse(data);
		assert.equal(body.model, MODEL); assert.equal(body.stream, true);
		const system = body.messages.filter(m => m.role === "system" || m.role === "developer").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
		const parts = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]);
		const texts = parts.filter(p => p.type === "text").map(p => p.text);
		const images = parts.filter(p => p.type === "image_url").map(p => p.image_url.url);
		const tools = (body.tools ?? []).map(t => t.function?.name);
		let reply;
		if (system.startsWith("You transcribe one page of a PDF")) {
			const page = Number(texts.join("\n").match(/Page (\d+)\. Transcribe this page\./)?.[1]);
			assert(page > 0, "transcription request names its page");
			calls.push({ kind: "transcribe", page, tools, images, texts });
			reply = `# Fixture page ${page}\n\nLH-PDF-PAGE-${page}-MARKER`;
		} else if (!tools.some(name => /^submit_/.test(name))) {
			const n = calls.filter(c => c.kind === "teach").length + 1;
			calls.push({ kind: "teach", n, tools, images, texts });
			reply = `LH-TEACH-REPLY-${n}: the synthetic files arrived.`;
		} else throw new Error(`unexpected background request (tools ${tools.join(",")})`);
		res.setHeader("content-type", "text/event-stream");
		const frame = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
		frame({ role: "assistant", content: reply });
		frame({}, "stop", { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108 });
		res.end("data: [DONE]\n\n");
	} catch (err) {
		unexpected.push(String(err?.message ?? err).slice(0, 300));
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Unexpected fixture request" } }));
	}
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

// ── Isolated dev server (same conventions as smoke-session-attachments.mjs) ──
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(scratch, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const TRIAL_OWNER = "smoke-owner@example.invalid";
const TRIAL_ORIGIN = `https://127.0.0.1:${port}`; // Host matches the loopback address; never resolved
const baseEnv = {
	PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development",
	LH_DATA_DIR: dataDir, LH_AUTH_FILE: authFile, LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(scratch, "fonts.cjs"),
};
// Preloaded into this dev server only (next.config.ts is untouched): no
// Turbopack filesystem cache (hundreds of MB), and with LH_SMOKE_POLL=1 a
// polling watcher for hosts whose inotify budget is spent.
const preload = path.join(scratch, "next-config-overlay.cjs");
const overlay = `{ experimental: { ...loaded.experimental, turbopackFileSystemCacheForDev: false }${process.env.LH_SMOKE_POLL ? ", watchOptions: { pollIntervalMs: 5000 }" : ""} }`;
fs.writeFileSync(preload, `const config = require.resolve("next/dist/server/config", { paths: [${JSON.stringify(root)}] });
const real = require(config);
const load = real.default;
require.cache[config].exports = { ...real, __esModule: true, default: async (...args) => { const loaded = await load(...args); return { ...loaded, ...${overlay} }; } };
`);
baseEnv.NODE_OPTIONS = `--require ${preload}`;
if (process.env.LH_SMOKE_POLL) baseEnv.WATCHPACK_POLLING = "true";

let server;
let logs = "";
async function startApp(extraEnv = {}) {
	logs = "";
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: root, env: { ...baseEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true,
	});
	const capture = data => { logs = (logs + data).slice(-24000); };
	server.stdout.on("data", capture); server.stderr.on("data", capture);
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("app startup timed out")), 120000);
		const ready = () => { if (logs.includes("Ready in")) { clearTimeout(deadline); server.stdout.off("data", ready); resolve(); } };
		server.stdout.on("data", ready);
		server.once("exit", code => { clearTimeout(deadline); reject(new Error(`app exited ${code}`)); });
		ready();
	});
}
async function stopApp() {
	if (!server) return;
	const owned = server;
	server = undefined;
	await stopOwnedSmokeServer(owned, { graceMs: 5000, killMs: 5000 });
}

/** node:http, so trial checks can carry a Host-matched synthetic identity. */
let trialHeaders = null;
async function call(method, route, { json, form, headers = {}, timeout = 240000 } = {}) {
	let body;
	const sent = { ...(trialHeaders ?? {}) };
	if (method !== "GET") sent.origin = trialHeaders ? TRIAL_ORIGIN : origin;
	if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); sent["content-type"] = "application/json"; }
	if (form) {
		const encoded = new Response(form);
		sent["content-type"] = encoded.headers.get("content-type");
		body = Buffer.from(await encoded.arrayBuffer());
	}
	Object.assign(sent, headers);
	for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
	if (body) sent["content-length"] = String(body.length);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: sent, timeout }, res => {
			const chunks = [];
			res.on("data", chunk => chunks.push(chunk));
			res.on("end", () => {
				const bytes = Buffer.concat(chunks);
				resolve({ status: res.statusCode, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString("utf8")) });
			});
		});
		req.on("timeout", () => req.destroy(new Error(`${method} ${route} timed out`)));
		req.on("error", reject);
		req.end(body);
	});
}
async function ok(method, route, options) {
	const response = await call(method, route, options);
	assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${response.bytes.toString("utf8").slice(0, 400)}`);
	return response;
}
const chatJson = async id => (await ok("GET", `/api/chats/${id}`)).json();
async function settled(id) {
	const stream = await ok("GET", `/api/chats/${id}/stream`, { timeout: 120000 });
	assert.match(stream.bytes.toString("utf8"), /\[DONE\]/, "stream ends with [DONE]");
	for (let i = 0; i < 100; i++) {
		const chat = await chatJson(id);
		if (!chat.turnInFlight) {
			assert.equal(chat.turnError ?? null, null, `turn failed: ${JSON.stringify(chat.turnError)}`);
			assert(!chat.messages.some(m => m.stopReason === "error"), "fixture inference must succeed");
			return chat;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error("turn did not settle");
}
function uploadForm(entries) {
	const form = new FormData();
	for (const { id, file, type } of entries) {
		form.append("files", new Blob([fs.readFileSync(file)], { type }), path.basename(file));
		form.append("ids", id);
	}
	return form;
}
const durable = chat => ({ title: chat.title, attachments: chat.attachments, attachmentUsage: chat.attachmentUsage, messages: chat.messages });

let browser;
const checks = [];
const errors = [];
const external = [];
const evidence = { origin, providerBase, checks, calls: [], gaps: [] };
async function openBrowser(extraHeaders) {
	browser = await puppeteer.launch({
		executablePath: chrome, headless: true, userDataDir: fs.mkdtempSync(path.join(scratch, "browser-")),
		env: { PATH: process.env.PATH, HOME: os.homedir() }, // snap confinement needs the real HOME
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"],
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(120000);
	page.on("pageerror", err => errors.push(err.message));
	if (extraHeaders) await page.setExtraHTTPHeaders(extraHeaders);
	await page.setRequestInterception(true);
	const denied = [];
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.origin !== origin && !url.protocol.startsWith("blob") && !url.protocol.startsWith("data")) {
			external.push(url.origin);
			return request.abort().catch(() => {});
		}
		return request.continue().catch(() => {});
	});
	page.on("response", response => {
		const line = `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`;
		evidence.browserResponses = [...(evidence.browserResponses ?? []), line].slice(-60);
		if (response.status() === 403) denied.push(line);
	});
	page.on("console", message => { evidence.browserConsole = [...(evidence.browserConsole ?? []), message.text().slice(0, 300)].slice(-30); });
	return { page, denied };
}
async function closeBrowser() { await browser?.close(); browser = undefined; }
async function savedImagesRender(page, id, imageIds) {
	await page.waitForFunction(srcs => {
		const imgs = [...document.querySelectorAll('[data-testid="saved-session-attachments"] img')];
		return srcs.every(src => imgs.some(img => img.getAttribute("src") === src && img.complete && img.naturalWidth > 0));
	}, {}, imageIds.map(imageId => `/api/chats/${encodeURIComponent(id)}/attachments/${encodeURIComponent(imageId)}`));
	return page.$$eval('[data-testid="saved-session-attachments"] img', imgs => imgs.map(img => ({ src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight })));
}

try {
	// ══ Phase 1: fresh profile, normal mode ══
	await startApp();
	const empty = await (await ok("GET", "/api/chats")).json();
	assert.deepEqual(empty.chats, [], "fresh profile");
	const etag = (await ok("GET", "/api/custom-provider")).headers.etag;
	const connected = (await ok("POST", "/api/custom-provider", { json: { baseUrl: providerBase, authMode: "apiKey", key: KEY }, headers: { "if-match": etag } })).json();
	const discovered = connected.models.find(m => m.id === MODEL);
	assert.equal(discovered?.image, true, `discovery read image input: ${JSON.stringify(connected.models)}`);
	const catalog = (await ok("GET", "/api/models")).json();
	const catalogModel = catalog.models.find(m => m.provider === "custom" && m.id === MODEL);
	assert.ok(catalogModel?.input.includes("image"), "catalog model input includes image");
	const slot = { model: { provider: "custom", id: MODEL }, thinkingLevel: "off" };
	await ok("PUT", "/api/settings/models", { json: { strong: slot, cheap: slot, vision: slot } });
	checks.push("custom endpoint connected via /api/custom-provider; /models input_modalities → image:true; catalog input includes image; slots pinned via /api/settings/models");

	const { id } = (await ok("POST", "/api/chats", { json: { title: "Attachment runtime smoke" } })).json();
	const ids = { notes: "att_notes_1", board: "att_board_1", pdf: "att_pdf_1" };
	const entries = [
		{ id: ids.notes, file: fixture.notes, type: "text/plain" },
		{ id: ids.board, file: fixture.board, type: "image/png" },
		{ id: ids.pdf, file: fixture.pdf, type: "application/pdf" },
	];
	const prepared = (await ok("POST", `/api/chats/${id}/attachments`, { form: uploadForm(entries) })).json().attachments;
	assert.deepEqual(prepared.map(a => [a.id, a.kind, a.mimeType, a.name]), [
		[ids.notes, "text", "text/plain", "notes.txt"], [ids.board, "image", "image/png", "board.png"], [ids.pdf, "pdf", "application/pdf", "paper.pdf"],
	]);
	assert.deepEqual(prepared.map(a => a.size), [Buffer.byteLength(NOTES), BOARD.length, PDF.length]);
	const pages = calls.filter(c => c.kind === "transcribe");
	assert.deepEqual(pages.map(c => c.page), [1, 2], "one transcription call per page, in order");
	assert.equal(calls.length, 2, "text and image preparation call no model");
	const renders = pages.map(c => {
		assert.equal(c.images.length, 1, "each page call carries one image");
		assert.deepEqual(c.tools, [], "transcription has no tools");
		const [, mime, b64] = c.images[0].match(/^data:(image\/\w+);base64,(.+)$/);
		assert.equal(mime, "image/png");
		const bytes = Buffer.from(b64, "base64");
		const size = pngSize(bytes);
		assert.ok(Math.abs(size.width / size.height - 612 / 792) < 0.01 && size.width >= 600, `page render looks like US Letter: ${JSON.stringify(size)}`);
		return { page: c.page, ...size, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	});
	assert.notEqual(renders[0].sha256, renders[1].sha256, "the two pages rendered differently");
	evidence.pageRenders = renders;
	checks.push(`PDF: native render of both pages reached the model as PNG (${renders.map(r => `${r.width}x${r.height}`).join(", ")}), one call per page, no tools`);

	const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${id}.json`), "utf8"));
	const pdfAtt = stored.attachments[ids.pdf];
	assert.equal(pdfAtt.text, "--- Page 1 ---\n\n# Fixture page 1\n\nLH-PDF-PAGE-1-MARKER\n\n--- Page 2 ---\n\n# Fixture page 2\n\nLH-PDF-PAGE-2-MARKER");
	assert.equal(pdfAtt.image, undefined);
	assert.equal(stored.attachments[ids.notes].text, NOTES);
	const boardImage = stored.attachments[ids.board].image;
	assert.equal(boardImage.mimeType, "image/png");
	const normalized = Buffer.from(boardImage.data, "base64");
	assert.deepEqual(pngSize(normalized), { width: 8, height: 6 });
	const raw = JSON.stringify(stored);
	for (const needle of [PDF.toString("base64").slice(0, 64), PDF.toString("latin1").slice(0, 40), "%PDF-"]) assert.ok(!raw.includes(needle), "original PDF bytes are not retained");
	assert.equal(stored.attachmentUsage.length, 1);
	const usage = stored.attachmentUsage[0];
	assert.equal(usage.attachmentId, ids.pdf);
	assert.equal(usage.model, `custom:${MODEL}`);
	assert.deepEqual(usage.steps.map(s => [s.inputTokens, s.outputTokens]), [[101, 7], [101, 7]]);
	checks.push("record: text verbatim, PDF page-marked Markdown + one usage entry with two steps, normalized image snapshot, no original PDF bytes");

	const imageRoute = `/api/chats/${id}/attachments/${ids.board}`;
	const served = await ok("GET", imageRoute);
	assert.equal(served.headers["content-type"], "image/png");
	assert.equal(served.headers["x-content-type-options"], "nosniff");
	assert.equal(served.headers["cache-control"], "private, no-store");
	assert.ok(served.bytes.equals(normalized), "image route serves the stored normalized bytes");
	for (const route of [`/api/chats/${id}/attachments/${ids.notes}`, `/api/chats/${id}/attachments/${ids.pdf}`, `/api/chats/${id}/attachments/missing`, `/api/chats/chat_nope/attachments/${ids.board}`]) {
		assert.equal((await call("GET", route)).status, 404, `${route} is not served`);
	}
	checks.push("image route: stored bytes, nosniff, private no-store; text/PDF/unknown ids and other chats 404");

	const before = calls.length;
	const retried = (await ok("POST", `/api/chats/${id}/attachments`, { form: uploadForm(entries) })).json().attachments;
	assert.deepEqual(retried, prepared);
	assert.equal(calls.length, before, "retry with known ids calls no model");
	assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${id}.json`), "utf8")).attachmentUsage.length, 1);
	checks.push("upload retry with the same ids reused the prepared attachments: no model call, no new usage");

	await ok("POST", "/api/chat", { json: { chatId: id, input: { type: "text", text: "Explain these files", attachmentIds: [ids.notes, ids.board, ids.pdf] } } });
	let chat = await settled(id);
	const teach1 = calls.filter(c => c.kind === "teach");
	assert.equal(teach1.length, 1);
	const joined = teach1[0].texts.join("\n");
	for (const needle of ["Explain these files", "[Attached file: notes.txt]", "LH-TEXT-MARKER", "[Attached PDF: paper.pdf, transcribed page by page]", "LH-PDF-PAGE-1-MARKER", "LH-PDF-PAGE-2-MARKER", "[Attached image: board.png]"]) {
		assert.ok(joined.includes(needle), `teaching request carries ${needle}`);
	}
	assert.deepEqual(teach1[0].images, [`data:image/png;base64,${boardImage.data}`], "teaching request carries the normalized image");
	const user = chat.messages.find(m => m.role === "user" && m.sessionAttachments);
	assert.deepEqual(user.sessionAttachments.map(a => a.id), [ids.notes, ids.board, ids.pdf]);
	assert.ok(JSON.stringify(chat.messages).includes("LH-TEACH-REPLY-1"));
	checks.push("send: /api/chat with ids → model got user text, text file, PDF transcription and the image natively; reply saved");

	// Browser on the real app: saved preview, then real picker upload + send.
	let { page } = await openBrowser();
	await page.goto(`${origin}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 240000 });
	await page.waitForSelector("[data-session-attachment-input]", { timeout: 240000 });
	evidence.browserPreviewPhase1 = await savedImagesRender(page, id, [ids.board]);
	checks.push("browser: saved image preview loaded from the real image route");
	const uploadResponses = [];
	// Hydrated: the client enables the browser picker. Typing earlier is lost to hydration.
	await page.waitForFunction(() => {
		const button = document.querySelector('[data-testid="attach-files"]');
		const input = document.querySelector("[data-session-attachment-input]");
		const hydrated = node => Boolean(node) && Object.keys(node).some(key => key.startsWith("__reactProps$"));
		return button?.getAttribute("aria-disabled") === "false" && hydrated(button) && hydrated(input);
	});
	await page.waitForNetworkIdle({ idleTime: 1500, concurrency: 2, timeout: 120000 }); // the events stream stays open
	page.on("response", response => {
		if (/\/api\/chats\/[^/]+\/attachments$/.test(new URL(response.url()).pathname) && response.request().method() === "POST") uploadResponses.push(response.status());
	});
	await page.evaluate(() => {
		const input = document.querySelector("[data-session-attachment-input]");
		input.textContent = "Browser follow-up";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="attach-files"]')]);
	await chooser.accept([fixture.pickedText, fixture.picked]);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-attachments"] li').length === 2);
	const sendSelector = '[data-testid="composer"] button[aria-label="Send"]';
	await page.waitForFunction(selector => { const b = document.querySelector(selector); return b && !b.disabled; }, {}, sendSelector);
	const beforeBrowser = calls.length;
	await page.click(sendSelector);
	await page.waitForFunction(() => document.body.innerText.includes("LH-TEACH-REPLY-2"), { timeout: 120000 });
	chat = await settled(id);
	assert.deepEqual(uploadResponses, [200], "one real upload from the picker");
	assert.equal(calls.length, beforeBrowser + 1, "picker text + image need no preparation call; one teaching call");
	const teach2 = calls.at(-1);
	assert.ok(teach2.texts.join("\n").includes("LH-PICKED-MARKER"));
	const pickedAtt = Object.values(chat.attachments).find(a => a.name === "picked.png");
	assert.ok(teach2.images.includes(`data:image/png;base64,${pickedAtt.image.data}`), "browser-uploaded image reached the model");
	evidence.browserPreviewAfterSend = await savedImagesRender(page, id, [ids.board, pickedAtt.id]);
	checks.push("browser: real picker upload (md + png) through the real route, Send → model saw both; live preview from the image route");
	await closeBrowser();

	const snapshot = durable(chat);
	const imageIds = Object.values(chat.attachments).filter(a => a.kind === "image").map(a => a.id);
	const imageBytes = Object.fromEntries(await Promise.all(imageIds.map(async imageId => [imageId, (await ok("GET", `/api/chats/${id}/attachments/${imageId}`)).bytes])));
	const callsBeforeRestart = calls.length;
	await stopApp();

	// ══ Phase 2: restart the same profile and port, trial mode ══
	await startApp({ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: TRIAL_OWNER, LH_SERVER_TRIAL_ORIGIN: TRIAL_ORIGIN });
	assert.equal((await call("GET", `/api/chats/${id}`)).status, 403, "trial: no identity is denied");
	assert.equal((await call("GET", `/api/chats/${id}`, { headers: { "tailscale-user-login": "someone@example.invalid" } })).status, 403, "trial: wrong owner is denied");
	trialHeaders = { "tailscale-user-login": TRIAL_OWNER, "x-forwarded-proto": "https", "x-forwarded-host": `127.0.0.1:${port}` };
	assert.equal((await call("POST", `/api/chats/${id}/attachments`, { form: uploadForm(entries), headers: { origin } })).status, 403, "trial: wrong-origin upload denied");
	assert.equal((await call("GET", `/api/chats/${id}/attachments/${ids.board}`, { headers: { "tailscale-user-login": undefined } })).status, 403, "trial: image route needs identity");
	checks.push("restart in trial mode: missing/wrong identity and wrong-origin upload are 403, including the image route");

	const restarted = await chatJson(id);
	assert.deepEqual(durable(restarted), snapshot, "record identical after restart");
	for (const [imageId, bytes] of Object.entries(imageBytes)) {
		assert.ok((await ok("GET", `/api/chats/${id}/attachments/${imageId}`)).bytes.equals(bytes), `image ${imageId} identical after restart`);
	}
	const retriedAfter = (await ok("POST", `/api/chats/${id}/attachments`, { form: uploadForm(entries) })).json().attachments;
	assert.deepEqual(retriedAfter, prepared);
	assert.deepEqual(durable(await chatJson(id)), snapshot, "upload retry after restart changed nothing");
	checks.push("restart: identical record, attachments, usage and image bytes via trial headers; upload retry reused ids");

	// What Tailscale Serve supplies; without x-forwarded-proto Next fills in http and the gate refuses.
	const trialBrowser = await openBrowser(trialHeaders);
	page = trialBrowser.page;
	const denied = trialBrowser.denied;
	const navigation = await page.goto(`${origin}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 240000 });
	assert.equal(navigation.status(), 200, `trial page load: ${await navigation.text().catch(() => "")}`);
	await page.waitForSelector('[data-testid="saved-session-attachments"]', { timeout: 240000 });
	evidence.browserPreviewAfterRestart = await savedImagesRender(page, id, imageIds);
	const pageText = await page.evaluate(() => document.body.innerText);
	for (const needle of ["notes.txt", "paper.pdf", "board.png", "picked.png", "picked.md", "LH-TEACH-REPLY-1", "LH-TEACH-REPLY-2"]) assert.ok(pageText.includes(needle), `restarted page shows ${needle}`);
	evidence.browserTrialDenied = denied;
	await closeBrowser();
	checks.push("restart: Chromium (synthetic trial identity) rendered saved names, replies and every image preview from the real route");

	assert.equal(calls.length, callsBeforeRestart, "no model call after restart (reads, retry, browser)");
	assert.deepEqual(unexpected, [], "no unexpected provider requests");
	assert.deepEqual(external, [], "no external browser requests");
	assert.deepEqual(errors, [], "no page errors");
	evidence.calls = calls.map(c => ({ kind: c.kind, page: c.page, tools: c.tools.length, images: c.images.length }));
	fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify({ result: "pass", checks, modelCalls: evidence.calls, trialDeniedInBrowser: denied, evidence: evidenceFile }, null, 2));
} catch (err) {
	console.error(err);
	evidence.failure = String(err?.stack ?? err);
	evidence.calls = calls.map(c => ({ kind: c.kind, page: c.page, tools: c.tools.length, images: c.images.length }));
	Object.assign(evidence, { unexpected, external, errors, logs });
	try { fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)); console.error(`evidence: ${evidenceFile}`); } catch { /* best effort */ }
	console.error(logs);
	process.exitCode = 1;
} finally {
	await closeBrowser().catch(() => {});
	await stopApp().catch(err => { console.error(err); process.exitCode = 1; });
	provider.close();
	// Next spawns a detached telemetry flush outside the owned group that can
	// recreate HOME/.config after the server exits (its post is capped at 5 s):
	// remove until it stays gone for 10 s.
	for (let quiet = 0, tries = 0; quiet < 10 && tries < 60; tries++) {
		if (fs.existsSync(scratch)) { quiet = 0; fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
		else quiet++;
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	if (fs.existsSync(scratch)) { console.error(`scratch dir survived cleanup: ${scratch}`); process.exitCode = 1; }
}
