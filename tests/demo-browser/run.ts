/**
 * Real-Chromium proof of the server display and download policy for demos.
 * The worker itself has no network; in the learner's browser the demo is
 * network-restricted with two known residual channels (see check()).
 *
 * Run WebRTC checks on a disposable internal network so ICE has an
 * interface: `docker network create --internal lh-demo-probe-net` and
 * LH_DEMO_PROBE_NETWORK=lh-demo-probe-net; remove the network afterwards.
 *
 *   npx tsx tests/demo-browser/run.ts [image]   (default learnharness-demo-test:dev)
 *
 * Builds synthetic pages with the production document builders, mounts
 * them read-only into a disposable demo worker container (network none, the
 * worker seccomp profile, no other mounts) and runs probe.mjs there. Prints
 * the raw report, then checks: no request of any kind reaches a loopback
 * listener from the server display or the downloaded file, while the
 * control without the parent header shows why the header is required.
 * Not part of `npm test`: it needs Docker and the worker image.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFLINE_DEMO_PARENT_CSP } from "../../src/core/demo-document-policy.ts";
import { demoDownloadFor, demoSrcDocFor } from "../../components/artifacts/demo-card.tsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const image = process.argv[2] ?? "learnharness-demo-test:dev";
// WebRTC needs a non-loopback interface to gather ICE candidates. Pass a
// disposable `docker network create --internal` network to give it one
// with no route anywhere; the default is no network at all.
const network = process.env.LH_DEMO_PROBE_NETWORK ?? "none";

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
// The parent stands in for the server chat page: same iframe attributes as
// DemoFrame, plus a listener that records what the demo reports.
const parent = (srcDoc: string) => `<!doctype html><html><head><meta charset="utf-8"><title>parent</title></head><body>
<script>window.__results={};addEventListener("message",function(e){var d=e.data;if(d&&d.type==="probe")window.__results[d.name]=d.outcome;});</script>
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttr(srcDoc)}"></iframe></body></html>`;

export function buildInputs(dir: string) {
	const payloads = Object.fromEntries(["attack", "navigate-meta", "navigate-link", "webrtc"].map((name) => [
		name, fs.readFileSync(path.join(here, `${name}.html`), "utf8"),
	]));
	const scenarios: Array<{ name: string; page: string; kind: "http" | "file"; parentCsp?: string; dnsPrefetchOff?: boolean; waitMs?: number }> = [];
	for (const [name, html] of Object.entries(payloads)) {
		fs.writeFileSync(path.join(dir, `display-${name}.html`), parent(demoSrcDocFor(html, "offline")));
		fs.writeFileSync(path.join(dir, `download-${name}.html`), demoDownloadFor(name, html, "offline"));
		scenarios.push({ name: `display-${name}`, page: `display-${name}.html`, kind: "http", parentCsp: OFFLINE_DEMO_PARENT_CSP, dnsPrefetchOff: true });
		scenarios.push({ name: `download-${name}`, page: `download-${name}.html`, kind: "file" });
	}
	// Controls: what the meta CSP alone allows, and the desktop document.
	fs.writeFileSync(path.join(dir, "control-meta-only.html"), parent(demoSrcDocFor(payloads["attack"]!, "offline")));
	scenarios.push({ name: "control-meta-only", page: "control-meta-only.html", kind: "http" });
	fs.writeFileSync(path.join(dir, "control-desktop.html"), parent(demoSrcDocFor(payloads["attack"]!, "desktop")));
	scenarios.push({ name: "control-desktop", page: "control-desktop.html", kind: "http" });
	fs.writeFileSync(path.join(dir, "scenarios.json"), JSON.stringify(scenarios));
	fs.copyFileSync(path.join(here, "probe.mjs"), path.join(dir, "probe.mjs"));
}

function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-browser-"));
	try {
		buildInputs(dir);
		fs.chmodSync(dir, 0o755);
		const result = spawnSync("docker", [
			"run", "--rm", "--network", network, "--user", "1000:1000", "--init", "--read-only",
			"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
			"--security-opt", `seccomp=${path.join(repo, "scripts/demo/seccomp.json")}`,
			"--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
			"--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m", "--tmpfs", "/dev/shm:rw,noexec,nosuid,nodev,size=128m",
			// A loopback resolver so DNS lookups become observable.
			"--dns", "127.0.0.1", "--sysctl", "net.ipv4.ip_unprivileged_port_start=53",
			"-v", `${dir}:/input:ro`, "--entrypoint", "node", image, "/input/probe.mjs",
		], { encoding: "utf8", timeout: 300_000 });
		if (result.status !== 0) throw new Error(`probe container failed: ${result.stderr}`);
		const report = JSON.parse(result.stdout.trim().split("\n").pop()!);
		console.log(JSON.stringify(report, null, 1));
		check(report);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Requests the demo could cause. Excludes the probe browser's own
 *  background traffic (component updater lookups, the parent's favicon). */
