/**
 * The demo worker controller and the app's socket adapter, end to end over
 * a real Unix socket, with the browser replaced by a fake run. No Docker,
 * no Chromium. Also pins the worker seccomp profile's additions and the
 * rule that a server never reaches a local browser.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDemoWorker, parseRunRequest, timeoutResult } from "../scripts/demo/controller.mjs";
import {
	createServerHeadless,
	resetServerDemoReadiness,
	runServerDemo,
	serverDemoTimeouts,
	startServerDemoReadiness,
} from "../src/agent/server-demo.ts";
import { getHeadless, headlessOverride, realHeadless } from "../src/agent/subagents/headless.ts";
import { isServerCapabilityAvailable } from "../src/core/server-capabilities.ts";
import { MAX_DEMO_REQUEST_BYTES } from "../src/core/demo-document-policy.ts";

const previousMode = process.env.LH_SERVER_MODE;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetServerDemoReadiness();
	headlessOverride.current = undefined;
	serverDemoTimeouts.healthMs = 4_000;
	serverDemoTimeouts.runMs = 200_000;
	if (previousMode === undefined) delete process.env.LH_SERVER_MODE;
	else process.env.LH_SERVER_MODE = previousMode;
});

const CLEAN = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const SANDBOX_REPORT = { product: "Chrome/test", proc: { sandboxed: true, renderers: 1, problems: [] } };

function socketDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-sock-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

type RunFn = (request: { html: string; probe?: string; settleMs?: number }, signal: AbortSignal) => Promise<object>;

async function startWorker(options: { run?: RunFn; selfTest?: (signal: AbortSignal) => Promise<object>; runTimeoutMs?: number } = {}) {
	const socketPath = path.join(socketDir(), "demo.sock");
	const worker = createDemoWorker({
		socketPath,
		run: options.run ?? (async () => CLEAN),
		selfTest: options.selfTest ?? (async () => SANDBOX_REPORT),
		...(options.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
	});
	await worker.listen();
	cleanups.push(() => worker.close());
	// The self-test runs right after listen.
	await new Promise((r) => setTimeout(r, 20));
	return { worker, socketPath };
}

function raw(socketPath: string, method: string, urlPath: string, body?: string, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: any }>((resolve, reject) => {
		const req = http.request({ socketPath, method, path: urlPath, headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers }, (res) => {
			let text = "";
			res.on("data", (c) => { text += c; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function serverReady(socketPath: string) {
	process.env.LH_SERVER_MODE = "tailscale";
	await startServerDemoReadiness({ socketPath });
}

describe("demo worker controller", { timeout: 10_000 }, () => {
	it("is not ready until the sandbox self-test passes", async () => {
		let pass!: () => void;
		const gate = new Promise<void>((r) => { pass = r; });
		const { socketPath } = await startWorker({ selfTest: async () => { await gate; return SANDBOX_REPORT; } });
		assert.equal((await raw(socketPath, "GET", "/health")).status, 503);
		assert.equal((await raw(socketPath, "POST", "/run", JSON.stringify({ html: "<p>x</p>" }))).status, 503);
		pass();
		await new Promise((r) => setTimeout(r, 10));
		const health = await raw(socketPath, "GET", "/health");
		assert.equal(health.status, 200);
		assert.equal(health.body.sandbox.proc.sandboxed, true);
	});

	it("validates the request body", async () => {
		const { socketPath } = await startWorker();
		assert.equal((await raw(socketPath, "POST", "/run", "{not json")).status, 400);
		assert.equal((await raw(socketPath, "POST", "/run", JSON.stringify({ html: "" }))).status, 400);
		assert.equal((await raw(socketPath, "POST", "/run", JSON.stringify({ html: "<p>x</p>", settleMs: 99_999 }))).status, 400);
		assert.equal((await raw(socketPath, "POST", "/run", "x=1", { "Content-Type": "text/plain" })).status, 415);
		const big = await raw(socketPath, "POST", "/run", JSON.stringify({ html: "x".repeat(MAX_DEMO_REQUEST_BYTES) })).catch(() => ({ status: 413 }));
		assert.equal(big.status, 413);
		assert.equal((await raw(socketPath, "GET", "/anything")).status, 404);
		assert.deepEqual(parseRunRequest({ html: "<p>x</p>", probe: "1" }), { request: { html: "<p>x</p>", probe: "1" } });
		assert.match(parseRunRequest({ html: "<p>x</p>", probe: "x".repeat(5000) }).error ?? "", /probe/);
	});

	it("runs one document at a time and refuses beyond two waiting", async () => {
		let active = 0;
		let peak = 0;
		const release: Array<() => void> = [];
		const { socketPath } = await startWorker({
			run: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>((r) => release.push(r));
				active--;
				return CLEAN;
			},
		});
		const body = JSON.stringify({ html: "<p>x</p>" });
		const runs = [raw(socketPath, "POST", "/run", body), raw(socketPath, "POST", "/run", body), raw(socketPath, "POST", "/run", body)];
		await new Promise((r) => setTimeout(r, 50));
		const busy = await raw(socketPath, "POST", "/run", body);
		assert.equal(busy.status, 503);
		assert.match(busy.body.error, /busy/);
		// Release the three runs in turn; each starts only after the previous one ends.
		for (let i = 0; i < 3; i++) {
			const deadline = Date.now() + 2000;
			while (release.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
			assert.equal(release.length, 1, `run ${i + 1} started alone`);
			release.shift()!();
		}
		const results = await Promise.all(runs);
		assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
		assert.equal(peak, 1);
	});

	it("a disconnected client cancels its run", async () => {
		let cancelled: unknown = null;
		const { socketPath } = await startWorker({
			run: (_request, signal) => new Promise((_, reject) => {
				signal.addEventListener("abort", () => { cancelled = signal.reason; reject(signal.reason); });
			}),
		});
		await serverReady(socketPath);
		const controller = new AbortController();
		const run = runServerDemo("<p>x</p>", { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 50));
		controller.abort(new Error("Aborted by learner"));
		await assert.rejects(run, /Aborted by learner/);
		await new Promise((r) => setTimeout(r, 50));
		assert.match(String(cancelled), /client disconnected/);
	});

	it("stops a run at the time limit and answers with a failed result", async () => {
		let aborted = false;
		const { socketPath } = await startWorker({
			runTimeoutMs: 100,
			run: (_request, signal) => new Promise((_, reject) => {
				signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); });
			}),
		});
		const reply = await raw(socketPath, "POST", "/run", JSON.stringify({ html: "<p>x</p>" }));
		assert.equal(reply.status, 200);
		assert.deepEqual(reply.body, timeoutResult(100));
		assert.equal(aborted, true, "the browser run saw the abort (and kills its tree)");
	});

	it("a sandbox refusal during a run takes the worker out of service", async () => {
		const { SandboxRefusal } = await import("../scripts/demo/browser.mjs");
		const { socketPath } = await startWorker({ run: async () => { throw new SandboxRefusal("Chromium sandbox not active: renderer 9: shares the user namespace"); } });
		await serverReady(socketPath);
		assert.equal(isServerCapabilityAvailable("demo"), true);
		await assert.rejects(runServerDemo("<p>x</p>"), /sandbox not active/);
		assert.equal(isServerCapabilityAvailable("demo"), false, "adapter drops readiness at once");
		assert.equal((await raw(socketPath, "GET", "/health")).status, 503, "worker stays refused");
	});
});

describe("server demo adapter", { timeout: 10_000 }, () => {
	it("starts once per process and resolves only after the first probe", async () => {
		const { socketPath } = await startWorker();
		process.env.LH_SERVER_MODE = "tailscale";
		assert.equal(isServerCapabilityAvailable("demo"), false);
		const first = startServerDemoReadiness({ socketPath });
		assert.equal(startServerDemoReadiness(), first, "idempotent");
		assert.equal(isServerCapabilityAvailable("demo"), false, "not admitted before the probe answers");
		await first;
		assert.equal(isServerCapabilityAvailable("demo"), true);
	});

	it("an unreachable or unsandboxed worker never makes demos ready", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		await startServerDemoReadiness({ socketPath: path.join(socketDir(), "missing.sock") });
		assert.equal(isServerCapabilityAvailable("demo"), false);
		const api = createServerHeadless(realHeadless);
		assert.match(api.unavailableReason() ?? "", /worker unreachable/);
		await assert.rejects(runServerDemo("<p>x</p>"), /not available/);

		resetServerDemoReadiness();
		const { socketPath } = await startWorker({ selfTest: async () => ({ proc: { sandboxed: false } }) });
		await startServerDemoReadiness({ socketPath });
		assert.equal(isServerCapabilityAvailable("demo"), false, "ready:true without proof is not enough");
	});

	it("maps results and rejects malformed ones", async () => {
		let reply: object = { ...CLEAN, probeResult: 5, sandbox: SANDBOX_REPORT };
		const { socketPath } = await startWorker({ run: async () => reply });
		await serverReady(socketPath);
		assert.deepEqual(await runServerDemo("<p>x</p>", { probe: "5" }), { ...CLEAN, probeResult: 5 });
		reply = { consoleErrors: "nope", ok: true };
		await assert.rejects(runServerDemo("<p>x</p>"), /malformed/);
	});

	it("refuses malformed, oversized and over-long probes before sending", async () => {
		let calls = 0;
		const { socketPath } = await startWorker({ run: async () => { calls++; return CLEAN; } });
		await serverReady(socketPath);
		await assert.rejects(runServerDemo(""), /empty/);
		await assert.rejects(runServerDemo("x".repeat(600 * 1024)), /limit/);
		await assert.rejects(runServerDemo("<p>x</p>", { probe: "x".repeat(5000) }), /probe/);
		// Within the HTML limit but over the request limit once JSON-escaped.
		await assert.rejects(runServerDemo("\u0001".repeat(200 * 1024)), /larger than/);
		assert.equal(calls, 0);
	});

	it("an absolute deadline bounds a trickling reply", async () => {
		const dir = socketDir();
		const socketPath = path.join(dir, "trickle.sock");
		const trickle = http.createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			const timer = setInterval(() => res.write(" "), 20);
			res.on("close", () => clearInterval(timer));
			if (req.url === "/health") return;
		});
		await new Promise<void>((r) => trickle.listen(socketPath, () => r()));
		cleanups.push(() => new Promise<void>((r) => { trickle.closeAllConnections(); trickle.close(() => r()); }));
		serverDemoTimeouts.healthMs = 300;
		process.env.LH_SERVER_MODE = "tailscale";
		const start = Date.now();
		await startServerDemoReadiness({ socketPath });
		assert.ok(Date.now() - start < 2000, "health probe gave up on time");
		assert.equal(isServerCapabilityAvailable("demo"), false);
	});
});

describe("no local browser on a server", { timeout: 10_000 }, () => {
	it("getHeadless returns the worker adapter, and direct realHeadless.runDemo also goes to the worker", async () => {
		const { socketPath } = await startWorker({ run: async (request) => ({ ...CLEAN, probeResult: request.html }) });
		await serverReady(socketPath);
		const api = getHeadless();
		assert.notEqual(api, realHeadless);
		assert.equal((await api.runDemo("<p>a</p>", { probe: "1" })).probeResult, "<p>a</p>");
		assert.equal((await realHeadless.runDemo("<p>b</p>", { probe: "1" })).probeResult, "<p>b</p>", "direct call routed to the worker");
		resetServerDemoReadiness();
		process.env.LH_SERVER_MODE = "tailscale";
		const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("lh-demo-")).length;
		await assert.rejects(realHeadless.runDemo("<p>c</p>"), /not available/);
		assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("lh-demo-")).length, before, "no temp document written");
	});

	it("desktop keeps the local engine", () => {
		delete process.env.LH_SERVER_MODE;
		assert.equal(getHeadless(), realHeadless);
	});
});

describe("worker seccomp profile", { timeout: 10_000 }, () => {
	const profile = JSON.parse(fs.readFileSync(new URL("../scripts/demo/seccomp.json", import.meta.url), "utf8")) as {
		defaultAction: string;
		syscalls: Array<{ names: string[]; action: string; comment?: string; args?: Array<{ index: number; value: number; valueTwo?: number; op: string }>; includes?: { caps?: string[] }; excludes?: { caps?: string[] } }>;
	};
	const added = profile.syscalls.filter((rule) => rule.comment?.startsWith("learnharness-demo:"));

	it("is Docker's default plus exactly three marked rules", () => {
		assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
		assert.equal(profile.syscalls.length, 33 + 3);
		assert.deepEqual(added.map((r) => r.names), [["clone"], ["unshare"], ["chroot"]]);
	});

	it("allows only user, PID and network namespaces", () => {
		const CLONE_NEWNS = 0x00020000, CLONE_NEWCGROUP = 0x02000000, CLONE_NEWUTS = 0x04000000, CLONE_NEWIPC = 0x08000000;
		for (const rule of added.slice(0, 2)) {
			assert.equal(rule.action, "SCMP_ACT_ALLOW");
			assert.deepEqual(rule.args, [{ index: 0, value: CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }]);
		}
	});

	it("grants nothing else that the default reserves for CAP_SYS_ADMIN", () => {
		const unguarded = profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.includes?.caps && !rule.comment?.startsWith("learnharness-demo:"));
		for (const name of ["mount", "setns", "bpf", "umount2", "pivot_root", "open_tree", "move_mount", "fsopen", "perf_event_open"]) {
			assert.ok(!unguarded.some((rule) => rule.names.includes(name)), name);
		}
	});
});
