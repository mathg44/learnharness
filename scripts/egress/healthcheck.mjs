#!/usr/bin/env node
/** Exit 0 only once the guard renews its lease after this check starts, so
 * a marker left by a dead guard cannot pass. Waits up to 5 s; a live guard
 * renews every second. The profile comes from the policy itself, so app and
 * browser containers share this. */
import fs from "node:fs";
import { parsePolicy } from "./policy.mjs";
import { DEFAULT_POLICY_PATH, awaitFreshEnforcement } from "./state.mjs";

const policyPath = process.argv[2] ?? DEFAULT_POLICY_PATH;
let ready = false;
try {
	const { profile } = parsePolicy(fs.readFileSync(policyPath));
	ready = await awaitFreshEnforcement({ policyPath, profile });
} catch {
	ready = false;
}
process.exitCode = ready ? 0 : 1;
