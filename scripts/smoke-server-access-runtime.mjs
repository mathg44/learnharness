/** Server-mode access through the REAL production HTTP boundary: Next's
 * standalone server.js (what the container runs), its proxy, and the real
 * routes. Only a synthetic OpenAI-compatible endpoint on 127.0.0.1 stands in
 * for a model provider, and it only answers model discovery. No chat turn is
 * started, so no completion request is ever made.
 *
 * Phases, all on one scratch profile and one loopback port:
 * 1. LH_SERVER_MODE=tailscale with a synthetic HTTPS origin. Accepted requests
 *    carry what Tailscale Serve supplies (Host, Tailscale-User-Login,
 *    X-Forwarded-Host/Proto) plus a same-origin Origin on writes. Covers pages,
 *    chats, uploads, the attachment and snapshot image routes, custom provider
 *    and settings writes, the chat and events streams, and the container
 *    healthcheck. Then every route is retried with each missing or wrong
 *    header; all must be 403 and no record may change.
 * 2. Misconfigured server mode (unknown mode value; missing origin): every
 *    route is 403 even with correct headers, and the healthcheck fails.
 * 3. LH_SERVER_MODE unset: the same routes and records are reachable without
 *    any identity headers, as before server mode existed.
 *
 * Requirements:
 * - Run from a DISPOSABLE source copy (the script refuses a checkout with
 *   .git or a symlinked node_modules). Copy only git-controlled files, never a
 *   blanket copy (ignored files hold keys, records, uploads, backups), and
 *   hardlink the deps. Leave out tests/ like the Docker build context does;
 *   the standalone trace copies the project root and assemble.mjs refuses it:
 *     copy=~/lh-server-access-copy; mkdir "$copy"
 *     git ls-files -z -co --exclude-standard -- . ':!:.pi' ':!:tests' | tar --null -T - -c | tar -x -C "$copy"
 *     cp -al node_modules "$copy/node_modules"
 *     cd "$copy" && node scripts/smoke-server-access-runtime.mjs
 *   Delete "$copy" afterwards; its .next holds the build (several hundred MB).
 * - The script runs `next build` and scripts/container/assemble.mjs in the
 *   copy unless LH_SMOKE_SKIP_BUILD=1 and .next/standalone/server.js exists.
 *   Google font downloads are replaced by local stand-ins.
 *
 * Isolation: app HOME, data and auth live in a fresh scratch dir, removed on
 * success and failure. The app env is an allowlist (no ambient keys,
 * LH_IGNORE_ENV_KEYS=1). Only that spawned process group is stopped. Evidence
 * (statuses only, no record contents) goes to LH_SMOKE_EVIDENCE or
 * ~/lh-server-access-evidence-*.json.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { stopOwnedSmokeServer } from "./lib/owned-smoke-lifetime.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (fs.existsSync(path.join(root, ".git"))) throw new Error("Run from a disposable source copy, not a git checkout (see the header).");
if (fs.lstatSync(path.join(root, "node_modules")).isSymbolicLink()) throw new Error("node_modules must be a hardlinked copy, not a symlink.");
if (fs.existsSync(path.join(root, "tests"))) throw new Error("Leave tests/ out of the copy, as the Docker build context does (see the header).");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-access-"));
const home = path.join(scratch, "home");
const dataDir = path.join(scratch, "data");
fs.mkdirSync(home);
fs.mkdirSync(dataDir);
const authFile = path.join(scratch, "auth.json");
fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
const evidenceFile = process.env.LH_SMOKE_EVIDENCE
	?? path.join(os.homedir(), `lh-server-access-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

// ── Local stand-ins for the two Google fonts app/layout.tsx declares ──
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
const fontsFile = path.join(scratch, "fonts.cjs");
fs.writeFileSync(fontsFile, `module.exports = ${JSON.stringify(fonts)};\n`);
const baseEnv = {
	PATH: process.env.PATH, HOME: home, TMPDIR: scratch, NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontsFile,
};

const serverJs = path.join(root, ".next/standalone/server.js");
if (!(process.env.LH_SMOKE_SKIP_BUILD === "1" && fs.existsSync(serverJs))) {
	for (const [cmd, args] of [[process.execPath, ["node_modules/next/dist/bin/next", "build"]], [process.execPath, ["scripts/container/assemble.mjs"]]]) {
		const result = spawnSync(cmd, args, { cwd: root, env: { ...baseEnv, NODE_ENV: "production" }, stdio: "inherit" });
		if (result.status !== 0) throw new Error(`${args.join(" ")} failed with ${result.status}`);
	}
}
assert.ok(fs.existsSync(serverJs), "standalone server.js missing after build");

// ── Synthetic model endpoint: discovery only ──
const KEY = "synthetic-server-access-key";
const MODEL = "fixture-model";
const unexpected = [];
const provider = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/v1/models" && req.headers.authorization === `Bearer ${KEY}`) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ data: [{ id: MODEL, context_window: 65536, max_output_tokens: 4096 }] }));
		return;
	}
	unexpected.push(`${req.method} ${req.url}`);
	res.writeHead(400, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: "Unexpected fixture request" } }));
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const LOOPBACK_HOST = `127.0.0.1:${port}`;
const SERVER_HOST = "smoke-server.tailnet-example.ts.net";
const SERVER_ORIGIN = `https://${SERVER_HOST}`;
const SERVER_ENV = { LH_SERVER_MODE: "tailscale", LH_SERVER_ORIGIN: SERVER_ORIGIN };
const SERVE_HEADERS = {
	host: SERVER_HOST, "tailscale-user-login": "smoke-learner@example.invalid",
	"x-forwarded-host": SERVER_HOST, "x-forwarded-proto": "https",
};

let server;
let logs = "";
async function startApp(extraEnv = {}) {
	logs = "";
	server = spawn(process.execPath, [serverJs], {
		cwd: path.dirname(serverJs),
		env: {
			...baseEnv, ...extraEnv, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
			LH_DATA_DIR: dataDir, LH_AUTH_FILE: authFile, LH_IGNORE_ENV_KEYS: "1",
		},
		stdio: ["ignore", "pipe", "pipe"], detached: true,
	});
	const capture = data => { logs = (logs + data).slice(-24000); };
	server.stdout.on("data", capture);
	server.stderr.on("data", capture);
	const deadline = Date.now() + 60000;
	for (;;) {
		if (server.exitCode !== null) throw new Error(`app exited ${server.exitCode}`);
		const ready = await new Promise(resolve => {
			const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
			socket.on("error", () => resolve(false));
		});
		if (ready) return;
		if (Date.now() > deadline) throw new Error("app startup timed out");
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}
async function stopApp() {
	if (!server) return;
	const owned = server;
	server = undefined;
	await stopOwnedSmokeServer(owned, { graceMs: 5000, killMs: 5000 });
}

/** node:http: fetch would not send an overridden Host. `headers` replaces the
 * defaults wholesale so each rejection case controls every header sent. */
