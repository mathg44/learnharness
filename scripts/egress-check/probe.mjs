/** Socket-level probes for the disposable egress check (issue #27). Runs
 * inside a guard's network namespace (as the app or browser would) or in the
 * unguarded control namespace, which proves each fixture really answers.
 *
 * Usage: node probe.mjs matrix <app|browser|control|closed>
 *        node probe.mjs public-fetch
 *        node probe.mjs hold <app|browser>      (needs /hold mounted RW)
 * Reads /topology.json. Prints one JSON line per case, exits 1 on any miss. */
import dgram from "node:dgram";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

const topology = JSON.parse(fs.readFileSync(process.env.LH_TOPOLOGY ?? "/topology.json", "utf8"));
const { public: pub, private: priv, tailnet, linkLocal, inferencePort } = topology;
const TIMEOUT_MS = 2500;
const LEASE_MS = 5000;

// Synthetic test CA only. Every fixture certificate names its IP literals
// and *.fixture.test, so HTTPS here is fully verified, never insecure.
const ca = fs.existsSync("/tls/ca.pem") ? fs.readFileSync("/tls/ca.pem") : undefined;

/** HTTP request on 80/other ports, verified HTTPS on 443. Reached only if the
 * fixture's marker comes back, so a refused or silent port never counts. */
function tcp(/** @type {string} */ host, /** @type {number} */ port, path = "/") {
	return new Promise((resolve) => {
		const options = { host, port, timeout: TIMEOUT_MS };
		const named = !net.isIP(host.split("%")[0] ?? host);
		const socket = port === 443
			? tls.connect({ ...options, ca, rejectUnauthorized: true, ...(named ? { servername: host } : {}) })
			: net.connect(options);
		let data = "";
		const done = (/** @type {boolean} */ reached, /** @type {string} */ detail) => { socket.destroy(); clearTimeout(timer); resolve({ reached, detail }); };
		const timer = setTimeout(() => done(false, "timeout"), TIMEOUT_MS);
		socket.once(port === 443 ? "secureConnect" : "connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: probe.fixture.test\r\nConnection: close\r\n\r\n`));
		socket.on("data", (chunk) => { data += chunk; if (data.includes("fixture:")) done(true, data.match(/fixture:[\w:-]+/)?.[0] ?? "fixture"); });
		socket.once("error", (/** @type {NodeJS.ErrnoException} */ error) => done(false, error.code ?? "error"));
		socket.once("close", () => done(data.includes("fixture:"), data ? "closed" : "closed-empty"));
	});
}

function udp(/** @type {string} */ host, /** @type {number} */ port) {
	return new Promise((resolve) => {
		const socket = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
		const done = (/** @type {boolean} */ reached, /** @type {string} */ detail) => { clearTimeout(timer); socket.close(); resolve({ reached, detail }); };
		const timer = setTimeout(() => done(false, "timeout"), TIMEOUT_MS);
		socket.on("message", (message) => done(String(message).startsWith("fixture:"), String(message).slice(0, 40)));
		socket.on("error", (/** @type {NodeJS.ErrnoException} */ error) => done(false, error.code ?? "error"));
		socket.send("probe", port, host);
	});
}

async function dnsUdp(/** @type {string} */ name) {
	const resolver = new dns.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
	resolver.setServers(["127.0.0.11"]);
	try {
		const answers = await resolver.resolve4(name);
		return { reached: answers.length > 0, detail: answers.join(",") };
	} catch (error) { return { reached: false, detail: /** @type {NodeJS.ErrnoException} */ (error).code ?? "error" }; }
}

/** One A query over TCP port 53, framed per RFC 1035 section 4.2.2. */
function dnsTcp(/** @type {string} */ name) {
	const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
	const query = Buffer.concat([Buffer.from([0x13, 0x37, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])]);
	const framed = Buffer.concat([Buffer.from([query.length >> 8, query.length & 0xff]), query]);
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.11", port: 53 });
		let data = Buffer.alloc(0);
		const done = (/** @type {boolean} */ reached, /** @type {string} */ detail) => { clearTimeout(timer); socket.destroy(); resolve({ reached, detail }); };
		const timer = setTimeout(() => done(false, "timeout"), TIMEOUT_MS);
		socket.once("connect", () => socket.write(framed));
		socket.on("data", (chunk) => {
			data = Buffer.concat([data, chunk]);
			if (data.length >= 2 && data.length >= 2 + data.readUInt16BE(0)) {
				const answers = data.readUInt16BE(2 + 6);
				done(answers > 0, `answers=${answers}`);
			}
		});
		socket.once("error", (/** @type {NodeJS.ErrnoException} */ error) => done(false, error.code ?? "error"));
	});
}

