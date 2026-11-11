/**
 * Demo worker controller: HTTP over a Unix socket on the private volume
 * /run/learnharness-demo, nothing else. The container has no network.
 *
 *   GET  /health  → 200 {ready:true, sandbox} once the self-test passed, else 503
 *   POST /run     → {html, probe?, settleMs?} → DemoRunResult JSON
 *
 * One browser run at a time, at most MAX_WAITING queued, 60 s per run.
 * A client that disconnects cancels its run (queued or live) and the browser
 * tree is killed.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chromiumSandboxReport, RUN_TIMEOUT_MS, runDemoDocument, SandboxRefusal } from "./browser.mjs";
import {
	demoHtmlProblem,
	describeDemoHtmlProblem,
	MAX_DEMO_PROBE_CHARS,
	MAX_DEMO_REQUEST_BYTES,
} from "../../src/core/demo-document-policy.ts";

export const SOCKET_PATH = "/run/learnharness-demo/demo.sock";
const MAX_WAITING = 2;
const SELF_TEST_RETRY_MS = 30_000;

/** @typedef {{html: string, probe?: string, settleMs?: number}} RunRequest */

/** Validate a parsed body. Returns the request or an error message. */
export function parseRunRequest(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
	const problem = demoHtmlProblem(body.html);
	if (problem) return { error: describeDemoHtmlProblem(problem) };
	if (body.probe !== undefined && (typeof body.probe !== "string" || body.probe.length > MAX_DEMO_PROBE_CHARS)) {
		return { error: `probe must be a string of at most ${MAX_DEMO_PROBE_CHARS} characters` };
	}
	if (body.settleMs !== undefined && !(Number.isInteger(body.settleMs) && body.settleMs >= 0 && body.settleMs <= 10_000)) {
		return { error: "settleMs must be an integer between 0 and 10000" };
	}
	return { request: { html: body.html, ...(body.probe ? { probe: body.probe } : {}), ...(body.settleMs !== undefined ? { settleMs: body.settleMs } : {}) } };
}

/**
 * @param {{
 *   socketPath?: string,
 *   run?: (request: RunRequest, signal: AbortSignal) => Promise<object>,
 *   selfTest?: (signal: AbortSignal) => Promise<object>,
 *   runTimeoutMs?: number,
 * }} [options]
 */
