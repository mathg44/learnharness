import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitFreshEnforcement, awaitSettledTopology, enforcementReady, removeStatus, statusFor, topologyFingerprint, writeStatus } from "../scripts/egress/state.mjs";

const POLICY = Buffer.from('{"version":1,"profile":"app","inference":{"address":"10.20.30.40","port":8080}}');
const POLICY_HASH = createHash("sha256").update(POLICY).digest("hex");
const NAMESPACE = "net:[4026532000]";
const BOOT_ID = "0f1e2d3c-4b5a-4968-8778-a1b2c3d4e5f6";

type Dad = "tentative" | "optimistic" | "dadfailed";

/** Shaped like `ip -j` output from a Docker container. Once DAD finishes the
 * kernel adds a local-table host route for the link-local address. */
function topology({ lifetime = 4294967295, dad = undefined as Dad | undefined, localRoute = true, expires = 1715, operstate = "UP", address = "10.20.30.5", resolvConf = "nameserver 127.0.0.11\noptions ndots:0\n" } = {}) {
	return {
		links: [{ ifindex: 7, ifname: "eth0", flags: ["BROADCAST", "UP", "LOWER_UP"], mtu: 1500, operstate, link_type: "ether", address: "02:42:0a:14:1e:05",
			addr_info: [
				{ family: "inet", local: address, prefixlen: 16, scope: "global", label: "eth0", valid_life_time: lifetime, preferred_life_time: lifetime },
				{ family: "inet6", local: "fe80::42:aff:fe14:1e05", prefixlen: 64, scope: "link", ...(dad ? { [dad]: true } : {}), valid_life_time: lifetime, preferred_life_time: lifetime },
			] }],
		routes: [
			{ dst: "default", gateway: "10.20.30.1", dev: "eth0", flags: [] },
			{ dst: "fd00:1::/64", dev: "eth0", protocol: "ra", metric: 1024, flags: [], expires, pref: "medium" },
			...(localRoute ? [{ type: "local", dst: "fe80::42:aff:fe14:1e05", dev: "eth0", table: "local", protocol: "kernel", metric: 0, flags: [], pref: "medium" }] : []),
		],
		rules: [{ priority: 0, src: "all", table: "local" }, { priority: 32766, src: "all", table: "main" }],
		resolvConf,
	};
}

const TOPOLOGY = topologyFingerprint(topology());

type Entry = { uid: number; mode: number; kind: "file" | "dir" | "link"; bytes?: Buffer };

/** In-memory filesystem, clock and network view at the readiness boundary. */
function system({ bootId = BOOT_ID, network = topology(), now = 10_000, status = {} as Record<string, unknown>, entries = {} as Record<string, Partial<Entry>> } = {}) {
	const base: Record<string, Entry> = {
		"/": { uid: 0, mode: 0o755, kind: "dir" },
		"/run": { uid: 0, mode: 0o755, kind: "dir" },
		"/run/lh-egress": { uid: 0, mode: 0o755, kind: "dir" },
		"/run/lh-egress/status.json": { uid: 0, mode: 0o644, kind: "file", bytes: Buffer.from(JSON.stringify({
			version: 1, profile: "app", bootId: BOOT_ID, namespace: NAMESPACE, policyHash: POLICY_HASH, topologyHash: TOPOLOGY,
			updatedAtUptimeMs: 9_500, expiresAtUptimeMs: 14_500, ...status,
		})) },
		"/etc/learnharness/egress.json": { uid: 0, mode: 0o444, kind: "file", bytes: POLICY },
	};
	const files: Record<string, Entry> = { ...base };
	for (const [path, change] of Object.entries(entries)) files[path] = { ...(files[path] ?? { uid: 0, mode: 0o644, kind: "file" }), ...change };
	const entry = (path: string) => {
		const found = files[path];
		if (!found) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
		return found;
	};
	return {
		lstat: (path: string) => {
			const found = entry(path);
			return { uid: found.uid, mode: found.mode, isFile: () => found.kind === "file", isDirectory: () => found.kind === "dir" };
		},
		readFile: (path: string) => {
			const found = entry(path);
			if (found.kind !== "file" || !found.bytes) throw new Error(`EISDIR ${path}`);
			return found.bytes;
		},
		uptimeMs: () => now,
		bootId: () => bootId,
		namespace: () => NAMESPACE,
		topology: () => network,
	};
}

