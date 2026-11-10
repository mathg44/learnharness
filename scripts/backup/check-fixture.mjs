/**
 * Synthetic profile and in-container helpers for scripts/check-server-backups.mjs.
 * Every record here is made up for the check. Nothing is copied from real or
 * golden data. The scripts run inside disposable containers with no network;
 * they never print record contents except to the runner's own pipe.
 */
import crypto from "node:crypto";
import { deflateSync } from "node:zlib";

export const ORIGIN = "https://backup.synthetic.test";
export const LOGIN = "backup-check@synthetic.test";
/** The discard port on loopback. In a --network none container nothing listens there. */
export const CUSTOM_BASE = "http://127.0.0.1:9/v1";
export const MODEL = "synthetic-model";
export const CHAT_ID = "chat_backupcheck_0001";
export const JOB_ID = "job_backupcheck_0001";
export const SOURCE_ID = "src_backupcheck_0001";
export const FOLDER_ID = "folder_backupcheck_0001";
export const PROMPT_SEGMENT = "teacher/20-teaching.md";
export const ATTACHMENTS = { text: "att_text", pdf: "att_pdf", image: "att_image" };
export const WRITER_FOLDER = /^writer-(\d+)$/;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A small valid RGB PNG. */
export function png(width, height, shade) {
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
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const rows = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) rows.push((x * 40) & 255, (y * 60) & 255, shade);
	}
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0)),
	]);
}

