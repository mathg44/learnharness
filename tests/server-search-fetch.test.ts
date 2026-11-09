/**
 * #23 server-mode search transport: the exact-endpoint check in front of
 * publicFetch, the limits it passes, Response rewrapping, redacted failures
 * and caller cancellation. Every transport here is an injected stub; no
 * network and no real credentials.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { PublicFetchOptions, PublicFetchResponse } from "../src/agent/public-fetch.ts";
import { installPublicHttp } from "./helpers/public-http.ts";
// The real server composition imports stores. Isolate it before loading it.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-search-"));
const savedEnv = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: profile, USERPROFILE: profile, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json") });
delete process.env.LH_SERVER_MODE;
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}", { mode: 0o600 });
const { braveProvider, exaProvider, firecrawlProvider, ollamaProvider, serverSearchFetch, tavilyProvider } = await import("../src/server/search.ts");
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(profile, { recursive: true, force: true });
});

const KEY = "fake-search-key-1234567890";

function stubTransport(reply: Partial<PublicFetchResponse> & { body?: string } = {}) {
	const calls: Array<{ url: string; options: PublicFetchOptions }> = [];
	const transport = async (url: string, options: PublicFetchOptions): Promise<PublicFetchResponse> => {
		calls.push({ url, options });
		return {
			url,
			status: reply.status ?? 200,
			statusText: reply.statusText ?? "OK",
			headers: reply.headers ?? new Headers({ "content-type": "application/json" }),
			bytes: reply.bytes ?? new TextEncoder().encode(reply.body ?? "{}"),
		};
	};
	return { calls, transport };
}

describe("serverSearchFetch", () => {
	it("passes the search limits and no redirects to publicFetch", async () => {
		const { calls, transport } = stubTransport({ body: JSON.stringify({ results: [{ title: "T", url: "https://e.com/", content: "c" }] }) });
		const hits = await tavilyProvider(KEY, serverSearchFetch(transport)).search("q", 3);
		assert.deepEqual(hits, [{ title: "T", url: "https://e.com/", snippet: "c" }]);
		assert.equal(calls.length, 1);
		const { url, options } = calls[0]!;
		assert.equal(url, "https://api.tavily.com/search");
		assert.equal(options.maxBytes, 1024 * 1024);
		assert.equal(options.maxRedirects, 0);
		assert.equal(options.timeoutMs, 30_000);
		assert.equal(options.method, "POST");
		assert.equal(options.headers?.authorization, `Bearer ${KEY}`);
		assert.equal(JSON.parse(options.body!).query, "q");
		assert.ok(options.signal instanceof AbortSignal);
	});

	it("accepts each adapter's exact endpoint", async () => {
		const cases = [
			{ make: braveProvider, url: /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/, body: { web: { results: [] } }, method: "GET" },
			{ make: exaProvider, url: /^https:\/\/api\.exa\.ai\/search$/, body: { results: [] }, method: "POST" },
			{ make: firecrawlProvider, url: /^https:\/\/api\.firecrawl\.dev\/v2\/search$/, body: { success: true, data: { web: [] } }, method: "POST" },
			{ make: ollamaProvider, url: /^https:\/\/ollama\.com\/api\/web_search$/, body: { results: [] }, method: "POST" },
		];
		for (const { make, url, body, method } of cases) {
			const { calls, transport } = stubTransport({ body: JSON.stringify(body) });
			assert.deepEqual(await make(KEY, serverSearchFetch(transport)).search("q", 2), []);
			assert.match(calls[0]!.url, url);
			assert.equal(calls[0]!.options.method, method);
		}
	});

	it("refuses any other destination before the transport sees credentials", async () => {
		const { calls, transport } = stubTransport();
		const send = serverSearchFetch(transport);
		const refused = [
			"https://evil.example/search",
			"http://api.tavily.com/search",
			"https://api.tavily.com/other",
			"https://api.tavily.com:8443/search",
			"https://user:pass@api.tavily.com/search",
			"https://api.tavily.com/search#x",
			"https://api.exa.ai.evil.example/search",
		];
		for (const url of refused) {
			await assert.rejects(send(url, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" }), /not allowed/);
		}
		await assert.rejects(send("https://api.exa.ai/search", { method: "PUT", body: "{}" }), /not allowed/);
		for (const [url, method] of [
			["https://api.tavily.com/search", "GET"],
			["https://api.tavily.com/search?unexpected=value", "POST"],
			["https://api.exa.ai/search?url=http://127.0.0.1", "POST"],
			["https://api.search.brave.com/res/v1/web/search?q=topic&count=5", "POST"],
			["https://api.search.brave.com/res/v1/web/search", "GET"],
			["https://api.search.brave.com/res/v1/web/search?q=topic&count=5&url=private", "GET"],
			["https://api.search.brave.com/res/v1/web/search?q=one&q=two&count=5", "GET"],
		] as const) await assert.rejects(send(url, { method, headers: { authorization: `Bearer ${KEY}` } }), /not allowed/);
		assert.equal(calls.length, 0);
	});

	it("returns null-body statuses without a body", async () => {
		for (const status of [204, 205, 304]) {
			const { transport } = stubTransport({ status, bytes: new Uint8Array() });
			const response = await serverSearchFetch(transport)("https://api.exa.ai/search", { method: "POST", body: "{}" });
			assert.equal(response.status, status);
			assert.equal(response.body, null);
		}
	});
});

describe("search adapters in server mode", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.LH_SERVER_MODE;
		process.env.LH_SERVER_MODE = "tailscale";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.LH_SERVER_MODE;
		else process.env.LH_SERVER_MODE = saved;
	});

	const secretBody = JSON.stringify({ detail: { error: `bad key ${KEY}` }, message: `bad key ${KEY}` });
	const adapters = [
		{ label: "Tavily", make: tavilyProvider },
		{ label: "Brave", make: braveProvider },
		{ label: "Exa", make: exaProvider },
		{ label: "Firecrawl", make: firecrawlProvider },
		{ label: "Ollama", make: ollamaProvider },
	];

	it("reports only the label and status for provider errors", async () => {
		for (const { label, make } of adapters) {
			const { transport } = stubTransport({ status: 401, statusText: "Unauthorized", body: secretBody });
			await assert.rejects(make(KEY, serverSearchFetch(transport)).search("q", 5), { message: `${label} search API 401` });
		}
	});

	it("hides transport error details", async () => {
		for (const { label, make } of adapters) {
			const failing = async () => { throw new Error(`blocked https://api.example/?key=${KEY}`); };
			await assert.rejects(make(KEY, serverSearchFetch(failing)).search("q", 5), { message: `${label} search request failed` });
		}
	});

	it("does not echo invalid JSON bodies", async () => {
		for (const { label, make } of adapters) {
			const { transport } = stubTransport({ body: `not json ${KEY}` });
			await assert.rejects(make(KEY, serverSearchFetch(transport)).search("q", 5), { message: `${label} search API returned an invalid response` });
		}
	});
});

describe("default transport in server mode (synthetic sockets)", () => {
	let saved: string | undefined;
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		saved = process.env.LH_SERVER_MODE;
		globalThis.fetch = async () => { throw new Error("global fetch must not be used in server mode"); };
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		if (saved === undefined) delete process.env.LH_SERVER_MODE;
		else process.env.LH_SERVER_MODE = saved;
	});
	const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

	it("picks publicFetch per call, even for a provider built before server mode", async (t) => {
		const provider = tavilyProvider(KEY);
		process.env.LH_SERVER_MODE = "tailscale";
		const wire = installPublicHttp(t, { responses: [json({ results: [{ title: "T", url: "https://e.com/", content: "c" }] })] });
		assert.deepEqual(await provider.search("q", 2), [{ title: "T", url: "https://e.com/", snippet: "c" }]);
		assert.deepEqual(wire.dnsNames, ["api.tavily.com"]);
		assert.equal(wire.connections.length, 1);
		assert.equal(wire.connections[0]!.servername, "api.tavily.com");
		assert.match(wire.requests[0]!, /^POST \/search HTTP\/1\.1\r\n/);
		assert.match(wire.requests[0]!, new RegExp(`\r\nauthorization: Bearer ${KEY}\r\n`, "i"));
		assert.match(wire.requests[0]!, /"query":"q"/);
	});

	it("sends Brave's query string and key header", async (t) => {
		process.env.LH_SERVER_MODE = "tailscale";
		const wire = installPublicHttp(t, { responses: [json({ web: { results: [] } })] });
		assert.deepEqual(await braveProvider(KEY).search("two words", 3), []);
		assert.match(wire.requests[0]!, /^GET \/res\/v1\/web\/search\?q=two\+words&count=3 HTTP\/1\.1\r\n/);
		assert.match(wire.requests[0]!, new RegExp(`\r\nx-subscription-token: ${KEY}\r\n`, "i"));
	});

	it("does not follow redirects, so the key never leaves the provider", async (t) => {
		process.env.LH_SERVER_MODE = "tailscale";
		const wire = installPublicHttp(t, { responses: [{ status: 302, headers: { location: "https://collector.example/steal" } }, json({ results: [] })] });
		await assert.rejects(exaProvider(KEY).search("q", 1), (error: Error) =>
			/^Exa search (API 302|request failed)$/.test(error.message) && !error.message.includes(KEY));
		assert.equal(wire.connections.length, 1);
		assert.deepEqual(wire.dnsNames, ["api.exa.ai"]);
	});

	it("refuses a provider host that resolves to a private address", async (t) => {
		process.env.LH_SERVER_MODE = "tailscale";
		const wire = installPublicHttp(t, { lookup: () => [{ address: "10.0.0.5", family: 4 }] });
		await assert.rejects(ollamaProvider(KEY).search("q", 1), { message: "Ollama search request failed" });
		assert.equal(wire.connections.length, 0);
	});

	it("stops at 1 MiB of response bytes", async (t) => {
		process.env.LH_SERVER_MODE = "tailscale";
		installPublicHttp(t, { responses: [{ headers: { "content-type": "application/json" }, body: Buffer.alloc(1024 * 1024 + 1, 0x20) }] });
		await assert.rejects(firecrawlProvider(KEY).search("q", 1), { message: "Firecrawl search request failed" });
	});

	it("redacts provider error bodies", async (t) => {
		process.env.LH_SERVER_MODE = "tailscale";
		installPublicHttp(t, { responses: [{ status: 401, body: `invalid key ${KEY}` }] });
		await assert.rejects(tavilyProvider(KEY).search("q", 1), { message: "Tavily search API 401" });
	});
});

describe("caller cancellation", () => {
	it("propagates the caller's signal next to the adapter timeout", async () => {
		const seen: AbortSignal[] = [];
		const fetchFn = async (_input: string, init: RequestInit) => {
			seen.push(init.signal!);
			return Response.json({ results: [] });
		};
		const controller = new AbortController();
		await exaProvider(KEY, fetchFn).search("q", 1, controller.signal);
		assert.equal(seen[0]!.aborted, false);
		controller.abort();
		assert.equal(seen[0]!.aborted, true);
	});

	it("an already-aborted signal reaches the transport aborted", async () => {
		const { calls, transport } = stubTransport({ body: JSON.stringify({ results: [] }) });
		await ollamaProvider(KEY, serverSearchFetch(transport)).search("q", 1, AbortSignal.abort());
		assert.equal(calls[0]!.options.signal?.aborted, true);
	});
});
