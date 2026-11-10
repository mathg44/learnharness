/** Egress guard status: the lease the guard renews and the app checks.
 * Readiness comes only from guard-written root files plus the live
 * namespace and topology, never from environment variables. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDockerResolver, parsePolicy } from "./policy.mjs";

export const DEFAULT_POLICY_PATH = "/etc/learnharness/egress.json";
export const DEFAULT_STATUS_PATH = "/run/lh-egress/status.json";
export const REFRESH_MS = 1000;
export const LEASE_MS = 5000;

/**
 * @typedef {{ version: 1, profile: "app" | "browser", bootId: string, namespace: string, policyHash: string,
 *   topologyHash: string, updatedAtUptimeMs: number, expiresAtUptimeMs: number }} Status
 * @typedef {{ uid: number, mode: number, isFile(): boolean, isDirectory(): boolean }} Stat
 * @typedef {{ lstat(path: string): Stat, readFile(path: string): Buffer, uptimeMs(): number,
 *   bootId(): string, namespace(): string, topology(): Topology }} System
 */

/** @type {System} */
export const realSystem = {
	lstat: (file) => fs.lstatSync(file),
	readFile: (file) => fs.readFileSync(file),
	uptimeMs,
	bootId: currentBootId,
	namespace: currentNamespace,
	topology: readTopology,
};

/** Boot-clock milliseconds, shared by every process on the host. */
export function uptimeMs() {
	return Math.round(os.uptime() * 1000);
}

/** Kernel boot identity. Namespace inodes and the uptime clock both repeat
 * across reboots, so a status persisted from an earlier boot must not match. */
