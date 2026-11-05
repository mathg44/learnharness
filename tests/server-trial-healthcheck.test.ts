import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { evaluateTrialAccess } from "../src/server/trial-access.ts";

test("container healthcheck preserves the trial Host, identity and HTTPS forwarding headers", async () => {
	const env = {
		LH_SERVER_TRIAL: "1",
		LH_SERVER_TRIAL_OWNER: "owner@example.com",
		LH_SERVER_TRIAL_ORIGIN: "https://trial.example.ts.net",
	};
	let accepted = false;
	const server = createServer((req, res) => {
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
		}
		accepted = evaluateTrialAccess(req.method!, headers, env).allowed;
		assert.equal(req.url, "/api/settings");
		assert.equal(headers.get("x-forwarded-proto"), "https");
		res.writeHead(accepted ? 200 : 403, { "content-type": "application/json" });
		res.end(JSON.stringify(accepted ? { settings: null } : { error: "denied" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as { port: number }).port;
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(process.execPath, ["scripts/container/healthcheck.mjs"], {
				env: { ...env, NODE_ENV: "test", PORT: String(port) }, stdio: "pipe",
			});
			child.on("error", reject);
			child.on("exit", resolve);
		});
		assert.equal(exitCode, 0);
		assert.equal(accepted, true);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