test("a fresh guard status for this policy, namespace and topology is ready", () => {
	assert.equal(enforcementReady({ system: system() }), true);
});

test("a lease that expires during network inspection is not ready", () => {
	let now = 10_000;
	const fake = system();
	fake.uptimeMs = () => now;
	fake.topology = () => { now = 14_500; return topology(); };
	assert.equal(enforcementReady({ system: fake }), false);
});

test("anything stale, foreign or tamperable is not ready", () => {
	const cases: Array<[string, ReturnType<typeof system>, ("app" | "browser")?]> = [
		["expired lease", system({ now: 14_500 })],
		["status from the future", system({ now: 9_499 })],
		["lease longer than five seconds", system({ status: { expiresAtUptimeMs: 14_501 } })],
		["other profile", system(), "browser"],
		["status for other profile", system({ status: { profile: "browser" } })],
		["policy edited by one byte", system({ entries: { "/etc/learnharness/egress.json": { bytes: Buffer.from(`${POLICY} `) } } })],
		["invalid policy", system({ entries: { "/etc/learnharness/egress.json": { bytes: Buffer.from("{}") } } })],
		["status from another boot", system({ bootId: "6f5e4d3c-2b1a-4098-8776-655443322110" })],
		["malformed boot id", system({ status: { bootId: "not-a-uuid" }, bootId: "not-a-uuid" })],
		["other namespace", system({ status: { namespace: "net:[4026532001]" } })],
		["unsupported resolver", system({ network: topology({ resolvConf: "nameserver 127.0.0.11\nnameserver 1.1.1.1\n" }) })],
		["other topology", system({ status: { topologyHash: "b".repeat(64) } })],
		["extra status key", system({ status: { healthy: true } })],
		["string time", system({ status: { expiresAtUptimeMs: "14500" } })],
		["missing status", system({ entries: { "/run/lh-egress/status.json": { kind: "dir" } } })],
		["group-writable status", system({ entries: { "/run/lh-egress/status.json": { mode: 0o664 } } })],
		["app-owned status", system({ entries: { "/run/lh-egress/status.json": { uid: 1000 } } })],
		["symlinked status directory", system({ entries: { "/run/lh-egress": { kind: "link" } } })],
		["app-owned status directory", system({ entries: { "/run/lh-egress": { uid: 1000 } } })],
		["world-writable parent", system({ entries: { "/run": { mode: 0o1777 } } })],
	];
	for (const [label, fake, profile] of cases) assert.equal(enforcementReady({ system: fake, profile }), false, label);
});

test("topology fingerprint ignores lifetimes and link state but sees address and resolver changes", () => {
	const baseline = topologyFingerprint(topology());
	assert.equal(topologyFingerprint(topology({ lifetime: 300, dad: "tentative", expires: 12, operstate: "LOWERLAYERDOWN" })), baseline);
	assert.notEqual(topologyFingerprint(topology({ address: "10.20.30.6" })), baseline);
	assert.notEqual(topologyFingerprint(topology({ resolvConf: "nameserver 1.1.1.1\n" })), baseline);
});

test("readiness is false while IPv6 DAD is pending or failed, even with a matching hash", () => {
	for (const [label, network] of [
		["tentative", topology({ dad: "tentative", localRoute: false })],
		["optimistic", topology({ dad: "optimistic" })],
		["dadfailed", topology({ dad: "dadfailed", localRoute: false })],
		["no local host route", topology({ localRoute: false })],
	] as const) {
		const fake = system({ network, status: { topologyHash: topologyFingerprint(network) } });
		assert.equal(enforcementReady({ system: fake }), false, label);
	}
});