/** IPv6 link-local of the unrelated private fixture, scoped to whichever
 * local interface sits on the private fixture network. */
function scopedLinkLocal() {
	const address = priv.hosts.linkLocal6;
	if (!address) return undefined;
	const prefix = priv.v6.replace(/::\/64$/, ":");
	for (const [name, entries] of Object.entries(os.networkInterfaces())) {
		if (entries?.some((entry) => entry.family === "IPv6" && entry.address.startsWith(prefix))) return `${address}%${name}`;
	}
	return undefined;
}

/** Expected result per namespace. "closed" is a guard whose lease expired or
 * which failed closed: nothing outside the namespace may answer. */
function cases(/** @type {"app" | "browser" | "control" | "closed"} */ role) {
	const guarded = role !== "control";
	const publicPort = role === "app" || role === "browser" || role === "control";
	/** @type {{ name: string, run: () => Promise<{ reached: boolean, detail: string }>, allow: boolean }[]} */
	const list = [];
	const add = (/** @type {string} */ name, /** @type {() => Promise<any>} */ run, /** @type {boolean} */ allow) => list.push({ name, run, allow });
	for (const [family, address] of [["v4", pub.hosts.fixture4], ["v6", pub.hosts.fixture6]]) {
		for (const port of [80, 443]) add(`public ${family} tcp/${port}`, () => tcp(address, port), publicPort);
		for (const port of [8080, 3128, inferencePort]) add(`public ${family} tcp/${port} (non-web port)`, () => tcp(address, port), !guarded);
		for (const port of [443, 53]) add(`public ${family} udp/${port}`, () => udp(address, port), !guarded);
	}
	// Hostname through Docker DNS, then HTTPS with SNI and certificate checks.
	add("public DNS name http/80", () => tcp("public.fixture.test", 80), publicPort);
	add("public DNS name https/443 verified", () => tcp("public.fixture.test", 443), publicPort);
	add("provider exact v4 address and port", () => tcp(priv.hosts.provider4, inferencePort), role === "app" || role === "control");
	for (const port of [80, 443, 8080]) add(`provider v4 other port tcp/${port}`, () => tcp(priv.hosts.provider4, port), !guarded);
	add("provider v6 same port, not configured", () => tcp(priv.hosts.provider6, inferencePort), !guarded);
	for (const [family, address] of [["v4", priv.hosts.unrelated4], ["v6", priv.hosts.unrelated6]]) {
		for (const port of [80, 443, inferencePort]) add(`unrelated private ${family} tcp/${port}`, () => tcp(address, port), !guarded);
	}
	for (const [family, address] of [["v4", priv.hosts.gateway4], ["v6", priv.hosts.gateway6]]) {
		for (const port of [80, 443]) add(`gateway-shaped ${family} tcp/${port}`, () => tcp(address, port), !guarded);
	}
	for (const port of [80, 443]) add(`tailnet-shaped tcp/${port}`, () => tcp(tailnet.hosts.fixture4, port), !guarded);
	add("metadata 169.254.169.254 tcp/80", () => tcp(linkLocal.hosts.metadata, 80), !guarded);
	add("link-local v4 tcp/80", () => tcp(linkLocal.hosts.fixture4, 80), !guarded);
	const scoped = scopedLinkLocal();
	if (scoped) add("link-local v6 tcp/80", () => tcp(scoped, 80), !guarded);
	if (role !== "closed") {
		add("Docker DNS udp/53", () => dnsUdp("public.fixture.test"), true);
		add("Docker DNS tcp/53", () => dnsTcp("public.fixture.test"), true);
	}
	if (guarded) {
		// A loopback fixture listens inside this namespace on 9080.
		add("loopback v4 tcp/9080", () => tcp("127.0.0.1", 9080), false);
		add("loopback v6 tcp/9080", () => tcp("::1", 9080), false);
		if (role === "app") add("app health loopback tcp/3000", () => appHealth(), true);
	}
	return list;
}

