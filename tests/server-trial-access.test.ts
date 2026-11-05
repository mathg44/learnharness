import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { evaluateTrialAccess } from "../src/server/trial-access.ts";
import { proxy } from "../proxy.ts";

const ORIGIN = "https://trial-host.tailnet-example.ts.net";
const HOST = "trial-host.tailnet-example.ts.net";
const OWNER = "owner@example.com";
const TRIAL_ENV = { LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: OWNER, LH_SERVER_TRIAL_ORIGIN: ORIGIN };

function headers(extra: Record<string, string> = {}) {
	return new Headers({ host: HOST, "tailscale-user-login": OWNER, ...extra });
}

test("trial disabled: every method and header combination is allowed, including none at all", () => {
	for (const env of [{}, { LH_SERVER_TRIAL: "0" }, { LH_SERVER_TRIAL_OWNER: OWNER, LH_SERVER_TRIAL_ORIGIN: ORIGIN }]) {
		assert.deepEqual(evaluateTrialAccess("GET", new Headers(), env), { allowed: true });
		assert.deepEqual(evaluateTrialAccess("POST", new Headers({ origin: "https://attacker.invalid" }), env), { allowed: true });
	}
});

test("trial enabled but misconfigured fails closed regardless of headers presented", () => {
	for (const env of [
		{ LH_SERVER_TRIAL: "1" },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: OWNER },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_ORIGIN: ORIGIN },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: OWNER, LH_SERVER_TRIAL_ORIGIN: "http://" + HOST },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: OWNER, LH_SERVER_TRIAL_ORIGIN: ORIGIN + "/trial" },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: OWNER, LH_SERVER_TRIAL_ORIGIN: "not-a-url" },
		{ LH_SERVER_TRIAL: "1", LH_SERVER_TRIAL_OWNER: "", LH_SERVER_TRIAL_ORIGIN: ORIGIN },
		{ ...TRIAL_ENV, LH_SERVER_TRIAL_ORIGIN: "https://user:password@" + HOST },
		{ ...TRIAL_ENV, LH_SERVER_TRIAL_OWNER: OWNER + ", other@example.com" },
	]) {
		const result = evaluateTrialAccess("GET", headers({ origin: ORIGIN }), env);
		assert.deepEqual(result, { allowed: false, reason: "trial_misconfigured" });
	}
});

test("misconfiguration and rejection reasons never echo the configured owner or origin", () => {
	const result = evaluateTrialAccess("GET", headers({ "tailscale-user-login": "someone-else@example.com" }), TRIAL_ENV);
	assert.deepEqual(result, { allowed: false, reason: "identity" });
	for (const value of Object.values(result)) assert(!String(value).includes(OWNER) && !String(value).includes(HOST));
});

test("wrong or missing Tailscale-User-Login is rejected even with every other header correct", () => {
	for (const login of [undefined, "", "OWNER@EXAMPLE.COM", "attacker@example.com", OWNER + ", " + OWNER]) {
		const h = headers({ origin: ORIGIN });
		if (login === undefined) h.delete("tailscale-user-login");
		else h.set("tailscale-user-login", login);
		assert.deepEqual(evaluateTrialAccess("GET", h, TRIAL_ENV), { allowed: false, reason: "identity" });
	}
});

test("wrong Host or forwarded host/proto is rejected even with the correct identity", () => {
	assert.deepEqual(evaluateTrialAccess("GET", headers({ host: "attacker.invalid" }), TRIAL_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateTrialAccess("GET", headers({ "x-forwarded-host": "attacker.invalid" }), TRIAL_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateTrialAccess("GET", headers({ "x-forwarded-proto": "http" }), TRIAL_ENV), { allowed: false, reason: "host" });
	assert.deepEqual(evaluateTrialAccess("GET", headers({ "x-forwarded-host": HOST, "x-forwarded-proto": "https" }), TRIAL_ENV), { allowed: true });
});

test("reads and SSE may omit Origin, but cross-origin and originless writes are rejected", () => {
	for (const method of ["GET", "HEAD", "OPTIONS"]) assert.deepEqual(evaluateTrialAccess(method, headers(), TRIAL_ENV), { allowed: true });
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		assert.deepEqual(evaluateTrialAccess(method, headers(), TRIAL_ENV), { allowed: false, reason: "origin" }, `${method} without Origin`);
		assert.deepEqual(evaluateTrialAccess(method, headers({ origin: "https://attacker.invalid" }), TRIAL_ENV), { allowed: false, reason: "origin" }, `${method} cross-origin`);
		assert.deepEqual(evaluateTrialAccess(method, headers({ origin: ORIGIN }), TRIAL_ENV), { allowed: true }, `${method} same-origin`);
	}
	assert.deepEqual(evaluateTrialAccess("GET", headers({ origin: "https://attacker.invalid" }), TRIAL_ENV), { allowed: false, reason: "origin" }, "a read that does carry Origin is still held to it");
});

test("proxy() enforces the trial on page routes too, and composes with desktop auth on /api", () => {
	const originalEnv = { ...process.env };
	const desktopSecret = "b".repeat(64);
	try {
		for (const key of Object.keys(TRIAL_ENV)) delete process.env[key];
		Object.assign(process.env, TRIAL_ENV);

		// Desktop mode is off (the trial's actual deployment): desktopAPIAuthorized
		// is a no-op, so the trial check alone must gate both pages and the API.
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;

		const denied = proxy(new NextRequest(ORIGIN + "/dashboard", { headers: { host: "attacker.invalid" } }));
		assert.equal(denied.status, 403);
		assert.equal(denied.headers.get("x-middleware-next"), null);

		const allowedPage = proxy(new NextRequest(ORIGIN + "/dashboard", { headers: { host: HOST, "tailscale-user-login": OWNER } }));
		assert.equal(allowedPage.headers.get("x-middleware-next"), "1");

		const deniedApi = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: "attacker.invalid", "tailscale-user-login": OWNER } }));
		assert.equal(deniedApi.status, 403);

		const allowedApi = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": OWNER } }));
		assert.equal(allowedApi.headers.get("x-middleware-next"), "1");

		// If desktop mode is also layered on top (unusual, but the two checks
		// must compose): the trial identity above is no longer sufficient on
		// its own for /api routes without the desktop capability too.
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = desktopSecret;
		const apiMissingDesktopSecret = proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": OWNER } }));
		assert.equal(apiMissingDesktopSecret.status, 403);
		const apiWithBothCapabilities = proxy(
			new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST, "tailscale-user-login": OWNER, "x-learnharness-desktop": desktopSecret } }),
		);
		assert.equal(apiWithBothCapabilities.headers.get("x-middleware-next"), "1");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	}
});
