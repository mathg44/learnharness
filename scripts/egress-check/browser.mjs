/** Real Chromium requests for the disposable egress check (issue #27).
 * Chromium is driven over --remote-debugging-pipe, so no debugging port
 * exists. --no-sandbox is used only because this throwaway container drops
 * every capability. It proves the network rules, not browser isolation:
 * the production browser runtime (#25) stays disabled.
 *
 * Usage: node browser.mjs <browser|control>
 * Reads /topology.json. Prints one JSON line per case, exits 1 on any miss. */
import { spawn } from "node:child_process";
import fs from "node:fs";

const topology = JSON.parse(fs.readFileSync(process.env.LH_TOPOLOGY ?? "/topology.json", "utf8"));
const { public: pub, private: priv, tailnet, linkLocal, inferencePort } = topology;
const role = process.argv[2];
if (role !== "browser" && role !== "control") throw new Error("Usage: browser.mjs <browser|control>");
const guarded = role === "browser";
const NAVIGATION_MS = 8000;

/** One Chromium process. Commands are NUL-delimited JSON on fds 3 and 4. */
function launch(/** @type {string[]} */ extra) {
	const child = spawn(process.env.CHROMIUM ?? "/usr/bin/chromium", [
		"--headless=new", "--remote-debugging-pipe", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		"--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
		"--disable-sync", "--disable-breakpad", "--disable-domain-reliability", "--metrics-recording-only",
		// Fixture TLS uses a throwaway CA; the network rules are what is under test.
		"--ignore-certificate-errors",
		// Chromium's own private-network blocking would hide whether the guard
		// is what denies a request; the unguarded control proves it is.
		// HTTPS-Upgrades would silently move http:// pages to the fixture's 443,
		// making later http:// page fetches mixed content.
		"--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests,DnsOverHttps,HttpsUpgrades",
		`--user-data-dir=/tmp/chromium-${process.pid}-${Math.random().toString(36).slice(2)}`,
		...extra, "about:blank",
	], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
	const input = /** @type {import("node:stream").Writable} */ (child.stdio[3]);
	const output = /** @type {import("node:stream").Readable} */ (child.stdio[4]);
	let id = 0;
	/** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
	const pending = new Map();
	let buffer = "";
	output.on("data", (chunk) => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf("\0")) >= 0) {
			const message = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
			if (!waiter) continue;
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve(message.result);
		}
	});
	child.once("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`Chromium exited: ${stderr.slice(-300)}`)); pending.clear(); });
	const send = (/** @type {string} */ method, /** @type {object} */ params = {}, /** @type {string | undefined} */ sessionId = undefined) => new Promise((resolve, reject) => {
		const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
		pending.set(message.id, { resolve, reject });
		input.write(`${JSON.stringify(message)}\0`);
	});
	return { send, close: () => { child.kill("SIGKILL"); } };
}

const withTimeout = (/** @type {Promise<any>} */ promise, /** @type {number} */ ms) => Promise.race([
	promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
]);

