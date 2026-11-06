import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { evaluateServerAccess } from "../src/server/server-access.ts";

/** Run the real healthcheck against a stub that applies the real access gate. */
async function runHealthcheck(env: Record<string, string>) {
	let accepted = false;
	const server = createServer((req, res) => {
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
		}
		accepted = evaluateServerAccess(req.method!, headers, env).allowed;
		assert.equal(req.url, "/api/settings");
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
		return { exitCode, accepted };
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("container healthcheck supplies the server Host, an identity and HTTPS forwarding in tailscale mode", async () => {
	const result = await runHealthcheck({ LH_SERVER_MODE: "tailscale", LH_SERVER_ORIGIN: "https://server.example.ts.net" });
	assert.deepEqual(result, { exitCode: 0, accepted: true });
});

test("container healthcheck reports unhealthy when server mode is misconfigured", async () => {
	const result = await runHealthcheck({ LH_SERVER_MODE: "unknown", LH_SERVER_ORIGIN: "https://server.example.ts.net" });
	assert.deepEqual(result, { exitCode: 1, accepted: false });
});

test("container healthcheck sends no server headers outside server mode", async () => {
	const result = await runHealthcheck({});
	assert.deepEqual(result, { exitCode: 0, accepted: true });
});