/** The app answers 403 without identity; any HTTP status proves the path. */
function appHealth() {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port: 3000, timeout: TIMEOUT_MS });
		let data = "";
		const done = (/** @type {boolean} */ reached, /** @type {string} */ detail) => { socket.destroy(); resolve({ reached, detail }); };
		socket.once("connect", () => socket.write("GET /api/settings HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n"));
		socket.on("data", (chunk) => { data += chunk; if (/^HTTP\/1\.1 \d{3}/.test(data)) done(true, data.slice(0, 12)); });
		socket.once("timeout", () => done(false, "timeout"));
		socket.once("error", (/** @type {NodeJS.ErrnoException} */ error) => done(false, error.code ?? "error"));
	});
}

function listening(/** @type {number} */ port) {
	const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
	return ["/proc/net/tcp", "/proc/net/tcp6"].some((file) => fs.readFileSync(file, "utf8").split("\n")
		.some((line) => line.trim().split(/\s+/)[1]?.endsWith(`:${hexPort}`) && line.trim().split(/\s+/)[3] === "0A"));
}

async function matrix(/** @type {any} */ role) {
	if (role !== "control" && !listening(9080)) throw new Error("Loopback fixture is not listening in this namespace");
	const results = await Promise.all(cases(role).map(async (entry) => ({ name: entry.name, expected: entry.allow ? "allow" : "deny", ...(await entry.run()) })));
	let failed = 0;
	for (const result of results) {
		const pass = result.reached === (result.expected === "allow");
		if (!pass) failed++;
		console.log(JSON.stringify({ role, case: result.name, expected: result.expected, observed: result.reached ? "allow" : "deny", detail: result.detail, pass }));
	}
	return failed;
}

/** The real application transport, src/agent/public-fetch.ts, mounted
 * read-only and run with Node's type stripping. */
async function publicFetchCases() {
	const { publicFetch } = await import(process.env.LH_PUBLIC_FETCH ?? "/src/public-fetch.ts");
	const limits = { maxBytes: 64 * 1024, timeoutMs: 8000 };
	const text = (/** @type {{ bytes: Uint8Array }} */ response) => Buffer.from(response.bytes).toString("utf8");
	const ok = (/** @type {string} */ url, /** @type {(response: any) => boolean} */ check) => async () => {
		const response = await publicFetch(url, limits);
		return { pass: response.status === 200 && check(response), detail: `${response.status} ${text(response).slice(0, 40)}` };
	};
	const denied = (/** @type {string} */ url) => async () => {
		try { await publicFetch(url, limits); return { pass: false, detail: "fetched" }; }
		catch (error) { const message = /** @type {Error} */ (error).message; return { pass: /^Destination denied|^Only public/.test(message), detail: message }; }
	};
	const v4 = pub.hosts.fixture4, v6 = `[${pub.hosts.fixture6}]`;
	const marker = (/** @type {any} */ response) => text(response).includes("fixture:public");
	const redirect = (/** @type {string} */ to) => `http://${v4}/redirect?to=${encodeURIComponent(to)}`;
	/** @type {[string, () => Promise<{ pass: boolean, detail: string }>][]} */
	const list = [
		["https by Docker DNS alias", ok("https://public.fixture.test/", marker)],
		["http public IPv4 literal", ok(`http://${v4}/`, marker)],
		["https public IPv6 literal", ok(`https://${v6}/`, marker)],
		["public PDF bytes", ok(`https://public.fixture.test/pdf`, (response) => text(response).startsWith("%PDF-") && response.headers.get("content-type") === "application/pdf")],
		["redirect public to public", ok(redirect(`https://${v6}/`), marker)],
		["redirect to private literal", denied(redirect(`http://${priv.hosts.unrelated4}/`))],
		["redirect to private IPv6 literal", denied(redirect(`http://[${priv.hosts.unrelated6}]/`))],
		["redirect to provider", denied(redirect(`http://${priv.hosts.provider4}/`))],
		["redirect to alias resolving private", denied(redirect("http://private.fixture.test/"))],
		["redirect to alias resolving public and private", denied(redirect("http://mixed.fixture.test/"))],
		["redirect to metadata", denied(redirect(`http://${linkLocal.hosts.metadata}/`))],
		["direct tailnet-shaped literal", denied(`http://${tailnet.hosts.fixture4}/`)],
		["direct provider port", denied(`http://${priv.hosts.provider4}:${inferencePort}/`)],
	];
	let failed = 0;
	for (const [name, run] of list) {
		let result;
		try { result = await run(); } catch (error) { result = { pass: false, detail: /** @type {Error} */ (error).message }; }
		if (!result.pass) failed++;
		console.log(JSON.stringify({ role: "public-fetch", case: name, ...result }));
	}
	return failed;
}