function call(method, route, { headers = {}, json, form, stream = false, timeout = 60000 } = {}) {
	return (async () => {
		const sent = { ...headers };
		let body;
		if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); sent["content-type"] = "application/json"; }
		if (form) {
			const encoded = new Response(form);
			sent["content-type"] = encoded.headers.get("content-type");
			body = Buffer.from(await encoded.arrayBuffer());
		}
		if (body) sent["content-length"] = String(body.length);
		if (!sent.host) sent.host = LOOPBACK_HOST;
		return new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: sent, timeout }, res => {
				const chunks = [];
				// Streams: the status and SSE headers prove the route answered.
				// /api/events sends nothing until an event or its heartbeat.
				if (stream && res.statusCode === 200) {
					resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.alloc(0) });
					req.destroy();
					return;
				}
				res.on("data", chunk => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
			});
			req.on("timeout", () => req.destroy(new Error(`${method} ${route} timed out`)));
			req.on("error", reject); // a no-op once a stream has resolved
			if (body) req.write(body);
			req.end();
		});
	})();
}
const text = response => response.bytes.toString("utf8");
const jsonOf = response => JSON.parse(text(response));

function runHealthcheck(env) {
	const result = spawnSync(process.execPath, [path.join(root, "scripts/container/healthcheck.mjs")], {
		env: { PATH: process.env.PATH, PORT: String(port), ...env }, timeout: 10000,
	});
	return result.status;
}

