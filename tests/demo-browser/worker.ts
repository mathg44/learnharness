/**
 * End-to-end proof of the demo worker through the app's real adapter.
 *
 *   npx tsx tests/demo-browser/worker.ts [image]   (default learnharness-demo-test:dev)
 *
 * Starts disposable worker containers with the production limits (network
 * none, worker seccomp profile, no capabilities, 1 CPU, 1 GiB, 256 PIDs) and
 * only a temporary socket directory mounted. Covers success with a probe,
 * page and console errors, denied network/file/private/app access, malformed
 * and oversized documents, the 60 s timeout, cancellation, a renderer crash,
 * process-tree cleanup, and a worker refusing to run without the sandbox
 * (Docker's default seccomp profile). Not part of `npm test`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resetServerDemoReadiness, runServerDemo, startServerDemoReadiness, createServerHeadless } from "../../src/agent/server-demo.ts";
import { isServerCapabilityAvailable } from "../../src/core/server-capabilities.ts";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const image = process.argv[2] ?? "learnharness-demo-test:dev";

function startWorker(name: string, seccomp: "worker" | "docker-default") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-sock-"));
	fs.chmodSync(dir, 0o700);
	spawnSync("docker", ["rm", "-f", name]);
	execFileSync("docker", [
		"run", "-d", "--name", name, "--network", "none", "--user", "1000:1000", "--init", "--read-only",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
		...(seccomp === "worker" ? ["--security-opt", `seccomp=${path.join(repo, "scripts/demo/seccomp.json")}`] : []),
		"--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
		"--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m", "--tmpfs", "/dev/shm:rw,noexec,nosuid,nodev,size=128m",
		"-v", `${dir}:/run/learnharness-demo`, image,
	]);
	return {
		socketPath: path.join(dir, "demo.sock"),
		/** Chromium processes still alive in the container. */
		chromiumCount(): number {
			const out = execFileSync("docker", ["exec", name, "node", "-e",
				"const fs=require('fs');console.log(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)&&Number(p)!==process.pid).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('chromium')}catch{return false}}).length)"], { encoding: "utf8" });
			return Number(out.trim());
		},
		stop() {
			spawnSync("docker", ["rm", "-f", name]);
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function waitHealthy(socketPath: string, ms = 90_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		resetServerDemoReadiness();
		await startServerDemoReadiness({ socketPath });
		if (isServerCapabilityAvailableInServerMode()) return true;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

function isServerCapabilityAvailableInServerMode(): boolean {
	process.env.LH_SERVER_MODE = "tailscale";
	return isServerCapabilityAvailable("demo");
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const start = Date.now();
	const value = await fn();
	console.log(`ok  ${label} (${((Date.now() - start) / 1000).toFixed(1)} s)`);
	return value;
}

async function main() {
	const worker = startWorker("lh-demo-e2e", "worker");
	try {
		assert.ok(await waitHealthy(worker.socketPath), "worker became healthy");
		const headless = createServerHeadless({ renderSvg: async () => Buffer.alloc(0), renderPdfPages: async () => [] });
		assert.equal(headless.unavailableReason(), null);

		await timed("clean demo with probe", async () => {
			const r = await runServerDemo("<!doctype html><button id=b>go</button><script>window.count=2+3</script>", { probe: "window.count", settleMs: 100 });
			assert.equal(r.ok, true, JSON.stringify(r));
			assert.equal(r.probeResult, 5);
		});
		await timed("page and console errors reported", async () => {
			const r = await runServerDemo("<script>console.error('bad state'); undefinedFn();</script>", { settleMs: 100 });
			assert.equal(r.ok, false);
			assert.ok(r.consoleErrors.some((e) => e.includes("bad state")));
			assert.ok(r.pageErrors.some((e) => /undefinedFn/.test(e)));
		});
		await timed("network, file, private and app addresses denied", async () => {
			const targets = ["https://cdn.jsdelivr.net/npm/x.js", "file:///etc/passwd", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:3000/api/chats", "http://host.docker.internal:3000/"];
			const r = await runServerDemo(`<!doctype html><script>
				window.results = [];
				${JSON.stringify(targets)}.forEach(function (u) { fetch(u).then(function () { results.push("OPEN " + u); }, function () { results.push("denied"); }); });
			</script><img src="http://10.0.0.1/x.png"><script src="https://unpkg.com/react"></script>`, { probe: "new Promise(r => setTimeout(() => r(window.results), 500))", settleMs: 200 });
			assert.equal(r.ok, false);
			assert.deepEqual(r.probeResult, targets.map(() => "denied"));
			assert.ok(r.consoleErrors.some((e) => /Content Security Policy/.test(e)), JSON.stringify(r.consoleErrors));
		});
		await timed("self-navigation refused", async () => {
			const r = await runServerDemo("<script>setTimeout(function(){location.href='https://example.com/'},10)</script>", { settleMs: 500 });
			assert.equal(r.ok, false);
		});
		await timed("non-network navigations away fail the run and are never probed", async () => {
			const away = {
				data: "location.replace('data:text/html,<script>window.ok=1<\\/script>')",
				blob: "location.replace(URL.createObjectURL(new Blob(['<script>window.ok=1<\\/script>'],{type:'text/html'})))",
				about: "location.replace('about:blank')",
			};
			for (const [kind, script] of Object.entries(away)) {
				const r = await runServerDemo(`<script>setTimeout(function(){${script}},10)</script>`, { probe: "window.ok === 1 ? 'replaced' : 'original'", settleMs: 800 });
				assert.equal(r.ok, false, `${kind}: ${JSON.stringify(r)}`);
				// Chromium itself refuses some (top-level data:), the worker fails the rest;
				// either way no replacement document is ever probed as the demo.
				assert.notEqual(r.probeResult, "replaced", `${kind}: probe ran on the replacement`);
				console.log(`    ${kind}: ${[...r.failedRequests, ...r.consoleErrors, ...r.pageErrors].join(" | ").slice(0, 160)}`);
			}
			const fragment = await runServerDemo(`<a id=a href="#part">x</a><p id=part>y</p><script>document.getElementById('a').click()</script>`, { settleMs: 200 });
			assert.equal(fragment.ok, true, `fragment link stays in the document: ${JSON.stringify(fragment)}`);
		});
		await timed("storage and cookies throw (opaque origin)", async () => {
			const r = await runServerDemo("<p>x</p>", { probe: "(() => { try { localStorage.x = 1; return 'open'; } catch (e) { return e.name; } })()", settleMs: 0 });
			assert.equal(r.probeResult, "SecurityError");
		});
		await timed("malformed and oversized refused before the worker", async () => {
			await assert.rejects(runServerDemo("   "), /empty/);
			await assert.rejects(runServerDemo("a\u0000b"), /NUL/);
			await assert.rejects(runServerDemo("x".repeat(600 * 1024)), /limit/);
		});
		await timed("renderer crash reported", async () => {
			const r = await runServerDemo("<script>var a=[];for(;;){a.push(new Array(1e7).fill(1))}</script>", { settleMs: 1000 });
			assert.equal(r.ok, false);
			assert.ok(r.pageErrors.some((e) => /crash|time limit|did not finish/.test(e)), JSON.stringify(r.pageErrors));
		});
		assert.equal(worker.chromiumCount(), 0, "no browser left after the crash run");
		await timed("cancellation kills the browser", async () => {
			const controller = new AbortController();
			const run = runServerDemo("<script>for(;;){}</script>", { signal: controller.signal });
			await new Promise((r) => setTimeout(r, 4000));
			assert.ok(worker.chromiumCount() > 0, "browser running");
			controller.abort(new Error("cancelled by test"));
			await assert.rejects(run, /cancelled by test/);
			await new Promise((r) => setTimeout(r, 3000));
			assert.equal(worker.chromiumCount(), 0, "browser tree killed after cancel");
		});
		// Load (20 s) + settle + probe caps end a hung page well inside the
		// 60 s hard limit; the hard limit itself is unit-tested with a fake run.
		await timed("busy page stopped and its browser killed", async () => {
			const r = await runServerDemo("<script>for(;;){}</script>");
			assert.equal(r.ok, false);
			assert.ok(r.pageErrors.some((e) => /time limit|did not finish/.test(e)), JSON.stringify(r.pageErrors));
			await new Promise((r) => setTimeout(r, 2000));
			assert.equal(worker.chromiumCount(), 0, "browser tree killed after timeout");
		});
		await timed("next run after timeout is clean", async () => {
			const r = await runServerDemo("<p>fine</p>", { settleMs: 0 });
			assert.equal(r.ok, true, JSON.stringify(r));
		});
	} finally {
		worker.stop();
	}

	const refusing = startWorker("lh-demo-e2e-refuse", "docker-default");
	try {
		await timed("worker without the sandbox refuses", async () => {
			await new Promise((r) => setTimeout(r, 10_000));
			resetServerDemoReadiness();
			await startServerDemoReadiness({ socketPath: refusing.socketPath });
			assert.equal(isServerCapabilityAvailableInServerMode(), false);
			await assert.rejects(runServerDemo("<p>x</p>"), /not available/);
			const health = execFileSync("curl", ["-s", "--unix-socket", refusing.socketPath, "http://worker/health"], { encoding: "utf8" });
			assert.match(health, /"ready":false/);
			assert.match(JSON.parse(health).reason, /no usable sandbox/i);
			console.log(`    refusal: ${JSON.parse(health).reason.slice(0, 160)}`);
		});
	} finally {
		refusing.stop();
		resetServerDemoReadiness();
	}
	console.log("demo worker end-to-end: all checks passed");
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