const usage = () => ({
	input: 120, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 160,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * The seeded profile as relative file paths under /data and /auth. `key` is
 * a synthetic API key and `bindingId` the settings/auth nonce (32 hex).
 */
export function syntheticProfile({ key, bindingId, hostId }) {
	const at = "2026-11-01T09:00:00.000Z";
	const ms = Date.parse(at);
	const boardPng = png(8, 6, 90);
	const snapshotPng = png(5, 4, 200);
	const snapshotId = sha256(snapshotPng);
	const image = (bytes, width, height) => ({ mimeType: "image/png", data: bytes.toString("base64"), width, height });
	const textBody = "Synthetic notes: two halves make a whole.\n";
	const pdfText = "Synthetic worksheet transcription: 1/2 + 1/2 = 1.";
	const attachments = {
		[ATTACHMENTS.text]: { id: ATTACHMENTS.text, name: "notes.txt", kind: "text", mimeType: "text/plain", size: Buffer.byteLength(textBody), text: textBody },
		[ATTACHMENTS.pdf]: { id: ATTACHMENTS.pdf, name: "worksheet.pdf", kind: "pdf", mimeType: "application/pdf", size: 2048, text: pdfText },
		[ATTACHMENTS.image]: { id: ATTACHMENTS.image, name: "board.png", kind: "image", mimeType: "image/png", size: boardPng.length, image: image(boardPng, 8, 6) },
	};
	const info = Object.values(attachments).map(({ id, name, kind, mimeType, size }) => ({ id, name, kind, mimeType, size }));
	const assistant = (id, content, stopReason, offset) => ({
		id, role: "assistant", content, api: "openai-completions", provider: "custom", model: MODEL,
		usage: usage(), stopReason, timestamp: ms + offset,
	});
	const messages = [
		{ id: "msg_u1", role: "user", content: [{ type: "text", text: "Synthetic learner question about fractions." }], timestamp: ms },
		assistant("msg_a1", [{ type: "text", text: "Synthetic explanation of halves." }], "stop", 1000),
		{
			id: "msg_u2", role: "user", userText: "Here are my synthetic files.", sessionAttachments: info, timestamp: ms + 2000,
			content: [
				{ type: "text", text: "Here are my synthetic files." },
				{ type: "text", text: textBody },
				{ type: "text", text: pdfText },
				{ type: "image", data: attachments[ATTACHMENTS.image].image.data, mimeType: "image/png" },
			],
		},
		// A dispatched research job plus an unanswered question: the pending
		// question holds the job's pending delivery, so reads never wake a turn.
		assistant("msg_a2", [
			{ type: "toolCall", id: "call_research_1", name: "research", arguments: { topic: "Synthetic fractions" } },
			{ type: "toolCall", id: "call_ask_1", name: "ask_user_question", arguments: {
				question: "Which synthetic example should come next?",
				options: [{ label: "Pizza slices", value: "pizza" }, { label: "Number line", value: "line" }],
			} },
		], "toolUse", 3000),
		{
			id: "msg_t1", role: "toolResult", toolCallId: "call_research_1", toolName: "research",
			content: [{ type: "text", text: "Synthetic research job started." }], isError: false, timestamp: ms + 3500,
		},
	];
	const chat = {
		id: CHAT_ID, title: "Synthetic backup session", createdAt: at, updatedAt: new Date(ms + 3500).toISOString(),
		messages, imageSnapshots: { [snapshotId]: image(snapshotPng, 5, 4) }, attachments, version: 1,
	};
	const job = {
		id: JOB_ID, kind: "research", chatId: CHAT_ID, toolCallId: "call_research_1",
		input: { topic: "Synthetic fractions" }, delivery: { kind: "result", status: "pending" },
		status: "done", activity: "finished", createdAt: at, updatedAt: at,
		result: { summary: "Synthetic research summary." },
	};
	const provenance = [{ chatId: CHAT_ID, messageId: "msg_a1" }];
	const nodes = [
		{ id: "node_half", name: "Half", statement: "A half is one of two equal parts.", aliases: [], createdAt: at, provenance },
		{ id: "node_whole", name: "Whole", statement: "Two halves make a whole.", aliases: [], createdAt: at, provenance },
	];
	const chains = [{ id: "chain_halves", premises: ["node_half"], conclusion: "node_whole", provenance, createdAt: at }];
	const jsonl = (records) => records.map((record) => JSON.stringify(record) + "\n").join("");
	const settings = {
		version: 1,
		appearance: { mode: "dark", proseFontSize: 17 },
		models: Object.fromEntries(["strong", "cheap", "vision"].map((slot) => [slot, { model: { provider: "custom", id: MODEL }, thinkingLevel: "off" }])),
		agent: { prompts: { [PROMPT_SEGMENT]: true } },
		customProvider: { credentialBindingId: bindingId, authMode: "apiKey", baseUrl: CUSTOM_BASE, models: [{ id: MODEL }], manualModels: [MODEL] },
	};
	const binding = { version: 1, id: bindingId, baseUrl: CUSTOM_BASE, authMode: "apiKey", fileKeyBaseUrl: CUSTOM_BASE };
	const json = (value) => JSON.stringify(value, null, "\t") + "\n";
	return {
		snapshotId,
		files: [
			["data", `chats/${CHAT_ID}.json`, json(chat)],
			["data", `jobs/${JOB_ID}.json`, json(job)],
			["data", "graph/format.json", json({ version: 1 })],
			["data", "graph/nodes.jsonl", jsonl(nodes)],
			["data", "graph/chains.jsonl", jsonl(chains)],
			["data", "graph/coverage.jsonl", jsonl([{ chatId: CHAT_ID, fp: "synthetic-fp-a1", tokens: 40, foldedAt: at }])],
			["data", "graph/sessions.jsonl", jsonl([{ chatId: CHAT_ID, foldedAt: at }])],
			["data", "graph/sources.json", json({ [SOURCE_ID]: { id: SOURCE_ID, filePath: "/synthetic/notes/fractions.md", importedAt: at } })],
			["data", "graph/source-organization.json", json({
				version: 1,
				folders: [{ id: FOLDER_ID, name: "Synthetic folder", parentId: null, createdAt: at }],
				placements: { [SOURCE_ID]: { folderId: FOLDER_ID, name: "Synthetic fractions notes" } },
			})],
			["data", "settings.json", json(settings)],
			["data", `prompts/${PROMPT_SEGMENT}`, "Synthetic teaching override for the backup check.\n"],
			["auth", "auth.json", json({ CUSTOM_OPENAI_API_KEY: key, __learnharness_custom_provider_binding: JSON.stringify(binding) })],
			["auth", "chatgpt-credentials.json", JSON.stringify({ version: 1, hostId, activeId: null, registrations: [] }) + "\n"],
			["auth", "github-copilot-credentials.json", JSON.stringify({ version: 1, allowBackgroundUse: false }) + "\n"],
			["auth", "xai-credentials.json", JSON.stringify({ version: 1, allowBackgroundUse: false }) + "\n"],
		],
	};
}

/**
 * Seeds empty /data and /auth volumes from a JSON file list on stdin.
 * argv: <dataRoot> <authRoot>. Prints nothing; refuses non-empty roots.
 */
export const SEED_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const roots = { data: process.argv[1], auth: process.argv[2] };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	try {
		for (const root of Object.values(roots)) if (fs.readdirSync(root).length !== 0) throw new Error("not empty");
		for (const [root, relative, content] of JSON.parse(input)) {
			const target = path.join(roots[root], relative);
			if (!target.startsWith(roots[root] + "/")) throw new Error("bad path");
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
		}
	} catch {
		console.error("Synthetic seed failed.");
		process.exit(1);
	}
});
`;

/**
 * Runs inside an app container. argv: <mode> <config JSON>.
 *   batch     stdin: [{name, method, path, json?, etag?: "previous"}] -> stdout: [{name, status, contentType, etag, body(base64)}]
 *   writer    route mutations in a loop until stdin closes -> stdout lines {tick} then {iterations, failures}
 *   inventory hashes every file under /data and /auth -> stdout: [{path, size, mode, sha256}]
 *   fill      fills /tmp through one file, /tmp/<name>, until ENOSPC -> stdout: {full, chunks}
 *   unfill    removes only /tmp/<name> -> stdout: true
 *   staging   names left in the app's capture staging directory -> stdout: [name]
 */
export const FILL_NAME = /^lh-backup-check-fill-[0-9a-f-]{36}$/;
export const CONTAINER_SCRIPT = String.raw`
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [mode, configText, fillName] = process.argv.slice(1);
const config = JSON.parse(configText);
function fillPath() {
	if (!/^lh-backup-check-fill-[0-9a-f-]{36}$/.test(fillName ?? "")) throw new Error("fill name");
	return "/tmp/" + fillName;
}
/** At most 256 MiB (the tmpfs size), then 4 KiB pieces so no whole page stays free. */
function fill() {
	const fd = fs.openSync(fillPath(), "wx", 0o600);
	let chunks = 0, full = false;
	try {
		for (const [size, limit] of [[1024 * 1024, 256], [4096, 256]]) {
			const block = Buffer.alloc(size);
			for (let i = 0; i < limit; i++) {
				try { fs.writeSync(fd, block); chunks++; }
				catch (error) { if (error.code !== "ENOSPC") throw error; full = true; break; }
			}
		}
	} finally { fs.closeSync(fd); }
	return { full, chunks };
}
const origin = new URL(config.origin);
function call(method, route, { json, ifMatch } = {}) {
	const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
	const headers = {
		host: origin.host, "tailscale-user-login": config.login, "x-forwarded-proto": "https",
		origin: config.origin, accept: "application/json",
		...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
		...(ifMatch ? { "if-match": ifMatch } : {}),
	};
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port: config.port, method, path: route, headers, timeout: 30000 }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode, contentType: response.headers["content-type"] ?? "", etag: response.headers.etag ?? "", bytes: Buffer.concat(chunks) }));
			response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new Error("timeout")));
		request.on("error", reject);
		if (body) request.write(body);
		request.end();
	});
}
const stdin = () => new Promise((resolve) => {
	let text = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => { text += chunk; });
	process.stdin.on("end", () => resolve(text));
});
function inventory() {
	const files = [];
	const visit = (absolute, relative) => {
		const stat = fs.lstatSync(absolute);
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), relative + "/" + name);
		} else {
			const bytes = stat.isFile() ? fs.readFileSync(absolute) : Buffer.alloc(0);
			files.push({ path: relative, type: stat.isFile() ? "file" : "other", size: bytes.length, mode: stat.mode & 0o7777, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
		}
	};
	visit("/data", "data");
	visit("/auth", "auth");
	return files;
}
async function writer() {
	let open = true;
	process.stdin.on("end", () => { open = false; });
	process.stdin.resume();
	let iterations = 0;
	const failures = [];
	while (open && failures.length === 0) {
		const i = iterations + 1;
		const folder = await call("POST", "/api/graph/sources", { json: { action: "create-folder", name: "writer-" + i, parentId: null } });
		const appearance = await call("PUT", "/api/settings/appearance", { json: { mode: "dark", proseFontSize: 12 + (i % 8) } });
		const current = await call("GET", "/api/custom-provider");
		const provider = await call("POST", "/api/custom-provider", {
			ifMatch: current.etag, json: { baseUrl: config.customBase, authMode: "apiKey", manualModels: [config.model] },
		});
		for (const [label, response] of [["folder", folder], ["appearance", appearance], ["provider-get", current], ["provider-post", provider]]) {
			if (response.status !== 200) failures.push(label + " " + response.status);
		}
		if (failures.length === 0) {
			iterations = i;
			process.stdout.write(JSON.stringify({ tick: i }) + "\n");
		}
	}
	process.stdout.write(JSON.stringify({ iterations, failures }) + "\n");
}
(async () => {
	if (mode === "inventory") {
		process.stdout.write(JSON.stringify(inventory()));
	} else if (mode === "fill") {
		process.stdout.write(JSON.stringify(fill()));
	} else if (mode === "unfill") {
		fs.rmSync(fillPath());
		process.stdout.write("true");
	} else if (mode === "staging") {
		process.stdout.write(JSON.stringify(fs.readdirSync("/tmp/learnharness-backup").sort()));
	} else if (mode === "batch") {
		const results = [];
		let previous = "";
		for (const step of JSON.parse(await stdin())) {
			const response = await call(step.method, step.path, { json: step.json, ifMatch: step.etag === "previous" ? previous : undefined });
			previous = response.etag;
			results.push({ name: step.name, status: response.status, contentType: response.contentType, etag: response.etag, body: response.bytes.toString("base64") });
		}
		process.stdout.write(JSON.stringify(results));
	} else if (mode === "writer") {
		await writer();
	} else throw new Error("mode");
})().catch(() => { console.error("Container helper failed."); process.exit(1); });
`;

/** The application reads compared across backup and restore. */
export function readRequests(snapshotId) {
	const chat = `/api/chats/${CHAT_ID}`;
	return [
		{ name: "chats", method: "GET", path: "/api/chats" },
		{ name: "chat", method: "GET", path: chat },
		{ name: "attachment-image", method: "GET", path: `${chat}/attachments/${ATTACHMENTS.image}`, binary: true },
		{ name: "snapshot-image", method: "GET", path: `${chat}/images/${snapshotId}` },
		{ name: "jobs", method: "GET", path: `/api/jobs?chatId=${CHAT_ID}` },
		{ name: "graph", method: "GET", path: "/api/graph" },
		{ name: "sources", method: "GET", path: "/api/graph/sources" },
		{ name: "settings", method: "GET", path: "/api/settings" },
		{ name: "prompts", method: "GET", path: "/api/settings/prompts" },
		{ name: "provider", method: "GET", path: "/api/custom-provider" },
	];
}

/** Read results reduced to comparable values. Etags carry a per-process secret and are dropped. */
export function projection(results, requests) {
	const binary = new Set(requests.filter((request) => request.binary).map((request) => request.name));
	const out = {};
	for (const result of results) {
		const bytes = Buffer.from(result.body, "base64");
		let body;
		if (binary.has(result.name)) body = { sha256: sha256(bytes), size: bytes.length };
		else {
			try { body = JSON.parse(bytes.toString("utf8")); } catch { body = { unparsed: sha256(bytes) }; }
		}
		out[result.name] = { status: result.status, contentType: result.contentType.split(";")[0], body };
	}
	return out;
}

/** Parts the writer loop never touches; they must survive every snapshot exactly. */
export const SEEDED_READS = ["chats", "chat", "attachment-image", "snapshot-image", "jobs", "graph", "prompts"];
