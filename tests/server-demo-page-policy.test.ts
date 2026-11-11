import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { OFFLINE_DEMO_PARENT_CSP } from "../src/core/demo-document-policy.ts";

const ORIGIN = "https://learnharness.demo-policy.test";

function request(path: string, identity = true): NextRequest {
	return new NextRequest(`${ORIGIN}${path}`, { headers: {
		host: new URL(ORIGIN).host,
		"x-forwarded-proto": "https",
		...(identity ? { "tailscale-user-login": "synthetic-owner@demo-policy.test" } : {}),
	} });
}

test("server pages carry the offline-demo navigation policy, without changing API or desktop behavior", () => {
	const saved = Object.fromEntries(["LH_SERVER_MODE", "LH_SERVER_ORIGIN"].map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, { LH_SERVER_MODE: "tailscale", LH_SERVER_ORIGIN: ORIGIN });
		for (const path of ["/chat/new", "/", "/practice/new"]) {
			const response = proxy(request(path));
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Content-Security-Policy"), OFFLINE_DEMO_PARENT_CSP);
			assert.equal(response.headers.get("X-DNS-Prefetch-Control"), "off");
		}
		assert.equal(proxy(request("/api/settings")).headers.get("Content-Security-Policy"), null);
		assert.equal(proxy(request("/chat/new", false)).status, 403);
		delete process.env.LH_SERVER_MODE;
		assert.equal(proxy(request("/chat/new")).headers.get("Content-Security-Policy"), null);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