const uptime = () => Math.round(os.uptime() * 1000);
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep-alive HTTP socket. tick() sends one request on the same TCP flow and
 * resolves true only if its response arrives within a second. */
function keepAlive(/** @type {string} */ host) {
	const socket = net.connect({ host, port: 80 });
	/** @type {((value: boolean) => void) | undefined} */
	let waiting;
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		while (buffer.includes("tick")) { buffer = buffer.slice(buffer.indexOf("tick") + 4); waiting?.(true); waiting = undefined; }
	});
	socket.on("error", () => { waiting?.(false); waiting = undefined; });
	const opened = new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	return {
		opened,
		tick: () => new Promise((resolve) => {
			if (socket.destroyed) return resolve(false);
			waiting = resolve;
			socket.write("GET /tick HTTP/1.1\r\nHost: probe.fixture.test\r\n\r\n");
			setTimeout(() => { if (waiting === resolve) { waiting = undefined; resolve(false); } }, 1000);
		}),
	};
}

/** Established flows and new connections, before and after the runner
 * disturbs the guard. The runner writes /hold/action with the boot-clock
 * time of the disturbance; every attempt starting more than lease + 1s later
 * must fail. Host and containers share CLOCK_BOOTTIME. */
async function hold(/** @type {"app" | "browser"} */ role) {
	const established = { "established v4": keepAlive(pub.hosts.fixture4), "established v6": keepAlive(`${pub.hosts.fixture6}`) };
	await Promise.all(Object.values(established).map((flow) => flow.opened));
	/** @type {Record<string, () => Promise<boolean>>} */
	const channels = {
		...Object.fromEntries(Object.entries(established).map(([name, flow]) => [name, flow.tick])),
		"new v4 tcp/80": async () => (await tcp(pub.hosts.fixture4, 80)).reached,
		"new v6 tcp/443": async () => (await tcp(pub.hosts.fixture6, 443)).reached,
		...(role === "app" ? { "new provider": async () => (await tcp(priv.hosts.provider4, inferencePort)).reached } : {}),
	};
	/** @type {{ channel: string, at: number, ok: boolean }[]} */
	const attempts = [];
	const round = async () => {
		await Promise.all(Object.entries(channels).map(async ([channel, attempt]) => { const at = uptime(); attempts.push({ channel, at, ok: await attempt() }); }));
	};
	await round();
	fs.writeFileSync("/hold/ready", `${uptime()}\n`);
	let action;
	for (let waited = 0; !(action = readAction()); waited += 250) {
		if (waited > 120_000) throw new Error("Runner never disturbed the guard");
		await round();
		await sleep(250);
	}
	const deadline = action + LEASE_MS + 1000;
	// Denied attempts take up to 2.5 s each round; leave room for several.
	while (uptime() < deadline + 10_000) { await round(); await sleep(250); }
	let failed = 0;
	for (const channel of Object.keys(channels)) {
		const mine = attempts.filter((attempt) => attempt.channel === channel);
		const before = mine.filter((attempt) => attempt.at < action);
		const after = mine.filter((attempt) => attempt.at > deadline);
		const pass = before.some((attempt) => attempt.ok) && after.length >= 3 && after.every((attempt) => !attempt.ok);
		if (!pass) failed++;
		const lastOk = mine.filter((attempt) => attempt.ok).at(-1)?.at;
		console.log(JSON.stringify({ role: `hold-${role}`, case: channel, beforeOk: before.filter((a) => a.ok).length, afterAttempts: after.length,
			afterOk: after.filter((a) => a.ok).length, lastOkAfterActionMs: lastOk === undefined ? null : lastOk - action, pass }));
	}
	return failed;
}

function readAction() {
	try { return Math.round(Number(fs.readFileSync("/hold/action", "utf8").trim()) * 1000) || undefined; }
	catch { return undefined; }
}

const [mode, role] = process.argv.slice(2);
const failed = mode === "matrix" ? await matrix(role)
	: mode === "public-fetch" ? await publicFetchCases()
	: mode === "hold" ? await hold(/** @type {any} */ (role))
	: (() => { throw new Error(`Unknown probe mode ${mode}`); })();
process.exit(failed ? 1 : 0);
