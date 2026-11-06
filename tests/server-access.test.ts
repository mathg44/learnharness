import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { evaluateServerAccess } from "../src/server/server-access.ts";
import { proxy } from "../proxy.ts";

const ORIGIN = "https://server-host.tailnet-example.ts.net";
const HOST = "server-host.tailnet-example.ts.net";
const LOGIN = "learner@example.com";
const SERVER_ENV = { LH_SERVER_MODE: "tailscale", LH_SERVER_ORIGIN: ORIGIN };

function headers(extra: Record<string, string> = {}) {
	return new Headers({ host: HOST, "tailscale-user-login": LOGIN, ...extra });
}

test("server mode unset: every method and header combination is allowed, including none at all", () => {
	for (const env of [{}, { LH_SERVER_ORIGIN: ORIGIN }]) {
		assert.deepEqual(evaluateServerAccess("GET", new Headers(), env), { allowed: true });
		assert.deepEqual(evaluateServerAccess("POST", new Headers({ origin: "https://attacker.invalid" }), env), { allowed: true });
	}
});

test("server mode set but misconfigured fails closed regardless of headers presented", () => {
	for (const env of [
		{ LH_SERVER_MODE: "tailscale" },
		{ LH_SERVER_MODE: "", LH_SERVER_ORIGIN: ORIGIN },
		{ LH_SERVER_MODE: "1", LH_SERVER_ORIGIN: ORIGIN },
		{ LH_SERVER_MODE: "off", LH_SERVER_ORIGIN: ORIGIN },
		{ LH_SERVER_MODE: "Tailscale", LH_SERVER_ORIGIN: ORIGIN },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: "" },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: "http://" + HOST },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: ORIGIN + "/app" },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: ORIGIN + "/?x=1" },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: "not-a-url" },
		{ ...SERVER_ENV, LH_SERVER_ORIGIN: "https://user:password@" + HOST },
	]) {
		const result = evaluateServerAccess("GET", headers({ origin: ORIGIN }), env);
		assert.deepEqual(result, { allowed: false, reason: "server_misconfigured" }, JSON.stringify(env));
	}
});

test("rejection reasons never echo the configured origin", () => {
	const result = evaluateServerAccess("GET", headers({ host: "attacker.invalid" }), SERVER_ENV);
	assert.deepEqual(result, { allowed: false, reason: "host" });
	for (const value of Object.values(result)) assert(!String(value).includes(HOST));
});

test("any authenticated tailnet login is accepted; a missing or empty login is rejected", () => {
	for (const login of [LOGIN, "someone-else@example.com", "partner@example.org"]) {
		assert.deepEqual(evaluateServerAccess("GET", headers({ "tailscale-user-login": login }), SERVER_ENV), { allowed: true }, login);
	}
	for (const login of [undefined, ""]) {
		const h = headers({ origin: ORIGIN });
		if (login === undefined) h.delete("tailscale-user-login");
		else h.set("tailscale-user-login", login);
		assert.deepEqual(evaluateServerAccess("GET", h, SERVER_ENV), { allowed: false, reason: "identity" });
	}
});

test("wrong Host or forwarded host/proto is rejected even with an identity", () => {
	assert.deepEqual(evaluateServerAccess("GET", headers({ host: "attacker.invalid" }), SERVER_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateServerAccess("GET", headers({ host: "127.0.0.1:3000" }), SERVER_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateServerAccess("GET", headers({ "x-forwarded-host": "attacker.invalid" }), SERVER_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateServerAccess("GET", headers({ "x-forwarded-proto": "http" }), SERVER_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateServerAccess("GET", headers({ "x-forwarded-host": HOST, "x-forwarded-proto": "https" }), SERVER_ENV), { allowed: true });
});

test("reads and SSE may omit Origin, but cross-origin and originless writes are rejected", () => {
	for (const method of ["GET", "HEAD", "OPTIONS"]) assert.deepEqual(evaluateServerAccess(method, headers(), SERVER_ENV), { allowed: true });
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		assert.deepEqual(evaluateServerAccess(method, headers(), SERVER_ENV), { allowed: false, reason: "origin" }, `${method} without Origin`);
		assert.deepEqual(evaluateServerAccess(method, headers({ origin: "https://attacker.invalid" }), SERVER_ENV), { allowed: false, reason: "origin" }, `${method} cross-origin`);
		assert.deepEqual(evaluateServerAccess(method, headers({ origin: ORIGIN }), SERVER_ENV), { allowed: true }, `${method} same-origin`);
	}
	assert.deepEqual(evaluateServerAccess("GET", headers({ origin: "https://attacker.invalid" }), SERVER_ENV), { allowed: false, reason: "origin" }, "a read that does carry Origin is still held to it");
});

test("proxy() enforces server mode on page routes too, and composes with desktop auth on /api", () => {
	const originalEnv = { ...process.env };
	const desktopSecret = "b".repeat(64);
	try {
		Object.assign(process.env, SERVER_ENV);

		// Desktop mode is off (the server's actual deployment): desktopAPIAuthorized
		// is a no-op, so the server check alone must gate both pages and the API.
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;

		const denied = proxy(new NextRequest(ORIGIN + "/dashboard", { headers: { host: "attacker.invalid" } }));
		assert.equal(denied.status, 403);
		assert.equal(denied.headers.get("x-middleware-next"), null);

		const allowedPage = proxy(new NextRequest(ORIGIN + "/dashboard", { headers: { host: HOST, "tailscale-user-login": LOGIN } }));
		assert.equal(allowedPage.headers.get("x-middleware-next"), "1");

		const deniedApi = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: "attacker.invalid", "tailscale-user-login": LOGIN } }));
		assert.equal(deniedApi.status, 403);

		const allowedApi = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": LOGIN } }));
		assert.equal(allowedApi.headers.get("x-middleware-next"), "1");

		// If desktop mode is also layered on top (unusual, but the two checks
		// must compose): the tailnet identity above is no longer sufficient on
		// its own for /api routes without the desktop capability too.
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = desktopSecret;
		const apiMissingDesktopSecret = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": LOGIN } }));
		assert.equal(apiMissingDesktopSecret.status, 403);
		const apiWithBothCapabilities = proxy(
			new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": LOGIN, "x-learnharness-desktop": desktopSecret } }),
		);
		assert.equal(apiWithBothCapabilities.headers.get("x-middleware-next"), "1");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	}
});