export function createDemoWorker(options = {}) {
	const socketPath = options.socketPath ?? SOCKET_PATH;
	const run = options.run ?? runDemoDocument;
	const selfTest = options.selfTest ?? defaultSelfTest;
	const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
	/** @type {{ready: boolean, sandbox: object | null, reason: string | null, checkedAt: number}} */
	const health = { ready: false, sandbox: null, reason: "self-test pending", checkedAt: 0 };
	let active = 0;
	/** @type {Array<{start: () => void, signal: AbortSignal}>} */
	const waiting = [];
	let selfTestTimer = null;
	let closing = false;

	const markRefused = (reason) => {
		health.ready = false;
		health.reason = reason;
		health.checkedAt = Date.now();
	};

	async function runSelfTest() {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("self-test timed out")), runTimeoutMs);
		try {
			const report = await selfTest(controller.signal);
			Object.assign(health, { ready: true, sandbox: report, reason: null, checkedAt: Date.now() });
		} catch (error) {
			markRefused(`self-test failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!closing) selfTestTimer = setTimeout(runSelfTest, SELF_TEST_RETRY_MS);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Wait for the single browser slot. Rejects when the caller gives up. */
	function acquire(signal) {
		if (active === 0 && waiting.length === 0) {
			active = 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const entry = { signal, start: () => { active = 1; resolve(); } };
			waiting.push(entry);
			signal.addEventListener("abort", () => {
				const index = waiting.indexOf(entry);
				if (index !== -1) waiting.splice(index, 1);
				reject(signal.reason);
			}, { once: true });
		});
	}

	function release() {
		active = 0;
		const next = waiting.shift();
		next?.start();
	}

	const server = http.createServer(async (req, res) => {
		const send = (status, body) => {
			if (res.writableEnded || res.destroyed) return;
			const text = JSON.stringify(body);
			res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", Connection: "close" });
			res.end(text);
		};
		if (req.method === "GET" && req.url === "/health") {
			send(health.ready ? 200 : 503, health);
			return;
		}
		if (req.method !== "POST" || req.url !== "/run") {
			send(404, { error: "not found" });
			return;
		}
		if (!health.ready) {
			send(503, { error: `demo runtime not ready: ${health.reason}` });
			req.resume();
			return;
		}
		if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
			send(415, { error: "expected application/json" });
			req.resume();
			return;
		}
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_DEMO_REQUEST_BYTES) {
			send(413, { error: `request body exceeds ${MAX_DEMO_REQUEST_BYTES} bytes` });
			req.destroy();
			return;
		}
		if (active + waiting.length >= 1 + MAX_WAITING) {
			send(503, { error: "demo runtime busy" });
			req.destroy();
			return;
		}

		// The caller's connection is the run's lifetime.
		const controller = new AbortController();
		res.on("close", () => { if (!res.writableFinished) controller.abort(new Error("client disconnected")); });

		let body;
		try {
			body = await readBody(req, MAX_DEMO_REQUEST_BYTES);
		} catch (error) {
			send(error.status ?? 400, { error: error.message });
			req.destroy();
			return;
		}
		let parsed;
		try { parsed = parseRunRequest(JSON.parse(body)); }
		catch { parsed = { error: "body is not valid JSON" }; }
		if (parsed.error) {
			send(400, { error: parsed.error });
			return;
		}
		if (active + waiting.length >= 1 + MAX_WAITING) {
			send(503, { error: "demo runtime busy" });
			return;
		}

		try {
			await acquire(controller.signal);
		} catch {
			return; // gave up while queued
		}
		const timer = setTimeout(() => controller.abort(new RunTimeout()), runTimeoutMs);
		try {
			const result = await run(parsed.request, controller.signal);
			send(200, result);
		} catch (error) {
			if (error instanceof SandboxRefusal) {
				markRefused(error.message);
				send(503, { error: error.message });
			} else if (controller.signal.reason instanceof RunTimeout) {
				send(200, timeoutResult(runTimeoutMs));
			} else if (!controller.signal.aborted) {
				send(500, { error: `demo run failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) });
			}
		} finally {
			clearTimeout(timer);
			release();
		}
	});
	server.headersTimeout = 5_000;
	server.requestTimeout = 15_000;
	server.keepAliveTimeout = 0;
	server.maxHeadersCount = 32;
	server.maxConnections = 8;

	return {
		health,
		server,
		async listen() {
			fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
			fs.rmSync(socketPath, { force: true });
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => resolve(undefined));
			});
			fs.chmodSync(socketPath, 0o600);
			void runSelfTest();
		},
		async close() {
			closing = true;
			clearTimeout(selfTestTimer);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve(undefined)));
			fs.rmSync(socketPath, { force: true });
		},
	};
}

class RunTimeout extends Error {
	constructor() { super("run timed out"); }
}

/** @param {number} ms */
export function timeoutResult(ms) {
	return {
		consoleErrors: [],
		pageErrors: [`the demo was stopped after ${Math.round(ms / 1000)} s (time limit); the browser was killed`],
		failedRequests: [],
		ok: false,
	};
}

/** @param {http.IncomingMessage} req @param {number} limit */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Browser must report itself sandboxed, renderers must prove it in /proc,
 *  and a document that tries the network must see every attempt fail. */
async function defaultSelfTest(signal) {
	const report = await chromiumSandboxReport(signal);
	if (!report.adequate) throw new SandboxRefusal(`chrome://sandbox does not report an adequate sandbox: ${report.text.slice(0, 300)}`);
	if (!report.proc.sandboxed) throw new SandboxRefusal(`Chromium sandbox not active: ${report.proc.problems.join("; ")}`);
	const probe = await runDemoDocument({
		html: `<!doctype html><title>self-test</title><script>window.__ok = 1;</script>`,
		probe: "window.__ok",
		settleMs: 0,
	}, signal);
	if (!probe.ok || probe.probeResult !== 1) throw new Error("synthetic document did not run cleanly");
	return { product: report.product, chromium: report.text.match(/You are adequately sandboxed\.?/i)?.[0] ?? null, proc: probe.sandbox };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const worker = createDemoWorker();
	await worker.listen();
	const stop = () => { void worker.close().finally(() => process.exit(0)); };
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}