test("a settled link-local route that later disappears is a topology change", () => {
	assert.equal(enforcementReady({ system: system({ network: topology({ localRoute: false }) }) }), false);
	assert.notEqual(topologyFingerprint(topology({ localRoute: false })), TOPOLOGY);
});

/** Replays `ip -j` snapshots on a fake clock that each sleep advances. */
function startup(snapshots: ReturnType<typeof topology>[]) {
	let now = 0;
	let reads = 0;
	const settled = awaitSettledTopology({
		read: () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
		now: () => now,
		sleep: async (ms: number) => { now += ms; },
	});
	return { settled, elapsed: () => now };
}

test("guard startup waits for DAD and the link-local host route before its baseline", async () => {
	const run = startup([topology({ dad: "tentative", localRoute: false }), topology({ localRoute: false }), topology()]);
	assert.equal(topologyFingerprint(await run.settled), TOPOLOGY);
	assert.ok(run.elapsed() < 5000);
});

test("guard startup fails closed on failed DAD or a network that never settles in five seconds", async () => {
	await assert.rejects(startup([topology({ dad: "tentative", localRoute: false }), topology({ dad: "dadfailed", localRoute: false })]).settled, /DAD failed/);
	const stuck = startup([topology({ dad: "tentative", localRoute: false })]);
	await assert.rejects(stuck.settled, /did not settle/);
	assert.ok(stuck.elapsed() >= 5000 && stuck.elapsed() < 5200);
});

/** A guard heartbeat on a fake clock: `beat(at)` rewrites the status as if a
 * live guard renewed it at uptime `at`. Every sleep advances the clock. */
function heartbeat({ start = 10_000 } = {}) {
	let now = start;
	let status = system().readFile("/run/lh-egress/status.json");
	let topologyReads = 0;
	const fake = () => ({
		...system({ now }),
		readFile: (file: string) => file === "/run/lh-egress/status.json" ? status : system().readFile(file),
		topology: () => { topologyReads++; return topology(); },
	});
	const beat = (at: number) => {
		status = Buffer.from(JSON.stringify({ ...JSON.parse(String(status)), updatedAtUptimeMs: at, expiresAtUptimeMs: at + 5000 }));
	};
	const sleeps: number[] = [];
	return {
		beat, fake, sleeps, topologyReads: () => topologyReads, now: () => now,
		deps: { sleep: async (ms: number) => { sleeps.push(ms); now += ms; } },
	};
}

test("a still-unexpired marker from before startup cannot prove a fresh guard", () => {
	// Same boot, same reused namespace inode and topology: only the age differs.
	const clock = heartbeat();
	assert.equal(enforcementReady({ system: clock.fake() }), true);
	assert.equal(enforcementReady({ system: clock.fake(), notBeforeUptimeMs: 9_500 }), false);
	assert.equal(clock.topologyReads(), 1);
});

test("fresh startup waits for a newer heartbeat from a live guard", async () => {
	const clock = heartbeat();
	const fresh = awaitFreshEnforcement({ system: { ...clock.fake(), uptimeMs: () => clock.now(), readFile: (file: string) => clock.fake().readFile(file) } },
		{ sleep: async (ms: number) => { await clock.deps.sleep(ms); if (clock.now() >= 10_300) clock.beat(clock.now()); } });
	assert.equal(await fresh, true);
	assert.deepEqual(clock.sleeps, [100, 100, 100]);
});

test("fresh startup fails closed when no newer heartbeat arrives within five seconds", async () => {
	const clock = heartbeat();
	const system = { ...clock.fake(), uptimeMs: () => clock.now(), readFile: (file: string) => clock.fake().readFile(file) };
	assert.equal(await awaitFreshEnforcement({ system }, clock.deps), false);
	assert.equal(clock.now(), 15_000);
	assert.equal(clock.topologyReads(), 0);
});

