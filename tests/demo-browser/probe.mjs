/**
 * Runs INSIDE a disposable demo worker container (network none, sandboxed
 * Chromium). Serves synthetic pages on loopback, loads each scenario in a
 * fresh browser with ordinary flags, and reports every request that reached
 * a loopback listener: HTTP hits, UDP datagrams (STUN/TURN/QUIC) and DNS
 * queries. Prints one JSON report. Driven by tests/demo-browser/run.ts.
 */
import { spawn } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { CdpPipe } from "/opt/learnharness-demo/scripts/demo/cdp-pipe.mjs";
import { inspectSandbox, killTree } from "/opt/learnharness-demo/scripts/demo/browser.mjs";

const INPUT = "/input";
// STUN must target a non-loopback address: Chromium gathers no ICE
// candidates on loopback. On a network without one, fall back to loopback.
const stunHost = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";
const withHost = (text) => text.replaceAll("__STUN_HOST__", stunHost);
const scenarios = JSON.parse(fs.readFileSync(path.join(INPUT, "scenarios.json"), "utf8"));
let current = "setup";
/** @type {Record<string, string[]>} */
const hits = {};
const hit = (what) => { (hits[current] ??= []).push(what); };

const server = http.createServer((req, res) => {
	const url = req.url ?? "/";
	const page = url.match(/^\/page\/([\w.-]+)$/)?.[1];
	const scenario = scenarios.find((s) => s.page === page);
	if (scenario && req.method === "GET") {
		const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
		if (scenario.parentCsp) headers["Content-Security-Policy"] = scenario.parentCsp;
		if (scenario.dnsPrefetchOff) headers["X-DNS-Prefetch-Control"] = "off";
		res.writeHead(200, headers);
		res.end(withHost(fs.readFileSync(path.join(INPUT, page), "utf8")));
		return;
	}
	hit(`http ${req.method} ${url}`);
	res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
	res.end();
});
server.on("upgrade", (req, socket) => { hit(`http UPGRADE ${req.url}`); socket.destroy(); });
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));

const udp = [];
for (const [port, label] of [[3478, "stun"], [3479, "turn"], [3480, "stun-nested"], [4433, "quic"], [53, "dns"]]) {
	const socket = dgram.createSocket("udp4");
	socket.on("message", (msg) => hit(`udp ${label}${label === "dns" ? ` ${dnsName(msg)}` : ""}`));
	try {
		await new Promise((resolve, reject) => { socket.once("error", reject); socket.bind(port, "0.0.0.0", resolve); });
		udp.push(label);
	} catch { socket.close(); }
}
const tcp53 = net.createServer((s) => { hit("tcp dns"); s.destroy(); });
tcp53.on("error", () => {});
tcp53.listen(53, "127.0.0.1");

function dnsName(msg) {
	const labels = [];
	let i = 12;
	while (i < msg.length && msg[i] !== 0 && labels.length < 10) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString("ascii")); i += msg[i] + 1; }
	return labels.join(".");
}

const report = { listeners: { udp, stunHost, resolv: fs.readFileSync("/etc/resolv.conf", "utf8").trim() }, scenarios: {} };

for (const scenario of scenarios) {
	current = scenario.name;
	hits[current] = [];
	const home = fs.mkdtempSync("/tmp/lh-probe-");
	let url = `http://127.0.0.1:8080/page/${scenario.page}`;
	if (scenario.kind === "file") {
		fs.writeFileSync(path.join(home, scenario.page), withHost(fs.readFileSync(path.join(INPUT, scenario.page), "utf8")));
		url = `file://${path.join(home, scenario.page)}`;
	}
	const child = spawn("/usr/lib/chromium/chromium", [
		"--headless", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
		`--user-data-dir=${path.join(home, "profile")}`, "about:blank",
	], { detached: true, env: { PATH: "/usr/bin:/bin", HOME: home, DBUS_SESSION_BUS_ADDRESS: "disabled:" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
	const cdp = new CdpPipe(child.stdio[3], child.stdio[4]);
	const logs = [];
	const out = { url, hits: hits[current] };
	try {
		const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		cdp.on(({ method, params }) => {
			if (method === "Log.entryAdded" && logs.length < 60) logs.push(`${params.entry.source}/${params.entry.level}: ${params.entry.text.slice(0, 200)}`);
		});
		await cdp.send("Log.enable", {}, sessionId);
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Page.navigate", { url }, sessionId);
		await new Promise((resolve) => setTimeout(resolve, scenario.waitMs ?? 7000));
		const evaluated = await cdp.send("Runtime.evaluate", { expression: "window.__results ?? null", returnByValue: true }, sessionId);
		out.results = evaluated.result?.value ?? null;
		const tree = await cdp.send("Page.getFrameTree", {}, sessionId);
		out.frames = (tree.frameTree.childFrames ?? []).map((f) => f.frame.url + (f.frame.urlFragment ?? ""));
		out.sandbox = inspectSandbox(child.pid);
		out.logs = logs;
	} catch (error) {
		out.error = String(error?.message ?? error);
	} finally {
		cdp.close();
		killTree(child.pid);
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	}
	report.scenarios[scenario.name] = out;
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(0);