/** Navigate a fresh tab. Reached only if the page shows the fixture marker. */
async function navigate(/** @type {ReturnType<typeof launch>} */ browser, /** @type {string} */ url) {
	const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
	try {
		const result = await withTimeout(browser.send("Page.navigate", { url }, sessionId), NAVIGATION_MS);
		if (result.errorText) return { reached: false, detail: result.errorText, sessionId, targetId };
		for (let attempt = 0; attempt < 20; attempt++) {
			const { result: page } = await browser.send("Runtime.evaluate", { expression: "document.title + ' @ ' + location.href" }, sessionId);
			if (String(page.value).startsWith("fixture:")) return { reached: true, detail: page.value, sessionId, targetId };
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return { reached: false, detail: "no fixture marker", sessionId, targetId };
	} catch (error) {
		return { reached: false, detail: /** @type {Error} */ (error).message, sessionId, targetId };
	}
}

/** fetch() from a page served by the public fixture, like page script would. */
async function pageFetch(/** @type {ReturnType<typeof launch>} */ browser, /** @type {string} */ sessionId, /** @type {string} */ url) {
	const expression = `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(6000), cache: "no-store" })
		.then((response) => response.text()).then((text) => "ok:" + text.slice(0, 60), (error) => "err:" + error.name + ":" + error.message)`;
	const { result } = await withTimeout(browser.send("Runtime.evaluate", { expression, awaitPromise: true }, sessionId), NAVIGATION_MS);
	const value = String(result.value);
	return { reached: value.startsWith("ok:") && value.includes("fixture:"), detail: value.slice(0, 60) };
}

const v4 = pub.hosts.fixture4, v6 = `[${pub.hosts.fixture6}]`;
const allowPublic = true, denyGuarded = !guarded;
/** @type {[string, string, boolean][]} */
const navigations = [
	["navigate public v4 http", `http://${v4}/`, allowPublic],
	["navigate public v4 https", `https://${v4}/`, allowPublic],
	["navigate public v6 http", `http://${v6}/`, allowPublic],
	["navigate public v6 https", `https://${v6}/`, allowPublic],
	["navigate public DNS alias", "http://public.fixture.test/", allowPublic],
	["navigate public non-web port", `http://${v4}:8080/`, denyGuarded],
	["navigate inference provider tuple", `http://${priv.hosts.provider4}:${inferencePort}/`, denyGuarded],
	["navigate provider web port", `http://${priv.hosts.provider4}/`, denyGuarded],
	["navigate unrelated private v4", `http://${priv.hosts.unrelated4}/`, denyGuarded],
	["navigate unrelated private v4 https", `https://${priv.hosts.unrelated4}/`, denyGuarded],
	["navigate unrelated private v6", `http://[${priv.hosts.unrelated6}]/`, denyGuarded],
	["navigate private DNS alias", "http://private.fixture.test/", denyGuarded],
	["navigate gateway-shaped", `http://${priv.hosts.gateway4}/`, denyGuarded],
	["navigate tailnet-shaped", `http://${tailnet.hosts.fixture4}/`, denyGuarded],
	["navigate metadata", `http://${linkLocal.hosts.metadata}/`, denyGuarded],
];
/** @type {[string, string, boolean][]} */
const fetches = [
	["page fetch public v4", `http://${v4}/x`, allowPublic],
	["page fetch public v6", `http://${v6}/x`, allowPublic],
	["page fetch inference provider tuple", `http://${priv.hosts.provider4}:${inferencePort}/`, denyGuarded],
	["page fetch unrelated private", `http://${priv.hosts.unrelated4}/`, denyGuarded],
	["page fetch private v6", `http://[${priv.hosts.unrelated6}]/`, denyGuarded],
	["page fetch metadata", `http://${linkLocal.hosts.metadata}/`, denyGuarded],
	["page fetch tailnet-shaped", `http://${tailnet.hosts.fixture4}/`, denyGuarded],
];
if (guarded) {
	// A loopback fixture listens on 9080 inside the browser's namespace.
	navigations.push(["navigate loopback fixture", "http://127.0.0.1:9080/", false]);
	fetches.push(["page fetch loopback fixture", "http://127.0.0.1:9080/", false]);
}

let failed = 0;
const report = (/** @type {string} */ name, /** @type {boolean} */ allow, /** @type {{ reached: boolean, detail: string }} */ result) => {
	const pass = result.reached === allow;
	if (!pass) failed++;
	console.log(JSON.stringify({ role: `chromium-${role}`, case: name, expected: allow ? "allow" : "deny", observed: result.reached ? "allow" : "deny", detail: result.detail, pass }));
};

const browser = launch([]);
try {
	const { product } = await browser.send("Browser.getVersion");
	console.log(JSON.stringify({ role: `chromium-${role}`, product }));
	for (const [name, url, allow] of navigations) {
		const { sessionId, targetId, ...result } = await navigate(browser, url);
		report(name, allow, result);
		await browser.send("Target.closeTarget", { targetId }).catch(() => {});
	}
} finally { browser.close(); }

// A fresh process for page script, so stalled navigations above cannot
// hold connection slots.
const scripted = launch([]);
try {
	const origin = await navigate(scripted, `http://${v4}/`);
	if (!origin.reached || !origin.detail.endsWith(`@ http://${v4}/`)) throw new Error(`Public http origin page did not load: ${origin.detail}`);
	for (const [name, url, allow] of fetches) report(name, allow, await pageFetch(scripted, origin.sessionId, url));
} finally { scripted.close(); }

// Configured proxies are just more destinations. Neither is on a public web port.
for (const [name, proxy] of [["public-classified", `${v4}:3128`], ["private", `${priv.hosts.unrelated4}:3128`]]) {
	const proxied = launch([`--proxy-server=http://${proxy}`]);
	try {
		const { targetId, sessionId: _, ...result } = await navigate(proxied, "http://public.fixture.test/");
		report(`${name} proxy`, !guarded, { ...result, reached: result.reached && result.detail.includes(":proxy @ ") });
		await proxied.send("Target.closeTarget", { targetId }).catch(() => {});
	} finally { proxied.close(); }
}
process.exit(failed ? 1 : 0);