test("status the guard writes is ready for the app until the lease runs out", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-egress-"));
	try {
		const policyPath = path.join(root, "egress.json");
		const statusPath = path.join(root, "status", "status.json");
		fs.writeFileSync(policyPath, POLICY);
		writeStatus(statusPath, statusFor({ profile: "app", bootId: BOOT_ID, policyBytes: POLICY, namespace: NAMESPACE, topologyHash: TOPOLOGY, nowMs: 9_500 }));
		assert.equal(fs.statSync(statusPath).mode & 0o777, 0o644);
		assert.equal(fs.statSync(path.dirname(statusPath)).mode & 0o777, 0o755);
		// The temporary tree belongs to the test user; pretend root owns it.
		const asRoot = (now: number) => ({ ...system({ now }), readFile: (file: string) => fs.readFileSync(file),
			lstat: (file: string) => Object.assign(fs.lstatSync(file), { uid: 0, mode: fs.lstatSync(file).mode & ~0o022 }) });
		const ready = (now: number) => enforcementReady({ policyPath, statusPath, system: asRoot(now) });
		assert.deepEqual([ready(9_500), ready(14_499), ready(14_500)], [true, true, false]);
		removeStatus(statusPath);
		assert.equal(ready(9_500), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// The real guard in an unprivileged user, network and mount namespace, with a
// private tmpfs over /run. Host root files appear as uid 65534 there.
const DRIVER = String.raw`
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { inspectTable } from "./scripts/egress/policy.mjs";
import { enforcementReady } from "./scripts/egress/state.mjs";
const [policyPath, mode, resolvConf] = process.argv.slice(1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lstat = (file) => { const stat = fs.lstatSync(file); return Object.assign(stat, { uid: stat.uid === 65534 ? 0 : stat.uid }); };
const ready = () => enforcementReady({ policyPath, system: { lstat } });
const grants = () => JSON.parse(execFileSync("nft", ["-j", "list", "set", "inet", "lh_egress", "public_tcp"], { encoding: "utf8" }))
	.nftables.find((item) => item.set).set.elem?.length ?? 0;
// A synthetic resolv.conf, written where /etc/resolv.conf points. If that is
// under /run it lands in the new tmpfs, otherwise it is bind-mounted over.
const resolver = fs.realpathSync("/etc/resolv.conf");
execFileSync("mount", ["-t", "tmpfs", "-o", "mode=755", "tmpfs", "/run"]);
const synthetic = resolver.startsWith("/run/") ? resolver : "/run/lh-test-resolv.conf";
fs.mkdirSync(synthetic.slice(0, synthetic.lastIndexOf("/")), { recursive: true });
fs.writeFileSync(synthetic, resolvConf);
if (synthetic !== resolver) execFileSync("mount", ["--bind", synthetic, "/etc/resolv.conf"]);
// Loopback is up and a local server listens on a port no rule grants.
execFileSync("ip", ["link", "set", "lo", "up"]);
// A veth pair runs real IPv6 DAD, so link-local addresses start tentative.
if (mode === "veth") {
	execFileSync("ip", ["link", "add", "v0", "type", "veth", "peer", "name", "v1"]);
	for (const link of ["v0", "v1"]) execFileSync("ip", ["link", "set", link, "up"]);
}
const server = net.createServer((socket) => socket.end()).listen(4000, "127.0.0.1");
const probe = () => new Promise((resolve) => {
	const socket = net.connect({ host: "127.0.0.1", port: 4000, timeout: 500 });
	socket.on("connect", () => { socket.destroy(); resolve("open"); });
	socket.on("timeout", () => { socket.destroy(); resolve("blocked"); });
	socket.on("error", () => resolve("blocked"));
});
const clean = () => { try { inspectTable(execFileSync("nft", ["-j", "list", "table", "inet", "lh_egress"], { encoding: "utf8" })); return true; } catch { return false; } };
const guard = spawn(process.execPath, ["scripts/egress/guard.mjs", policyPath], { stdio: "ignore" });
let exit = null;
guard.on("exit", (code) => { exit = code; });
for (let i = 0; i < 80 && !ready(); i++) await sleep(100);
const before = { ready: ready(), grants: grants(), probe: await probe() };
const nft = (...args) => execFileSync("nft", args);
if (mode === "tamper") nft("add", "rule", "inet", "lh_egress", "output", "tcp", "dport", "22", "accept");
else if (mode === "accept") nft("insert", "rule", "inet", "lh_egress", "output", "accept");
else if (mode === "policy") nft("chain", "inet", "lh_egress", "output", "{ policy accept; }");
else if (mode === "term") guard.kill("SIGTERM");
await sleep(2500);
const after = { ready: ready(), grants: grants(), status: fs.existsSync("/run/lh-egress/status.json"), exit, clean: clean(), probe: await probe() };
guard.kill("SIGKILL");
server.close();
console.log(JSON.stringify({ before, after }));
`;
// Optional kernel checks: the default suite needs no namespaces or root.
// Run with LH_EGRESS_KERNEL_TESTS=1 where unprivileged user namespaces work.
const skip = process.env.LH_EGRESS_KERNEL_TESTS === "1" ? false : "set LH_EGRESS_KERNEL_TESTS=1 to run";
const DOCKER_RESOLVER = "nameserver 127.0.0.11\noptions ndots:0\n";

function runGuard(mode: "term" | "tamper" | "accept" | "policy" | "veth" | "none", resolvConf = DOCKER_RESOLVER) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-egress-guard-"));
	try {
		const policyPath = path.join(root, "egress.json");
		fs.writeFileSync(policyPath, POLICY);
		const args = ["-rnm", process.execPath, "--input-type=module", "-e", DRIVER, policyPath, mode, resolvConf];
		const result = spawnSync("unshare", args, { encoding: "utf8", timeout: 15_000 });
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("guard grants a lease and closes it on SIGTERM", { skip }, () => {
	assert.deepEqual(runGuard("term"), {
		before: { ready: true, grants: 2, probe: "blocked" },
		after: { ready: false, grants: 0, status: false, exit: 0, clean: true, probe: "blocked" },
	});
});

test("guard latches closed and restores its deny-first table, still running, when the table is changed", { skip }, () => {
	for (const mode of ["tamper", "accept", "policy"] as const) {
		assert.deepEqual(runGuard(mode), {
			before: { ready: true, grants: 2, probe: "blocked" },
			after: { ready: false, grants: 0, status: false, exit: null, clean: true, probe: "blocked" },
		}, mode);
	}
});

test("guard waits out real IPv6 DAD on a new veth pair and stays ready", { skip }, () => {
	assert.deepEqual(runGuard("veth"), {
		before: { ready: true, grants: 2, probe: "blocked" },
		after: { ready: true, grants: 2, status: true, exit: null, clean: true, probe: "blocked" },
	});
});

test("guard refuses to start behind a resolver other than Docker's", { skip }, () => {
	assert.deepEqual(runGuard("none", "nameserver 127.0.0.11\nnameserver 1.1.1.1\n"), {
		before: { ready: false, grants: 0, probe: "blocked" },
		after: { ready: false, grants: 0, status: false, exit: 1, clean: true, probe: "blocked" },
	});
});

test("default paths on a machine without a guard are not ready", () => {
	assert.equal(enforcementReady(), false);
	const health = spawnSync(process.execPath, ["scripts/egress/healthcheck.mjs"], { encoding: "utf8" });
	assert.deepEqual([health.status, health.stderr], [1, ""]);
});
