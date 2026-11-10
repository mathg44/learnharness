import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installServerEgressReadiness, isServerCapabilityAvailable } from "../src/core/server-capabilities.ts";

test("storage leaves readiness alone and the server entry point installs enforcement", async () => {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-egress-bootstrap-"));
	const keys = ["NODE_ENV", "LH_SERVER_MODE", "HOME", "LH_DATA_DIR", "LH_AUTH_FILE"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		NODE_ENV: "test", LH_SERVER_MODE: "tailscale", HOME: profile,
		LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"),
	});
	fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
	try {
		installServerEgressReadiness(() => true);
		await import("../src/server/stores.ts");
		assert.equal(isServerCapabilityAvailable("research"), true, "storage must not replace the host's readiness adapter");
		await import("../src/server/index.ts");
		assert.equal(isServerCapabilityAvailable("research"), false, "the server must replace the test adapter with real enforcement, absent in this profile");
		assert.equal(isServerCapabilityAvailable("pdf"), false);
	} finally {
		installServerEgressReadiness(undefined);
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else Object.assign(process.env, { [key]: previous[key] });
		}
		fs.rmSync(profile, { recursive: true, force: true });
	}
});
