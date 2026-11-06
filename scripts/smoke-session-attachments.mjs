/** Live browser check for browser session attachments (Chromium + isolated
 * Next dev). No model/provider calls: the catalog, /api/chat, attachment
 * preparation, attachment images and streams are intercepted. App HOME,
 * data and auth are throwaway; the browser profile is fresh. Only synthetic
 * session records are created, under the scratch dir.
 *
 * The scratch dir lives under $HOME (not /tmp) because snap Chromium has a
 * private /tmp and only sees non-hidden home paths for file uploads.
 * Run: LH_TEST_CHROME=/snap/bin/chromium node scripts/smoke-session-attachments.mjs
 * LH_SMOKE_ONLY=opening or LH_SMOKE_ONLY=saved-lost-ack runs a short subset.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.homedir(), "lh-attachments-smoke-"));
const home = path.join(scratch, "home");
const dataDir = path.join(scratch, "data");
const files = path.join(scratch, "files");
for (const dir of [home, dataDir, files]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(scratch, "auth.json"), "{}\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fixture = {
	text: path.join(files, "notes.txt"),
	pdf: path.join(files, "paper.pdf"),
};
fs.writeFileSync(fixture.text, "synthetic notes\n");
fs.writeFileSync(fixture.pdf, "%PDF-1.4\n% synthetic, never transcribed\n%%EOF\n");

const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(scratch, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
// Whitelisted env only: no ambient provider keys or credentials reach the app.
const env = {
	PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development",
	LH_DATA_DIR: dataDir, LH_AUTH_FILE: path.join(scratch, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(scratch, "fonts.cjs"),
};
// Hosts whose inotify budget is spent (editor watchers) can't start Turbopack's
// recursive watcher. LH_SMOKE_POLL=1 preloads, into this dev server only, a
// wrapper adding watchOptions.pollIntervalMs to the loaded config (next.config.ts
// itself is untouched; Next's router re-reads it from disk, ignoring `conf`).
if (process.env.LH_SMOKE_POLL) {
	const preload = path.join(scratch, "poll-watch.cjs");
	fs.writeFileSync(preload, `const config = require.resolve("next/dist/server/config", { paths: [${JSON.stringify(root)}] });
const real = require(config);
const load = real.default;
require.cache[config].exports = { ...real, __esModule: true, default: async (...args) => ({ ...(await load(...args)), watchOptions: { pollIntervalMs: 5000 } }) };
`);
	env.NODE_OPTIONS = `--require ${preload}`;
	env.WATCHPACK_POLLING = "true"; // Next's app-dir route discovery watcher

}
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
	// Own process group: Next's workers must die with it, or they write into
	// the scratch HOME after cleanup.
	cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let logs = "";
const capture = data => { logs = (logs + data).slice(-24000); };
server.stdout.on("data", capture); server.stderr.on("data", capture);
let browser;
let page;
const errors = [];
const checks = [];
const gaps = [];
// LH_SMOKE_ONLY=opening: just the attachment-only and text+files openings.
const only = process.env.LH_SMOKE_ONLY;
try {
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("app startup timed out")), 90000);
		const ready = () => { if (logs.includes("Ready in")) { clearTimeout(deadline); server.stdout.off("data", ready); resolve(); } };
		server.stdout.on("data", ready);
		server.once("exit", code => { clearTimeout(deadline); reject(new Error(`app exited ${code}`)); });
		ready();
	});
	browser = await puppeteer.launch({
		executablePath: process.env.LH_TEST_CHROME || "/snap/bin/chromium",
		headless: true, userDataDir: path.join(scratch, "browser"),
		// Snap Chromium needs the real HOME for its own confinement; nothing else is passed.
		env: { PATH: process.env.PATH, HOME: os.homedir() },
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"],
	});
	await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
	page = await browser.newPage();
	page.setDefaultTimeout(60000);
	page.on("pageerror", err => errors.push(err.message));
	// Observation only: records what the composer put in each upload body.
	await page.evaluateOnNewDocument(() => {
		const original = window.fetch;
		window.__lhUploads = [];
		window.fetch = function (input, init) {
			const url = new URL(typeof input === "string" ? input : input.url, location.href);
			if (/\/attachments$/.test(url.pathname) && init?.body instanceof FormData) {
				window.__lhUploads.push({
					path: url.pathname,
					ids: init.body.getAll("ids"),
					files: init.body.getAll("files").map(file => ({ name: file.name, type: file.type, size: file.size })),
				});
			}
			return original.apply(this, arguments);
		};
	});
	const model = { id: "synthetic", name: "Synthetic (no calls)", provider: "fixture", input: ["text", "image"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	const catalog = { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null,
		slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
	const posts = [];
	const creates = [];
	const uploads = [];
	const aborts = [];
	const imageGets = [];
	const infos = new Map();
	const external = [];
	let uploadMode = "ok";
	let chatMode = "accepted";
	// saved-lost-ack: the server saved the input, then the acknowledgment
	// was lost. heldChats parks those POSTs until the check releases them.
	let holdChat = false;
	const heldChats = [];
	let held = [];
	let createMode = "ok";
	const heldCreates = [];
	const heldUploads = [];
	const kindOf = type => type.startsWith("image/") ? ["image", "image/png"] : type === "application/pdf" ? ["pdf", "application/pdf"] : ["text", "text/plain"];
	function prepare(sent) {
		return sent.ids.map((id, index) => {
			const file = sent.files[index];
			const [kind, mimeType] = kindOf(file.type);
			const info = infos.get(id) ?? { id, name: file.name, kind, mimeType, size: file.size };
			infos.set(id, info);
			return info;
		});
	}
	function saveAccepted(chatId, input) {
		// Synthetic canonical record: the real GET/RSC project it like a server-admitted send.
		const file = path.join(dataDir, "chats", `${chatId}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		const attached = (input.attachmentIds ?? []).map(id => infos.get(id));
		assert.ok(attached.every(Boolean), "sent ids were prepared first");
		record.messages.push({
			id: `saved_${record.messages.length}`, role: "user", timestamp: Date.now(),
			content: [{ type: "text", text: input.text || "(attachments)" }],
			...(attached.length ? { sessionAttachments: attached, userText: input.text } : {}),
		});
		fs.writeFileSync(file, JSON.stringify(record));
	}
	await page.setRequestInterception(true);
	page.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.origin !== origin) { external.push(url.origin); await request.abort(); return; }
			const pathname = url.pathname;
			const respond = (body, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
			if (pathname === "/api/models") return await respond(catalog);
			if (pathname === "/api/events") return await request.respond({ status: 204 });
			if (pathname.includes("abort")) { aborts.push(pathname); return await respond({ ok: true }); }
			const upload = pathname.match(/^\/api\/chats\/([^/]+)\/attachments$/);
			if (upload && request.method() === "POST") {
				const sent = await page.evaluate(() => window.__lhUploads.at(-1));
				assert.equal(sent.path, pathname);
				uploads.push({ chatId: upload[1], ...sent });
				if (uploadMode === "held") { heldUploads.push({ request, sent }); return; }
				if (uploadMode === "fail-once") { uploadMode = "ok"; return await respond({ error: "Synthetic preparation failure." }, 500); }
				return await respond({ attachments: prepare(sent) });
			}
			const image = pathname.match(/^\/api\/chats\/([^/]+)\/attachments\/([^/]+)$/);
			if (image && request.method() === "GET") {
				imageGets.push(pathname);
				return await request.respond({ status: 200, contentType: "image/png", body: PNG });
			}
			if (pathname === "/api/chat") {
				const body = JSON.parse(request.postData()); posts.push(body);
				if (chatMode === "lost-ack") return await request.abort("failed");
				if (chatMode === "saved-lost-ack") {
					if (holdChat) { heldChats.push({ request, body }); return; }
					saveAccepted(body.chatId, body.input);
					return await request.abort("failed");
				}
				if (chatMode === "refused") return await respond({ code: "models_not_configured", missing: ["strong"] }, 503);
				saveAccepted(body.chatId, body.input);
				return await respond({ ok: true });
			}
			if (/^\/api\/chats\/[^/]+\/stream$/.test(pathname)) { held.push(request); return; }
			if (pathname === "/api/chats" && request.method() === "POST") {
				creates.push(JSON.parse(request.postData()));
				if (createMode === "held") { heldCreates.push(request); return; }
			}
			await request.continue();
		} catch (err) { if (!/Target closed|Session closed|Invalid InterceptionId|Request is already handled/.test(String(err))) errors.push(String(err)); }
	});

	const sendSelector = 'button[aria-label="Start session"], [data-testid="composer"] button[aria-label="Send"]';
	async function open(route) {
		await Promise.all(held.splice(0).map(request => request.abort("aborted").catch(() => {})));
		await page.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 180000 });
		await page.waitForSelector("[data-session-attachment-input]", { timeout: 180000 });
		await page.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"]') && !document.querySelector('[data-testid="setup-cta-keys"]'));
	}
	const draft = () => page.$eval("[data-session-attachment-input]", element => [...element.childNodes].map(node => node.nodeType === 1 ? node.getAttribute("data-file-path-source") ?? node.textContent : node.textContent).join(""));
	async function fill(text) {
		await page.evaluate(value => {
			const input = document.querySelector("[data-session-attachment-input]");
			input.textContent = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}, text);
	}
	const staged = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="session-attachments"] li')].map(li => ({
		id: li.getAttribute("data-attachment-id"), name: li.querySelector("span")?.textContent, preview: li.querySelector("img")?.getAttribute("src") ?? null,
	})));
	async function waitStaged(names) {
		await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-testid="session-attachments"] li span')].map(span => span.textContent)) === expected, {}, JSON.stringify(names));
	}
	async function choose(paths) {
		const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="attach-files"]')]);
		assert.equal(chooser.isMultiple(), true);
		await chooser.accept(paths);
	}
	async function pasteImage(name) {
		return page.evaluate((bytes, fileName) => {
			const data = new DataTransfer();
			data.items.add(new File([new Uint8Array(bytes)], fileName, { type: "image/png" }));
			const input = document.querySelector("[data-session-attachment-input]");
			input.focus();
			const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		}, [...PNG], name);
	}
	/** Paste into whatever has focus, with no explicit focus first. A real
	 *  Ctrl+V of a system-clipboard image when the browser allows it; else a
	 *  native ClipboardEvent dispatched at document.activeElement. */
	async function pasteIntoFocus(name) {
		const focused = await page.evaluate(() => Boolean(document.activeElement?.closest("[data-session-attachment-input]")));
		const wrote = await page.evaluate(async bytes => {
			try {
				await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) })]);
				return "ok";
			} catch (error) { return String(error); }
		}, [...PNG]);
		if (wrote === "ok") {
			await page.keyboard.down("Control"); await page.keyboard.press("KeyV"); await page.keyboard.up("Control");
			return { focused, method: "system clipboard Ctrl+V" };
		}
		await page.evaluate((bytes, fileName) => {
			const data = new DataTransfer();
			data.items.add(new File([new Uint8Array(bytes)], fileName, { type: "image/png" }));
			(document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		}, [...PNG], name);
		return { focused, method: `ClipboardEvent at activeElement (clipboard write refused: ${wrote.slice(0, 120)})` };
	}
	async function send() {
		await page.waitForFunction(selector => { const button = document.querySelector(selector); return button && !button.disabled; }, {}, sendSelector);
		await page.click(sendSelector);
	}
	async function until(predicate, label, timeout = 30000) {
		const end = Date.now() + timeout;
		while (!predicate()) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	const chatId = () => new URL(page.url()).pathname.split("/").at(-1);
	async function assertSaved(id, expected, userMessages, label) {
		// Live render only: a reload would hide a missing canonical adoption.
		await page.waitForFunction((count) => document.querySelectorAll('[data-testid="user-message"]').length === count, { timeout: 20000 }, userMessages)
			.catch(() => { throw new Error(`${label}: accepted send did not render its saved bubble live`); });
		await page.waitForFunction(names => {
			const saved = [...document.querySelectorAll('[data-testid="saved-session-attachments"]')].at(-1);
			return saved && names.every(name => saved.textContent.includes(name));
		}, {}, expected.map(entry => entry.name));
		const images = expected.filter(entry => entry.kind === "image");
		if (images.length) {
			await page.waitForFunction(srcs => {
				const saved = [...document.querySelectorAll('[data-testid="saved-session-attachments"]')].at(-1);
				const imgs = [...saved.querySelectorAll("img")];
				return imgs.length === srcs.length && imgs.every((img, i) => img.getAttribute("src") === srcs[i] && img.complete && img.naturalWidth > 0);
			}, {}, images.map(entry => `/api/chats/${encodeURIComponent(id)}/attachments/${encodeURIComponent(entry.id)}`));
		}
		// Settle: the server-resolved bubble is the only one (no optimistic twin).
		await new Promise(resolve => setTimeout(resolve, 750));
		assert.equal(await page.$$eval('[data-testid="user-message"]', nodes => nodes.length), userMessages);
	}

	/** H: existing chat, the server saved a text+file send but its ack was
	 *  lost. The canonical bubble shows the file, so the tray must drop that
	 *  file and the unchanged text, without a second POST. With `newer`, the
	 *  learner edits the text and stages another file before the save lands:
	 *  both survive. */
	async function savedLostAck(chat, { newer = false, whitespace = false, acknowledged = false } = {}) {
		await open(`/chat/${chat}`);
		const users = await page.$$eval('[data-testid="user-message"]', nodes => nodes.length);
		const originalDraft = whitespace ? "  lost ack follow-up\n" : newer ? "lost ack, then newer edits" : "lost ack follow-up";
		const text = originalDraft.trim();
		const editedDraft = whitespace ? `${originalDraft}\n` : "a newer draft";
		await fill(originalDraft);
		await pasteImage("lost.png");
		await waitStaged(["lost.png"]);
		const [sent] = await staged();
		chatMode = "saved-lost-ack";
		holdChat = newer || whitespace;
		const before = posts.length;
		await send();
		await until(() => posts.length === before + 1, "saved-lost-ack post");
		assert.deepEqual(posts.at(-1).input, { type: "text", text, attachmentIds: [sent.id] });
		if (newer || whitespace) {
			await fill(editedDraft);
			if (newer) {
				await pasteImage("newer.png");
				await waitStaged(["lost.png", "newer.png"]);
			}
			const { request, body } = heldChats.shift();
			saveAccepted(body.chatId, body.input);
			if (acknowledged) await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
			else await request.abort("failed");
		}
		await assertSaved(chat, [infos.get(sent.id)], users + 1, "saved-lost-ack");
		const left = newer ? ["newer.png"] : [];
		await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-testid="session-attachments"] li span')].map(span => span.textContent)) === expected, { timeout: 10000 }, JSON.stringify(left))
			.catch(async () => { throw new Error(`saved-lost-ack: tray kept ${JSON.stringify((await staged()).map(entry => entry.name))}, expected ${JSON.stringify(left)}`); });
		assert.equal(await draft(), newer || whitespace ? editedDraft : "", "only the byte-identical submitted draft clears");
		await new Promise(resolve => setTimeout(resolve, 1000));
		assert.equal(posts.length, before + 1, "no automatic repost");
		assert.equal(await page.$$eval('[data-testid="user-message"]', nodes => nodes.length), users + 1);
		chatMode = "accepted";
		holdChat = false;
		checks.push(whitespace
			? `existing chat: ${acknowledged ? "acknowledged" : "lost-ack"} send cleared its file but preserved a newer whitespace-only edit; no repost`
			: newer
				? "existing chat: saved send with a lost ack cleared only the sent file; newer text and file stayed; no repost"
				: "existing chat: saved send with a lost ack rendered once and cleared its file and unchanged text; no repost");
	}

	// ── A: home, file-only start ──
	await open("/");
	await choose([fixture.text, fixture.pdf]);
	await waitStaged(["notes.txt", "paper.pdf"]);
	const afterChooser = await pasteIntoFocus("pasted.png");
	assert.equal(afterChooser.focused, true, "the picker hands focus back to the composer input");
	// Chromium names a system-clipboard image "image.png".
	const pastedName = afterChooser.method.startsWith("system") ? "image.png" : "pasted.png";
	await waitStaged(["notes.txt", "paper.pdf", pastedName]);
	checks.push(`/: after the chooser, focus is on the composer input and an unfocused-first paste staged the image (${afterChooser.method})`);
	let entries = await staged();
	assert.match(entries[2].preview, /^blob:/);
	assert.equal(entries[0].preview, null);
	assert.equal(await draft(), "");
	assert.equal(uploads.length, 0, "nothing uploads before Send");
	checks.push("/: real chooser text+PDF, then native paste image: all three staged together; blob preview; no upload before Send");
	await send();
	await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
	await until(() => posts.length === 1, "opening POST");
	await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith("lh.openingPrompt.")));
	let id = chatId();
	assert.equal(creates.length, 1);
	assert.equal(creates[0].title, `notes.txt, paper.pdf, ${pastedName}`);
	assert.equal(uploads.length, 1);
	assert.equal(uploads[0].chatId, id);
	assert.deepEqual(uploads[0].ids, entries.map(entry => entry.id));
	assert.deepEqual(uploads[0].files.map(file => file.name), ["notes.txt", "paper.pdf", pastedName]);
	assert.equal(posts.length, 1);
	assert.deepEqual(posts[0].input, { type: "text", text: "", attachmentIds: entries.map(entry => entry.id) });
	await assertSaved(id, entries.map(entry => infos.get(entry.id)), 1, "/ file-only opening");
	assert.equal(await page.$('[data-testid="session-attachments"]'), null, "submitted files leave the chat composer");
	checks.push("/: file-only start → one prepare to the new chat, opening POST carries the same ids, saved names + endpoint image render once, tray cleared");

	if (only === "saved-lost-ack") {
		await savedLostAck(id);
		await savedLostAck(id, { newer: true });
		await savedLostAck(id, { whitespace: true });
		await savedLostAck(id, { whitespace: true, acknowledged: true });
	} else if (only === "opening") {
		// Fast loop: one text+files opening from /chat/new, no failure modes.
		await open("/chat/new");
		await fill("Explain these synthetic files");
		await choose([fixture.text]);
		await pasteImage("board.png");
		await waitStaged(["notes.txt", "board.png"]);
		entries = await staged();
		await send();
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await assertSaved(chatId(), entries.map(entry => infos.get(entry.id)), 1, "/chat/new text+files opening");
		checks.push("/chat/new: text+files opening rendered once live");
	} else {
	// ── B: new-session, text + files, prepare failure then unchanged retry ──
	await open("/chat/new");
	await fill("Explain these synthetic files");
	await choose([fixture.text, fixture.pdf]);
	await waitStaged(["notes.txt", "paper.pdf"]);
	await pasteImage("board.png");
	await waitStaged(["notes.txt", "paper.pdf", "board.png"]);
	assert.equal(await draft(), "Explain these synthetic files", "paste after chooser keeps the draft");
	entries = await staged();
	uploadMode = "fail-once";
	const before = { creates: creates.length, uploads: uploads.length, posts: posts.length };
	await send();
	await page.waitForSelector('[data-testid="session-attachments"] [role="alert"]');
	assert.match(await page.$eval('[data-testid="session-attachments"] [role="alert"]', node => node.textContent), /Synthetic preparation failure/);
	assert.equal(new URL(page.url()).pathname, "/chat/new");
	assert.equal(await draft(), "Explain these synthetic files");
	assert.deepEqual(await staged(), entries);
	assert.equal(creates.length, before.creates + 1);
	assert.equal(uploads.length, before.uploads + 1);
	assert.equal(posts.length, before.posts);
	checks.push("/chat/new: failed prepare keeps draft, files, previews, shows the server error, no navigation or chat POST");
	await send();
	await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
	await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith("lh.openingPrompt.")));
	id = chatId();
	assert.equal(creates.length, before.creates + 1, "unchanged retry reuses the created session");
	assert.equal(uploads.length, before.uploads + 2);
	assert.equal(uploads.at(-1).chatId, uploads.at(-2).chatId);
	assert.equal(uploads.at(-1).chatId, id);
	assert.deepEqual(uploads.at(-1).ids, uploads.at(-2).ids, "retry reuses attachment ids");
	assert.deepEqual(posts.at(-1).input, { type: "text", text: "Explain these synthetic files", attachmentIds: entries.map(entry => entry.id) });
	await assertSaved(id, entries.map(entry => infos.get(entry.id)), 1, "/chat/new text+files opening");
	checks.push("/chat/new: unchanged retry reused session and ids; text+files opening delivered and rendered once");

	// ── C: existing chat composer ──
	await open(`/chat/${id}`);
	await assertSaved(id, entries.map(entry => infos.get(entry.id)), 1, "existing chat reload");
	checks.push("existing chat reload: server-rendered saved names/previews, no duplicate");
	await fill("A synthetic follow-up");
	await choose([fixture.text]);
	await pasteImage("follow.png");
	await waitStaged(["notes.txt", "follow.png"]);
	assert.equal(await draft(), "A synthetic follow-up");
	entries = await staged();
	const followUploads = uploads.length;
	await send();
	await page.waitForFunction(count => document.querySelectorAll('[data-testid="user-message"]').length === count, {}, 2);
	assert.equal(uploads.length, followUploads + 1);
	assert.equal(uploads.at(-1).chatId, id);
	assert.deepEqual(posts.at(-1).input, { type: "text", text: "A synthetic follow-up", attachmentIds: entries.map(entry => entry.id) });
	await assertSaved(id, entries.map(entry => infos.get(entry.id)), 2, "existing chat follow-up");
	checks.push("existing chat: text+files send prepared then posted ids; saved bubble rendered once");
	// Busy gate: the follow-up's stream is held, so the turn is still running.
	const busyNow = await page.waitForSelector('[data-testid="composer"] button[aria-label="Stop"]', { timeout: 15000 }).then(() => true, () => false);
	if (!busyNow) throw new Error("existing chat: held stream did not leave the composer busy, so the busy gate was not exercised");
	else {
		await pasteImage("waiting.png");
		await waitStaged(["waiting.png"]);
		await page.waitForFunction(() => document.querySelector('[data-testid="session-attachments"]')?.textContent.includes("once the current reply finishes"));
		const busyPosts = posts.length;
		await page.focus("[data-session-attachment-input]");
		await page.keyboard.press("Enter");
		await fill("steer text while files wait");
		await page.keyboard.press("Enter");
		await new Promise(resolve => setTimeout(resolve, 750));
		assert.equal(posts.length, busyPosts, "no send while files wait");
		assert.deepEqual(aborts, [], "Enter never stops the turn while files wait");
		assert.ok(await page.$('[data-testid="composer"] button[aria-label="Stop"]'), "Stop stays available");
		await waitStaged(["waiting.png"]);
		await page.click('[aria-label="Remove waiting.png"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="session-attachments"]'));
		checks.push("busy turn: staged image waits, Enter neither sends nor stops, Stop visible, remove works");
	}

	// ── D: image-only opening, lost ack, reload restores ──
	await open("/chat/new");
	await pasteImage("only.png");
	await waitStaged(["only.png"]);
	entries = await staged();
	chatMode = "lost-ack";
	const lost = { posts: posts.length, uploads: uploads.length };
	await send();
	await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
	await page.waitForFunction(() => Object.values(sessionStorage).some(value => value.includes('"attempted":true')));
	id = chatId();
	assert.equal(posts.length, lost.posts + 1);
	assert.equal(uploads.length, lost.uploads + 1);
	const stash = await page.evaluate(chat => sessionStorage.getItem(`lh.openingPrompt.${chat}`), id);
	assert.ok(!/blob:|data:/.test(stash), "storage never holds file bytes or object URLs");
	assert.deepEqual(JSON.parse(stash).attachments.map(info => info.id), entries.map(entry => entry.id));
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector("[data-session-attachment-input]");
	await waitStaged(["only.png"]);
	const restored = await staged();
	assert.equal(restored[0].id, entries[0].id);
	assert.equal(restored[0].preview, `/api/chats/${encodeURIComponent(id)}/attachments/${encodeURIComponent(entries[0].id)}`);
	await page.waitForFunction(() => { const img = document.querySelector('[data-testid="session-attachments"] img'); return img?.complete && img.naturalWidth > 0; });
	assert.equal(posts.length, lost.posts + 1, "reload never reposts");
	checks.push("image-only opening: lost ack stashes ids only; reload restores the staged image from the chat endpoint without reposting");
	chatMode = "accepted";
	await send();
	await page.waitForFunction(chat => !sessionStorage.getItem(`lh.openingPrompt.${chat}`), {}, id);
	assert.equal(uploads.length, lost.uploads + 1, "restored prepared entries are not uploaded again");
	assert.deepEqual(posts.at(-1).input, { type: "text", text: "", attachmentIds: [entries[0].id] });
	await assertSaved(id, [infos.get(entries[0].id)], 1, "image-only restored opening");
	checks.push("image-only opening: explicit resend reused the prepared id, rendered once");

	// ── E: browser drop on an existing chat ──
	await open(`/chat/${id}`);
	await page.evaluate(names => {
		const data = new DataTransfer();
		for (const name of names) data.items.add(new File(["synthetic"], name, { type: "text/plain" }));
		const target = document.querySelector('[data-testid="file-path-drop-zone"]');
		for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
	}, ["dropped.md"]);
	await waitStaged(["dropped.md"]);
	assert.equal(await draft(), "", "no paths enter the browser draft");
	const afterDrop = await pasteIntoFocus("after-drop.png");
	assert.equal(afterDrop.focused, true, "a browser drop hands focus to the composer input");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-attachments"] li').length === 2);
	checks.push(`browser drop then paste without explicit focus staged both (${afterDrop.method})`);
	checks.push("browser drop: native DragEvent Files staged on the chat composer, no path text");

	// ── F: creation in flight: the draft composer is frozen ──
	for (const route of ["/", "/chat/new"]) {
		await open(route);
		await fill("held create draft");
		await pasteImage("held.png");
		await waitStaged(["held.png"]);
		const frozen = await staged();
		createMode = "held";
		const createCount = creates.length;
		await send();
		await until(() => heldCreates.length === 1 && creates.length === createCount + 1, "held create");
		await page.waitForFunction(() => document.querySelector("[data-session-attachment-input]")?.closest("[inert]"));
		await page.click("[data-session-attachment-input]").catch(() => {});
		await page.keyboard.type("typed while creating");
		const chooser = await Promise.race([
			page.waitForFileChooser({ timeout: 2000 }).then(() => true, () => false),
			page.click('[data-testid="attach-files"]').then(() => new Promise(resolve => setTimeout(() => resolve(false), 2100)), () => false),
		]);
		assert.equal(chooser, false, "paperclip cannot open the picker during creation");
		await page.click('[aria-label="Remove held.png"]').catch(() => {});
		await page.evaluate(() => {
			const data = new DataTransfer();
			data.items.add(new File(["x"], "dropped-late.txt", { type: "text/plain" }));
			const zone = document.querySelector('[data-testid="file-path-drop-zone"]');
			for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
		});
		assert.equal(await page.evaluate(() => { const input = document.querySelector("[data-session-attachment-input]"); input.focus(); return document.activeElement === input; }), false, "inert input cannot take focus (so no typing or paste)");
		assert.equal(await draft(), "held create draft");
		assert.deepEqual(await staged(), frozen, "remove/drop could not change the staged files");
		assert.equal(uploads.filter(upload => upload.files.some(file => file.name === "dropped-late.txt")).length, 0);
		createMode = "ok";
		await heldCreates.shift().continue();
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await until(() => posts.at(-1)?.input.text === "held create draft", "post after held create");
		assert.deepEqual(posts.at(-1).input.attachmentIds, frozen.map(entry => entry.id));
		checks.push(`${route}: while create is held the composer is inert: typing, picker, remove and drop changed nothing; send delivered the frozen draft and file`);
	}

	// ── G: existing chat, preparation held, then a model/key refusal ──
	await open(`/chat/${id}`);
	await fill("first message");
	await pasteImage("prep.png");
	await waitStaged(["prep.png"]);
	const prepEntries = await staged();
	uploadMode = "held";
	chatMode = "refused";
	const refusedPosts = posts.length;
	await send();
	await until(() => heldUploads.length === 1, "held preparation");
	await fill("newer text typed while preparing");
	const { request: heldUpload, sent: heldSent } = heldUploads.shift();
	uploadMode = "ok";
	await heldUpload.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ attachments: prepare(heldSent) }) });
	await until(() => posts.length === refusedPosts + 1, "refused post");
	assert.deepEqual(posts.at(-1).input, { type: "text", text: "first message", attachmentIds: prepEntries.map(entry => entry.id) });
	await new Promise(resolve => setTimeout(resolve, 1000));
	assert.equal(await draft(), "newer text typed while preparing", "refusal keeps newer edits");
	assert.deepEqual((await staged()).map(entry => entry.id), prepEntries.map(entry => entry.id), "refusal keeps every staged file");
	chatMode = "accepted";
	checks.push("existing chat: newer text typed during a held preparation survives a 503 model refusal, with all staged files");

	// ── H: existing chat, saved input with a lost acknowledgment ──
	await savedLostAck(id);
	await savedLostAck(id, { newer: true });
	await savedLostAck(id, { whitespace: true });
	await savedLostAck(id, { whitespace: true, acknowledged: true });

	}
	assert.deepEqual(external, [], "no external browser requests");
	assert.deepEqual(errors, []);
	assert.deepEqual(gaps, [], "every check ran");
	console.log(JSON.stringify({ checks, gaps, pageErrors: errors, imageEndpointGets: imageGets.length, isolation: "synthetic catalog/prepare/chat/streams; empty auth; no providers", origin }, null, 2));
} catch (err) {
	console.error(err);
	console.error(JSON.stringify({ checks, gaps, errors, url: page?.url(), dom: await page?.evaluate(() => ({
		staged: [...document.querySelectorAll('[data-testid="session-attachments"] li span')].map(e => e.textContent),
		tray: document.querySelector('[data-testid="session-attachments"]')?.textContent,
		buttons: [...document.querySelectorAll('button[aria-label="Send"], button[aria-label="Start session"], button[aria-label="Stop"]')].map(e => ({ disabled: e.disabled, label: e.getAttribute("aria-label") })),
		alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
		users: document.querySelectorAll('[data-testid="user-message"]').length,
		storage: Object.fromEntries(Object.entries(sessionStorage)),
		text: document.body.innerText.slice(-1200),
	})).catch(() => null) }, null, 2));
	console.error(logs); process.exitCode = 1;
} finally {
	await browser?.close();
	const group = signal => { try { process.kill(-server.pid, signal); } catch { /* already gone */ } };
	const exited = server.exitCode === null ? once(server, "exit") : Promise.resolve();
	group("SIGTERM");
	const killTimer = setTimeout(() => group("SIGKILL"), 5000); killTimer.unref();
	await exited; clearTimeout(killTimer);
	group("SIGKILL"); // stragglers in the group
	await new Promise(resolve => setTimeout(resolve, 500));
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