function png(width, height) {
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
	header[8] = 8; header[9] = 2;
	const rows = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) rows.push((x * 40) & 255, (y * 60) & 255, 90);
	}
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}
function uploadForm(entries) {
	const form = new FormData();
	for (const { id, name, type, bytes } of entries) {
		form.append("files", new Blob([bytes], { type }), name);
		form.append("ids", id);
	}
	return form;
}
const UPLOADS = [
	{ id: "att_server_notes", name: "notes.txt", type: "text/plain", bytes: Buffer.from("Synthetic server-access notes.\n") },
	{ id: "att_server_board", name: "board.png", type: "image/png", bytes: png(8, 6) },
];

const checks = [];
const evidence = { port, phases: {} };
const serve = (extra = {}) => ({ ...SERVE_HEADERS, ...extra });
const write = (extra = {}) => serve({ origin: SERVER_ORIGIN, ...extra });

try {
	// ══ Phase 1: tailscale server mode ══
	await startApp(SERVER_ENV);
	const accepted = {};
	const expectOk = async (label, response, status = 200) => {
		accepted[label] = response.status;
		assert.equal(response.status, status, `${label}: ${text(response).slice(0, 300)}`);
		return response;
	};

	const page = await expectOk("GET /", await call("GET", "/", { headers: serve() }));
	await expectOk("GET /chat/new", await call("GET", "/chat/new", { headers: serve() }));
	const asset = text(page).match(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/)?.[1];
	assert.ok(asset, "page references a static asset");
	const assetResponse = await call("GET", asset.replaceAll("&amp;", "&"));
	accepted["GET /_next/static (no headers)"] = assetResponse.status;
	assert.equal(assetResponse.status, 200, "public build assets stay outside the guard");

	assert.equal(jsonOf(await expectOk("GET /api/settings", await call("GET", "/api/settings", { headers: serve() }))).settings, null);
	const providerState = await expectOk("GET /api/custom-provider", await call("GET", "/api/custom-provider", { headers: serve() }));
	await expectOk("POST /api/custom-provider", await call("POST", "/api/custom-provider", {
		headers: write({ "if-match": providerState.headers.etag }),
		json: { baseUrl: providerBase, authMode: "apiKey", key: KEY },
	}));
	const slot = { model: { provider: "custom", id: MODEL }, thinkingLevel: "off" };
	await expectOk("PUT /api/settings/models", await call("PUT", "/api/settings/models", { headers: write(), json: { strong: slot, cheap: slot, vision: slot } }));
	await expectOk("PUT /api/settings/appearance", await call("PUT", "/api/settings/appearance", { headers: write(), json: { mode: "light", proseFontSize: 18 } }));
	await expectOk("GET /api/models", await call("GET", "/api/models", { headers: serve() }));

	const { id: chatId } = jsonOf(await expectOk("POST /api/chats", await call("POST", "/api/chats", { headers: write(), json: { title: "Server access smoke" } })));
	const uploaded = jsonOf(await expectOk("POST /api/chats/:id/attachments", await call("POST", `/api/chats/${chatId}/attachments`, { headers: write(), form: uploadForm(UPLOADS) })));
	assert.deepEqual(uploaded.attachments.map(a => a.id).sort(), UPLOADS.map(u => u.id).sort());
	const imageRoute = `/api/chats/${chatId}/attachments/att_server_board`;
	const image = await expectOk("GET attachment image", await call("GET", imageRoute, { headers: serve() }));
	assert.match(String(image.headers["content-type"]), /^image\//);
	await expectOk("GET /api/chats/:id", await call("GET", `/api/chats/${chatId}`, { headers: serve() }));
	await expectOk("GET /api/chats/:id/images/:missing", await call("GET", `/api/chats/${chatId}/images/missing_snapshot`, { headers: serve() }), 404);
	const chatStream = await expectOk("GET /api/chats/:id/stream", await call("GET", `/api/chats/${chatId}/stream`, { headers: serve(), stream: true }));
	assert.match(String(chatStream.headers["content-type"]), /text\/event-stream/);
	const events = await expectOk("GET /api/events", await call("GET", "/api/events", { headers: serve(), stream: true }));
	assert.match(String(events.headers["content-type"]), /text\/event-stream/);
	assert.equal(runHealthcheck(SERVER_ENV), 0, "healthcheck passes against the real server");
	accepted["healthcheck.mjs"] = "exit 0";
	checks.push("server mode: Serve-shaped requests reach pages, chats, uploads, image routes, provider/settings writes, both streams and the healthcheck");

	const before = {
		chats: text(await call("GET", "/api/chats", { headers: serve() })),
		settings: text(await call("GET", "/api/settings", { headers: serve() })),
		provider: text(await call("GET", "/api/custom-provider", { headers: serve() })),
		chat: text(await call("GET", `/api/chats/${chatId}`, { headers: serve() })),
	};

	const reads = [
		["GET", "/"], ["GET", "/chat/new"], ["GET", `/chat/${chatId}`],
		["GET", "/api/settings"], ["GET", "/api/chats"], ["GET", `/api/chats/${chatId}`],
		["GET", imageRoute], ["GET", `/api/chats/${chatId}/images/missing_snapshot`],
		["GET", "/api/custom-provider"], ["GET", "/api/models"], ["GET", "/api/graph"],
		["GET", `/api/chats/${chatId}/stream`], ["GET", "/api/events"],
	];
	const writes = [
		["POST", "/api/chats", { json: { title: "Must not exist" } }],
		["POST", `/api/chats/${chatId}/attachments`, { form: () => uploadForm([{ id: "att_server_rejected", name: "x.txt", type: "text/plain", bytes: Buffer.from("x") }]) }],
		["POST", "/api/custom-provider", { json: { baseUrl: "http://127.0.0.1:9/v1", authMode: "apiKey", key: "rejected" } }],
		["PUT", "/api/settings/appearance", { json: { mode: "dark", proseFontSize: 12 } }],
		["POST", "/api/chat", { json: { chatId, input: { type: "text", text: "must not start" } } }],
		["DELETE", `/api/chats/${chatId}`, {}],
	];
	const readVariants = {
		"no headers": {},
		"no identity": (({ "tailscale-user-login": _, ...rest }) => rest)(SERVE_HEADERS),
		"empty identity": serve({ "tailscale-user-login": "" }),
		"direct backend Host": serve({ host: LOOPBACK_HOST, "x-forwarded-host": undefined }),
		"wrong Host": serve({ host: "attacker.invalid", "x-forwarded-host": undefined }),
		"wrong X-Forwarded-Host": serve({ "x-forwarded-host": "attacker.invalid" }),
		"plain-http forwarding": serve({ "x-forwarded-proto": "http" }),
		"cross-origin read": serve({ origin: "https://attacker.invalid" }),
	};
	const writeVariants = {
		...Object.fromEntries(Object.entries(readVariants).filter(([name]) => name !== "cross-origin read").map(([name, h]) => [name, { ...h, origin: SERVER_ORIGIN }])),
		"no Origin": serve(),
		"cross-origin": write({ origin: "https://attacker.invalid" }),
		"backend Origin": write({ origin: `http://${LOOPBACK_HOST}` }),
	};
	const clean = headers => Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
	const rejected = {};
	for (const [method, route] of reads) {
		for (const [variant, headers] of Object.entries(readVariants)) {
			const response = await call(method, route, { headers: clean(headers) });
			rejected[`${method} ${route} [${variant}]`] = response.status;
			assert.equal(response.status, 403, `${method} ${route} [${variant}]`);
			assert.deepEqual(jsonOf(response), { error: "Access denied." });
			assert.equal(response.headers["cache-control"], "no-store");
		}
	}
	for (const [method, route, body] of writes) {
		for (const [variant, headers] of Object.entries(writeVariants)) {
			const response = await call(method, route, { headers: clean(headers), json: body.json, form: body.form?.() });
			rejected[`${method} ${route} [${variant}]`] = response.status;
			assert.equal(response.status, 403, `${method} ${route} [${variant}]`);
		}
	}
	assert.equal(runHealthcheck({ ...SERVER_ENV, LH_SERVER_ORIGIN: "https://other-host.tailnet-example.ts.net" }), 1, "healthcheck with the wrong origin fails");
	rejected["healthcheck.mjs (wrong origin)"] = "exit 1";
	const after = {
		chats: text(await call("GET", "/api/chats", { headers: serve() })),
		settings: text(await call("GET", "/api/settings", { headers: serve() })),
		provider: text(await call("GET", "/api/custom-provider", { headers: serve() })),
		chat: text(await call("GET", `/api/chats/${chatId}`, { headers: serve() })),
	};
	assert.deepEqual(after, before, "rejected requests changed no chats, settings, provider binding or attachments");
	checks.push(`server mode: ${Object.keys(rejected).length - 1} rejected requests across ${reads.length} read and ${writes.length} write routes were 403 and changed no records`);
	evidence.phases.server = { accepted, rejectedCount: Object.keys(rejected).length, rejected };
	await stopApp();

	// ══ Phase 2: misconfigured server mode fails closed ══
	evidence.phases.misconfigured = {};
	for (const [label, env] of [
		["unknown mode", { LH_SERVER_MODE: "on", LH_SERVER_ORIGIN: SERVER_ORIGIN }],
		["missing origin", { LH_SERVER_MODE: "tailscale" }],
		["empty mode", { LH_SERVER_MODE: "", LH_SERVER_ORIGIN: SERVER_ORIGIN }],
	]) {
		await startApp(env);
		const statuses = {};
		for (const [method, route] of [["GET", "/"], ["GET", "/api/settings"], ["GET", `/api/chats/${chatId}`], ["GET", imageRoute], ["GET", `/api/chats/${chatId}/stream`]]) {
			const response = await call(method, route, { headers: serve() });
			statuses[`${method} ${route}`] = response.status;
			assert.equal(response.status, 403, `${label}: ${method} ${route}`);
		}
		const writeResponse = await call("POST", "/api/chats", { headers: write(), json: { title: "Must not exist" } });
		statuses["POST /api/chats"] = writeResponse.status;
		assert.equal(writeResponse.status, 403);
		assert.equal(runHealthcheck(env), 1, `${label}: healthcheck fails`);
		statuses["healthcheck.mjs"] = "exit 1";
		evidence.phases.misconfigured[label] = statuses;
		await stopApp();
	}
	checks.push("misconfigured server mode (unknown mode, missing origin, empty mode): every route 403 with correct headers; healthcheck unhealthy");

	// ══ Phase 3: normal mode is unchanged ══
	await startApp();
	const normal = {};
	const local = { origin: `http://${LOOPBACK_HOST}` };
	for (const [method, route, status, options] of [
		["GET", "/", 200, {}], ["GET", "/chat/new", 200, {}], ["GET", `/chat/${chatId}`, 200, {}],
		["GET", "/api/settings", 200, {}], ["GET", `/api/chats/${chatId}`, 200, {}], ["GET", imageRoute, 200, {}],
		["GET", `/api/chats/${chatId}/images/missing_snapshot`, 404, {}],
		["GET", `/api/chats/${chatId}/stream`, 200, { stream: true }], ["GET", "/api/events", 200, { stream: true }],
		["POST", "/api/chats", 200, { headers: local, json: { title: "Normal mode chat" } }],
	]) {
		const response = await call(method, route, options);
		normal[`${method} ${route}`] = response.status;
		assert.equal(response.status, status, `normal mode: ${method} ${route}: ${text(response).slice(0, 200)}`);
	}
	const chats = jsonOf(await call("GET", "/api/chats")).chats;
	assert.equal(chats.length, 2, "the server-mode chat persisted and the normal-mode chat was added");
	assert.ok(Buffer.compare((await call("GET", imageRoute)).bytes, image.bytes) === 0, "same image bytes outside server mode");
	assert.equal(runHealthcheck({}), 0, "healthcheck passes without server variables");
	normal["healthcheck.mjs"] = "exit 0";
	evidence.phases.normal = normal;
	checks.push("normal mode: the same profile's pages, records, image, streams and writes are reachable without identity headers; healthcheck passes");
	await stopApp();

	assert.deepEqual(unexpected, [], "the synthetic provider only saw model discovery");
	fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify({ result: "pass", checks, evidence: evidenceFile }, null, 2));
} catch (err) {
	console.error(err);
	evidence.failure = String(err?.stack ?? err);
	evidence.unexpected = unexpected;
	evidence.logs = logs;
	try { fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)); console.error(`evidence: ${evidenceFile}`); } catch { /* best effort */ }
	console.error(logs);
	process.exitCode = 1;
} finally {
	await stopApp().catch(err => { console.error(err); process.exitCode = 1; });
	provider.close();
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	if (fs.existsSync(scratch)) { console.error(`scratch dir survived cleanup: ${scratch}`); process.exitCode = 1; }
}