export function demoHits(hits: string[]): string[] {
	return hits.filter((h) => /\/hit\/|\.test\b|^udp (stun|turn|quic)/.test(h));
}

/** The owner-accepted residuals: DNS lookups from preconnect and
 *  dns-prefetch link hints (static or script-created), and WebRTC
 *  STUN/TURN UDP. X-DNS-Prefetch-Control: off on the parent does not stop
 *  explicit link hints in Chromium 156. */
const RESIDUAL = /^udp dns (dynamic-)?(preconnect|dns-prefetch)-leak\.test$|^udp (stun|turn|stun-nested)$/;

/** Anything outside the accepted residuals is a policy failure. */
export function unexpectedHits(hits: string[]): string[] {
	return [...new Set(demoHits(hits).filter((h) => !RESIDUAL.test(h)))];
}

type Scenario = { hits: string[]; results: Record<string, string> | null; frames: string[]; sandbox: { sandboxed: boolean }; error?: string };

export function check(report: { listeners: { udp: string[]; stunHost: string }; scenarios: Record<string, Scenario> }) {
	assert.deepEqual(report.listeners.udp.sort(), ["dns", "quic", "stun", "stun-nested", "turn"]);
	for (const [name, scenario] of Object.entries(report.scenarios)) {
		assert.equal(scenario.error, undefined, `${name}: ${scenario.error}`);
		assert.equal(scenario.sandbox.sandboxed, true, `${name}: browser sandbox`);
		if (name.startsWith("control-")) continue;
		assert.deepEqual(unexpectedHits(scenario.hits), [], `${name}: requests escaped the policy`);
		if (!/-(attack|webrtc)$/.test(name)) assert.deepEqual(demoHits(scenario.hits), [], `${name}: navigation probe made requests`);
	}
	const display = report.scenarios["display-attack"]!;
	assert.ok(display.results, "the demo ran and reported");
	for (const storage of ["localStorage", "sessionStorage", "cookie", "parent-dom", "top-dom"]) {
		assert.match(display.results![storage] ?? "", /threw|rejected/, `${storage} must fail`);
	}
	// The control proves the header matters: meta CSP alone lets the frame
	// navigate itself to the network.
	assert.ok(report.scenarios["control-meta-only"]!.hits.some((h) => h.includes("/hit/self-navigation")), "control: meta CSP does not stop self-navigation");
	assert.ok(report.scenarios["control-desktop"]!.hits.length > 0, "control: desktop documents are unrestricted");
	if (report.listeners.stunHost !== "127.0.0.1") {
		// With an interface to gather on, the residual is real: record it.
		const webrtc = demoHits(report.scenarios["display-webrtc"]!.hits);
		console.log(`residual WebRTC from the server display: ${webrtc.length > 0 ? [...new Set(webrtc)].join(", ") : "none observed"}`);
	}
	console.log("server display and download policy: all checks passed (residuals as documented)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