export function currentBootId() {
	return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

export function currentNamespace() {
	return fs.readlinkSync("/proc/self/ns/net");
}

export function sha256(/** @type {Buffer | string} */ bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** True only while a root-written, unexpired guard lease matches the exact
 * policy bytes, this network namespace and the current settled topology
 * behind Docker's resolver. With notBeforeUptimeMs, the status must also be
 * renewed strictly after that time; older markers fail before any ip probe.
 * @param {ReadinessOptions} [options] */
export function enforcementReady(options = {}) {
	const { policyPath = DEFAULT_POLICY_PATH, statusPath = DEFAULT_STATUS_PATH, profile = "app" } = options;
	const system = { ...realSystem, ...options.system };
	try {
		const policyBytes = system.readFile(policyPath);
		if (parsePolicy(policyBytes).profile !== profile) return false;
		if (!rootOwnedPath(system, statusPath)) return false;
		const status = parseStatus(system.readFile(statusPath));
		if (options.notBeforeUptimeMs !== undefined && !(status.updatedAtUptimeMs > options.notBeforeUptimeMs)) return false;
		const topology = system.topology();
		if (topologyState(topology) !== "settled") return false;
		checkDockerResolver(topology.resolvConf);
		const matches = status.profile === profile
			&& status.policyHash === sha256(policyBytes)
			&& status.expiresAtUptimeMs - status.updatedAtUptimeMs <= LEASE_MS
			&& status.bootId === system.bootId()
			&& status.namespace === system.namespace()
			&& status.topologyHash === topologyFingerprint(topology);
		// Network inspection runs subprocesses and can outlast the lease.
		// Sample the clock after every probe, never before potentially slow IO.
		const now = system.uptimeMs();
		return matches && status.updatedAtUptimeMs <= now && now < status.expiresAtUptimeMs;
	} catch {
		return false;
	}
}

/**
 * @typedef {{ policyPath?: string, statusPath?: string, profile?: "app" | "browser",
 *   notBeforeUptimeMs?: number, system?: Partial<System> }} ReadinessOptions
 */

/** Readiness proven by a heartbeat written after this call began. A status
 * left by a dead guard can match a reused namespace inode on the same boot
 * for up to one lease, so startup and health checks must see a live renewal.
 * Polls every 100 ms for at most one lease (5 s); false on timeout.
 * @param {Omit<ReadinessOptions, "notBeforeUptimeMs">} [options]
 * @param {{ sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {Promise<boolean>} */
export async function awaitFreshEnforcement(options = {}, deps = {}) {
	const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
	const clock = options.system?.uptimeMs ?? uptimeMs;
	const start = clock();
	for (;;) {
		if (enforcementReady({ ...options, notBeforeUptimeMs: start })) return true;
		if (clock() >= start + LEASE_MS) return false;
		await sleep(100);
	}
}

/** Whether IPv6 duplicate address detection has finished. While an address
 * is tentative or optimistic, or its local-table host route has not appeared
 * yet, the topology is still changing. A failed DAD never recovers.
 * The fingerprint ignores these flags, so guard and readiness check them here.
 * @param {Topology} topology @returns {"settled" | "pending" | "failed"} */
export function topologyState(topology) {
	const links = /** @type {Array<{ ifname?: string, addr_info?: Array<Record<string, unknown>> }>} */ (Array.isArray(topology.links) ? topology.links : []);
	const routes = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(topology.routes) ? topology.routes : []);
	const addresses = links.flatMap((link) => (link.addr_info ?? []).map((address) => ({ ...address, dev: link.ifname })));
	if (addresses.some((address) => address.dadfailed)) return "failed";
	const pending = addresses.some((address) => address.tentative || address.optimistic
		|| (address.family === "inet6" && !routes.some((route) => route.type === "local" && route.table === "local"
			&& route.dev === address.dev && (route.dst === address.local || route.dst === `${address.local}/128`))));
	return pending ? "pending" : "settled";
}

/** Poll until the topology settles, for at most one lease (5 s). Throws on
 * failed DAD or timeout, so guard startup exits without granting anything.
 * @param {{ read?: () => Topology, now?: () => number, sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {Promise<Topology>} */
export async function awaitSettledTopology(deps = {}) {
	const { read = readTopology, now = uptimeMs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
	const deadline = now() + LEASE_MS;
	for (;;) {
		const topology = read();
		const state = topologyState(topology);
		if (state === "settled") return topology;
		if (state === "failed") throw new Error("IPv6 DAD failed");
		if (now() >= deadline) throw new Error(`network did not settle within ${LEASE_MS} ms`);
		await sleep(100);
	}
}

/** A lease for the current state, starting now. bootId defaults to this boot.
 * @param {{ profile: "app" | "browser", bootId?: string, policyBytes: Buffer, namespace: string, topologyHash: string, nowMs: number }} input
 * @returns {Status} */
export function statusFor({ profile, bootId = currentBootId(), policyBytes, namespace, topologyHash, nowMs }) {
	return { version: 1, profile, bootId, namespace, policyHash: sha256(policyBytes), topologyHash, updatedAtUptimeMs: nowMs, expiresAtUptimeMs: nowMs + LEASE_MS };
}

/** Atomic replace with directory 0755 and file 0644, readable by the app.
 * @param {string} statusPath @param {Status} status */
export function writeStatus(statusPath, status) {
	const directory = path.dirname(statusPath);
	fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
	fs.chmodSync(directory, 0o755);
	const temporary = path.join(directory, `.${path.basename(statusPath)}.${process.pid}.tmp`);
	const fd = fs.openSync(temporary, "w", 0o644);
	try {
		fs.writeFileSync(fd, JSON.stringify(status));
		fs.fchmodSync(fd, 0o644);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(temporary, statusPath);
}

export function removeStatus(/** @type {string} */ statusPath) {
	fs.rmSync(statusPath, { force: true });
}

/** The file and every ancestor are root-owned, not group/other writable and
 * not symlinks, so only root could have written or swapped the status. */
function rootOwnedPath(/** @type {System} */ system, /** @type {string} */ file) {
	const resolved = path.resolve(file);
	for (let current = resolved; ; current = path.dirname(current)) {
		const stat = system.lstat(current);
		const kindOk = current === resolved ? stat.isFile() : stat.isDirectory();
		if (!kindOk || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
		if (current === path.dirname(current)) return true;
	}
}

const STATUS_KEYS = ["version", "profile", "bootId", "namespace", "policyHash", "topologyHash", "updatedAtUptimeMs", "expiresAtUptimeMs"];

/** @returns {Status} */
function parseStatus(/** @type {Buffer} */ bytes) {
	const status = JSON.parse(String(bytes));
	const keys = Object.keys(status ?? {});
	const valid = typeof status === "object" && !Array.isArray(status)
		&& keys.length === STATUS_KEYS.length && STATUS_KEYS.every((key) => keys.includes(key))
		&& status.version === 1 && (status.profile === "app" || status.profile === "browser")
		&& typeof status.bootId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(status.bootId)
		&& typeof status.namespace === "string" && /^net:\[\d+\]$/.test(status.namespace)
		&& [status.policyHash, status.topologyHash].every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
		&& [status.updatedAtUptimeMs, status.expiresAtUptimeMs].every((time) => Number.isFinite(time));
	if (!valid) throw new Error("Invalid egress status");
	return status;
}

/** @typedef {{ links: unknown, routes: unknown, rules: unknown, resolvConf: string }} Topology */

/** @returns {Topology} */
export function readTopology() {
	const ip = (/** @type {string[]} */ args) => JSON.parse(execFileSync("ip", ["-j", ...args], { encoding: "utf8", timeout: 2000 }) || "[]");
	return {
		links: ip(["address", "show"]),
		routes: [...ip(["-4", "route", "show", "table", "all"]), ...ip(["-6", "route", "show", "table", "all"])],
		rules: [...ip(["-4", "rule", "show"]), ...ip(["-6", "rule", "show"])],
		resolvConf: fs.readFileSync("/etc/resolv.conf", "utf8"),
	};
}

/** Hash of what decides where packets go: addresses, routes, policy rules
 * and the resolver. Lifetimes, DAD state, link state and route expiry tick
 * or flap on their own, so they stay out.
 * @param {Topology} topology */
export function topologyFingerprint(topology) {
	const pick = (/** @type {Record<string, unknown>} */ value, /** @type {string[]} */ keys) =>
		Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
	const list = (/** @type {unknown} */ value) => /** @type {Array<Record<string, unknown>>} */ (Array.isArray(value) ? value : []);
	const sorted = (/** @type {unknown[]} */ values) => values.map((value) => JSON.stringify(value)).sort();
	const links = list(topology.links).map((link) => ({
		...pick(link, ["ifname", "link_type", "address", "mtu", "master", "link"]),
		addresses: sorted(list(link.addr_info).map((address) => pick(address, ["family", "local", "address", "prefixlen", "broadcast", "scope"]))),
	}));
	const routes = list(topology.routes).map(({ expires: _expires, flags: _flags, cache: _cache, ...route }) => route);
	return sha256(JSON.stringify({
		links: sorted(links),
		routes: sorted(routes),
		rules: sorted(list(topology.rules)),
		resolvConf: topology.resolvConf,
	}));
}
