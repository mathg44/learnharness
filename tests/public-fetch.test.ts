import assert from "node:assert/strict";
import { it } from "node:test";
import net from "node:net";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { isPublicAddress, publicFetch } from "../src/agent/public-fetch.ts";
import { installPublicHttp } from "./helpers/public-http.ts";

const page = "http://public.example/source";
const limits = { maxBytes: 1024 };

it("classifies global IPv4/IPv6 conservatively and refuses special-use, mapped and transition ranges", () => {
	for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
		assert.equal(isPublicAddress(address), true, address);
	}
	for (const address of ["", "public.example", "127.1", "2130706433", "0.0.0.0", "0.1.2.3", "10.9.8.7", "100.64.0.0", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.2", "192.168.1.1", "192.175.48.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::8.8.8.8", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::", "2620:4f:8000::1", "3fff::1", "5f00::1", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "ff02::1", "fe80::1%eth0", "4000::1"]) {
		assert.equal(isPublicAddress(address), false, address);
	}
});

it("rejects malformed URLs, credentials, ports and normalized numeric private addresses before dialing", async (t) => {
	const fixture = installPublicHttp(t);
	for (const url of ["not a url", "/relative", "file:///etc/passwd", "ftp://public.example/", "http://user:secret@public.example/", "https://public.example:80/", "http://public.example:443/", "https://public.example:8443/", "http://localhost./", "http://x.localhost/", "http://metadata.google.internal/", "http://home.arpa/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://169.254.169.254/", "http://[::ffff:7f00:1]/", "http://[::ffff:0808:0808]/", "http://[fe80::1%25eth0]/"]) {
		await assert.rejects(publicFetch(url, limits), (error: unknown) => error instanceof Error, url);
	}
	assert.equal(fixture.connections.length, 0);
	assert.equal(fixture.dnsNames.length, 0);
});

it("validates all DNS answers and refuses empty, invalid, private and mixed answers", async (t) => {
	let answers: { address: string; family: number }[] = [];
	const fixture = installPublicHttp(t, { lookup: () => answers });
	for (const rows of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 6 }], [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }], [{ address: "2001:4860::1", family: 6 }, { address: "fd7a:115c:a1e0::1", family: 6 }]]) {
		answers = rows;
		await assert.rejects(publicFetch(page, limits), /Destination denied/);
	}
	assert.equal(fixture.connections.length, 0);
});

