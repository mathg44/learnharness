#!/usr/bin/env node
/** Container-local egress guard (issue #27). Runs as root with NET_ADMIN in
 * the app's network namespace and manages only the inet lh_egress table.
 *
 * Start: validate config, install the default-drop table with no grants,
 * wait up to 5 s for IPv6 DAD to settle, record the table listing and the
 * topology, then renew 5 s grants and the status lease every second. Any
 * failure before the first lease exits 1.
 * Afterwards a changed table, topology, namespace or config, pending or
 * failed DAD, or a failed renewal latches the guard closed: the status is
 * removed, the known deny-first table is reinstalled with no grants, which
 * also drops any injected rule or policy, and the process stays alive and
 * unhealthy until an owner restart. SIGTERM does the same reset, then exits.
 * A crash leaves the table in place and the kernel expires the grants. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { checkDockerResolver, inspectTable, parsePolicy, renderGrants, renderTable } from "./policy.mjs";
import {
	DEFAULT_POLICY_PATH, DEFAULT_STATUS_PATH, REFRESH_MS, awaitSettledTopology, currentNamespace, readTopology,
	removeStatus, statusFor, topologyFingerprint, topologyState, uptimeMs, writeStatus,
} from "./state.mjs";

const policyPath = process.argv[2] ?? DEFAULT_POLICY_PATH;
const statusPath = DEFAULT_STATUS_PATH;

/** nft echoes failing script lines, which can hold the inference tuple or
 * deny CIDRs, so only the exit status reaches the log. */
function nft(/** @type {string} */ script) {
	try {
		execFileSync("nft", ["-f", "-"], { input: script, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
	} catch (error) {
		const status = /** @type {{ status?: unknown }} */ (error).status;
		throw new Error(`nft -f failed (status ${String(status ?? "unknown")})`);
	}
}
const listing = () => execFileSync("nft", ["-j", "list", "table", "inet", "lh_egress"], { encoding: "utf8", timeout: 2000 });
const log = (/** @type {string} */ message) => console.error(`lh-egress: ${message}`);

/** @type {ReturnType<typeof parsePolicy>} */
let policy;
/** @type {Buffer} */
let policyBytes;
/** @type {{ table: string, topology: string, namespace: string }} */
let baseline;
try {
	removeStatus(statusPath);
	try {
		policyBytes = fs.readFileSync(policyPath);
		policy = parsePolicy(policyBytes);
	} catch {
		// Parser messages can quote config bytes; keep private values out of logs.
		throw new Error(`config ${policyPath} is missing, unreadable or invalid`);
	}
	nft(renderTable(policy));
	const topology = await awaitSettledTopology();
	checkDockerResolver(topology.resolvConf);
	baseline = { table: inspectTable(listing()), topology: topologyFingerprint(topology), namespace: currentNamespace() };
	renew();
} catch (error) {
	log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
	removeStatus(statusPath);
	process.exit(1);
}

let latched = false;
const timer = setInterval(() => {
	try {
		renew();
	} catch (error) {
		latch(error);
	}
}, REFRESH_MS);

/** Verify everything still matches the baseline, then extend grants and the
 * status. The status lease starts before the grants, so it ends first. */
function renew() {
	const now = uptimeMs();
	if (!fs.readFileSync(policyPath).equals(policyBytes)) throw new Error("config changed");
	if (inspectTable(listing()) !== baseline.table) throw new Error("lh_egress table changed");
	if (currentNamespace() !== baseline.namespace) throw new Error("network namespace changed");
	const topology = readTopology();
	if (topologyState(topology) !== "settled") throw new Error("IPv6 DAD pending or failed");
	if (topologyFingerprint(topology) !== baseline.topology) throw new Error("network topology or resolver changed");
	nft(renderGrants(policy));
	writeStatus(statusPath, statusFor({ profile: policy.profile, policyBytes, namespace: baseline.namespace, topologyHash: baseline.topology, nowMs: now }));
}

/** Remove the status, then atomically reinstall the known table with every
 * grant empty. Flushing sets alone would keep an injected accept rule or
 * policy. Static health and reply traffic stay. Only lh_egress is touched. */
function close() {
	clearInterval(timer);
	try { removeStatus(statusPath); } catch (error) { log(`status removal failed: ${String(error)}`); }
	try {
		nft(renderTable(policy));
	} catch (error) {
		log(`deny-first reset failed: ${String(error)}. Untampered grants expire within 5 s.`);
	}
}

function latch(/** @type {unknown} */ error) {
	if (latched) return;
	latched = true;
	close();
	log(`latched closed: ${error instanceof Error ? error.message : String(error)}. Restart the guard after review.`);
	// Stay alive so a restart policy cannot re-baseline a changed system.
	setInterval(() => {}, 1 << 30);
}

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
	process.on(signal, () => {
		close();
		process.exit(0);
	});
}