it("uses the validated address once, preserves HTTP Host, removes fragments and ignores ambient fetch/proxies", async (t) => {
	const fixture = installPublicHttp(t, { lookup: () => fixture.dnsNames.length === 1
		? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }] });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Ambient fetch must not run"); });
	const priorProxy = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = "http://127.0.0.1:8123";
	t.after(() => { if (priorProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = priorProxy; });
	const out = await publicFetch("http://Public.Example:80/source?q=1#private-fragment", limits);
	assert.equal(out.url, "http://public.example/source?q=1");
	assert.equal(out.status, 200);
	assert.equal(new TextDecoder().decode(out.bytes), "Synthetic public page");
	assert.deepEqual(fixture.dnsNames, ["public.example"]);
	assert.deepEqual(fixture.connections, [{ host: "93.184.216.34", family: 4, port: 80 }]);
	assert.match(fixture.requests[0]!, /^GET \/source\?q=1 HTTP\/1.1\r\n/);
	assert.match(fixture.requests[0]!, /host: public.example\r\n/i);
	assert.ok(!fixture.requests[0]!.includes("private-fragment"));
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

it("pins HTTPS while preserving hostname certificate checks, SNI and HTTP/1.1", async (t) => {
	const fixture = installPublicHttp(t);
	await publicFetch("https://public.example/", limits);
	const connection = fixture.connections[0]!;
	assert.equal(connection.host, "93.184.216.34");
	assert.equal(connection.port, 443);
	assert.equal(connection.servername, "public.example");
	assert.equal(connection.rejectUnauthorized, true);
	assert.deepEqual(connection.ALPNProtocols, ["http/1.1"]);
	assert.ok(connection.checkServerIdentity);
	const error = connection.checkServerIdentity("93.184.216.34", { subjectaltname: "DNS:wrong.example" } as never);
	assert.ok(error && error.message.includes("public.example"), "certificate must authenticate original hostname");
});

it("supports public literal IPv4 and global IPv6 without a DNS lookup", async (t) => {
	const fixture = installPublicHttp(t, { responses: [{}, {}] });
	await publicFetch("http://8.8.8.8/", limits);
	await publicFetch("https://[2606:4700:4700::1111]/", limits);
	assert.deepEqual(fixture.dnsNames, []);
	assert.equal(fixture.connections[1]!.host, "2606:4700:4700::1111");
	assert.equal(fixture.connections[1]!.family, 6);
	assert.equal(fixture.connections[1]!.servername, undefined);
	assert.match(fixture.requests[1]!, /host: \[2606:4700:4700::1111\]/i);
});

for (const reply of [{ peer: "127.0.0.1" }, { peer: "1.1.1.1" }, { peerPort: 8080 }]) {
	it(`refuses a mismatched socket peer before sending HTTP headers: ${JSON.stringify(reply)}`, async (t) => {
		const fixture = installPublicHttp(t, { responses: [reply] });
		await assert.rejects(publicFetch(page, { ...limits, headers: { authorization: "fixture-only-secret" } }), /connected peer/);
		assert.deepEqual(fixture.requests, []);
		assert.ok(fixture.sockets[0]!.destroyed);
	});
}

it("checks a real kernel socket peer before sending any HTTP data", async (t) => {
	let bytesReceived = 0;
	const server = net.createServer((socket) => { socket.on("data", (bytes) => { bytesReceived += bytes.length; }); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const port = (server.address() as net.AddressInfo).port;
	const realConnect = net.connect;
	t.mock.method(net, "connect", () => realConnect({ host: "127.0.0.1", port }));
	await assert.rejects(publicFetch("http://8.8.8.8/", { ...limits, headers: { authorization: "fixture-only-secret" } }), /connected peer/);
	assert.equal(bytesReceived, 0);
});

it("follows validated relative/public redirects, reports final URL and drops credentials and custom headers", async (t) => {
	const fixture = installPublicHttp(t, { responses: [
		{ status: 302, headers: { location: "/next" } },
		{ status: 307, headers: { location: "https://other.example/final" } },
		{ body: "Final public content" },
	] });
	const out = await publicFetch(page, { ...limits, headers: { authorization: "fixture-only-secret", cookie: "fixture-cookie", "x-api-key": "fixture-key", "x-private": "private", Accept: "text/plain", "User-Agent": "Fixture" } });
	assert.equal(out.url, "https://other.example/final");
	assert.deepEqual(fixture.dnsNames, ["public.example", "public.example", "other.example"]);
	assert.match(fixture.requests[0]!, /fixture-only-secret/);
	for (const request of fixture.requests.slice(1)) {
		assert.ok(!/fixture-only-secret|fixture-cookie|fixture-key|x-private/i.test(request));
		assert.match(request, /accept: text\/plain/i);
		assert.match(request, /user-agent: Fixture/i);
	}
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

for (const location of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[fd7a:115c:a1e0::1]/", "http://0x7f000001/", "http://private.example/", "file:///etc/passwd", "http://user:secret@other.example/", "https://public.example:8443/"]) {
	it(`refuses redirect destination ${location}`, async (t) => {
		const fixture = installPublicHttp(t, { lookup: (name) => [{ address: name === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }],
			responses: [{ status: 302, headers: { location } }] });
		await assert.rejects(publicFetch(page, limits));
		assert.equal(fixture.connections.length, 1);
		assert.ok(fixture.sockets[0]!.destroyed);
	});
}

it("revalidates DNS on a same-host redirect, denying rebinding", async (t) => {
	const fixture = installPublicHttp(t, { lookup: () => [{ address: fixture.dnsNames.length === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
		responses: [{ status: 302, headers: { location: "/next" } }] });
	await assert.rejects(publicFetch(page, limits), /Destination denied/);
	assert.equal(fixture.connections.length, 1);
	assert.equal(fixture.dnsNames.length, 2);
});

it("bounds redirect loops to five and refuses all redirects when configured", async (t) => {
	const fixture = installPublicHttp(t, { responses: Array.from({ length: 7 }, () => ({ status: 302, headers: { location: "/loop" } })) });
	await assert.rejects(publicFetch(page, limits), /Redirect limit/);
	assert.equal(fixture.connections.length, 6);
	await assert.rejects(publicFetch(page, { ...limits, maxRedirects: 0 }), /redirects forbidden/);
	assert.equal(fixture.connections.length, 7);
});

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
	it(`bounds decompressed ${encoding} bytes and accepts a small encoded page`, async (t) => {
		const fixture = installPublicHttp(t, { responses: [
			{ headers: { "content-encoding": encoding }, body: compress("small content") },
			{ headers: { "content-encoding": encoding }, body: compress("x".repeat(100_000)) },
		] });
		assert.equal(new TextDecoder().decode((await publicFetch(page, limits)).bytes), "small content");
		await assert.rejects(publicFetch(page, limits), /Response too large/);
		assert.ok(fixture.sockets.every((socket) => socket.destroyed));
	});
}

it("bounds declared, chunked and undeclared bytes; rejects unsupported encodings and invalid bodies", async (t) => {
	const fixture = installPublicHttp(t, { responses: [
		{ headers: { "content-length": "1000000" }, body: "" },
		{ raw: `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800\r\n${"x".repeat(2048)}\r\n0\r\n\r\n` },
		{ raw: `HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${"x".repeat(2048)}` },
		{ headers: { "content-encoding": "zstd" } },
		{ headers: { "content-encoding": "gzip" }, body: "not gzip" },
	] });
	for (let i = 0; i < 3; i++) await assert.rejects(publicFetch(page, limits), /Response too large/);
	await assert.rejects(publicFetch(page, limits), /Unsupported response content encoding/);
	await assert.rejects(publicFetch(page, limits), { message: "Public request failed" });
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

it("counts chunk framing and extensions before Node's HTTP parser removes them", async (t) => {
	const chunk = `1;${"x".repeat(15_000)}\r\nx\r\n`;
	const fixture = installPublicHttp(t, { responses: [{ raw: `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.repeat(100)}0\r\n\r\n` }] });
	await assert.rejects(publicFetch(page, limits), /Response too large/);
	assert.ok(fixture.sockets[0]!.destroyed);
});

it("enforces pre-parser accounting on native TCP streams as well as synthetic sockets", async (t) => {
	const framing = `1;${"x".repeat(15_000)}\r\nx\r\n`;
	const replies = [
		"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
		`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${framing.repeat(100)}0\r\n\r\n`,
	];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.once("data", () => socket.end(replies.shift()!));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const realConnect = net.connect;
	const port = (server.address() as net.AddressInfo).port;
	t.mock.method(net, "connect", () => {
		const socket = realConnect({ host: "127.0.0.1", port });
		// Only the fixture transport presents a synthetic public peer. Actual
		// bytes still traverse kernel sockets and Node's native HTTP parser.
		Object.defineProperties(socket, { remoteAddress: { value: "8.8.8.8" }, remotePort: { value: 80 } });
		return socket;
	});
	assert.equal(new TextDecoder().decode((await publicFetch("http://8.8.8.8/", limits)).bytes), "ok");
	await assert.rejects(publicFetch("http://8.8.8.8/", limits), /Response too large/);
});

it("counts informational responses and response headers against the transferred-byte budget", async (t) => {
	const informational = `HTTP/1.1 103 Early Hints\r\nLink: </${"x".repeat(100)}>; rel=preload\r\n\r\n`;
	const fixture = installPublicHttp(t, { responses: [{ raw: `${informational.repeat(100)}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok` }] });
	await assert.rejects(publicFetch(page, limits), /Response too large/);
	assert.ok(fixture.sockets[0]!.destroyed);
});

it("shares the transferred-byte budget across redirect hops", async (t) => {
	const fixture = installPublicHttp(t, { responses: [
		{ raw: "HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n" },
		{ raw: `HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n${"x".repeat(100)}` },
	] });
	await assert.rejects(publicFetch(page, { maxBytes: 150 }), /Response too large/);
	assert.equal(fixture.connections.length, 2);
});

it("cancellation and the deadline include DNS, connection and a stalled response body", async (t) => {
	const fixture = installPublicHttp(t, { responses: [{ stallConnect: true }, { stallBody: true, headers: { "content-length": "100" }, body: "partial" }] });
	await assert.rejects(publicFetch(page, { ...limits, timeoutMs: 15 }), /timed out/);
	const controller = new AbortController();
	const operation = publicFetch(page, { ...limits, signal: controller.signal });
	setImmediate(() => controller.abort());
	await assert.rejects(operation, /cancelled/);
	assert.ok(fixture.sockets.every((socket) => socket.destroyed));
});

it("does not dial after cancellation of an outstanding DNS lookup", async (t) => {
	let complete!: (answers: { address: string; family: number }[]) => void;
	const fixture = installPublicHttp(t, { lookup: () => new Promise((resolve) => { complete = resolve; }) });
	const controller = new AbortController();
	const pending = publicFetch(page, { ...limits, signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	complete([{ address: "93.184.216.34", family: 4 }]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fixture.connections.length, 0);
});

it("times out stalled DNS and rejects an already-cancelled request before DNS", async (t) => {
	const fixture = installPublicHttp(t, { lookup: () => new Promise(() => {}) });
	await assert.rejects(publicFetch(page, { ...limits, timeoutMs: 10 }), /timed out/);
	assert.equal(fixture.dnsNames.length, 1);
	await assert.rejects(publicFetch(page, { ...limits, signal: AbortSignal.abort() }), /cancelled/);
	assert.equal(fixture.dnsNames.length, 1);
});

it("does not return raw parser response bytes or accept invalid caller limits", async (t) => {
	installPublicHttp(t, { responses: [{ raw: "fixture-secret-not-an-http-response\r\n" }] });
	await assert.rejects(publicFetch(page, limits), { message: "Public request failed" });
	for (const options of [{ maxBytes: 0 }, { maxBytes: NaN }, { maxBytes: 10, timeoutMs: 0 }, { maxBytes: 10, maxRedirects: 6 }, { maxBytes: 10, body: "data" }]) {
		await assert.rejects(publicFetch(page, options), /Invalid public fetch/);
	}
});
