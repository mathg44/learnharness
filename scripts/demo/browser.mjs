/**
 * One sandboxed Chromium per demo run. The browser starts fresh with an
 * empty profile in its own temporary directory, speaks CDP over a pipe, and
 * is killed with every descendant when the run ends, fails or is cancelled.
 *
 * The document is served from https://demo.invalid/ through Fetch
 * interception, never from file://. Its response carries the offline CSP
 * plus `sandbox allow-scripts`, so it gets the same opaque origin the
 * displayed iframe gets. Every other request is refused and reported.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CdpPipe } from "./cdp-pipe.mjs";
import { OFFLINE_DEMO_CSP, withOfflineDemoPolicy } from "../../src/core/demo-document-policy.ts";

export const CHROMIUM = process.env.LH_DEMO_CHROMIUM ?? "/usr/lib/chromium/chromium";
export const DOCUMENT_URL = "https://demo.invalid/";
export const RUN_TIMEOUT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_SETTLE_MS = 10_000;
const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 500;
const MAX_PROBE_RESULT_CHARS = 8192;

const BROWSER_ARGS = [
	"--headless",
	"--remote-debugging-pipe",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-gpu",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-default-apps",
	"--disable-sync",
	"--disable-breakpad",
	"--disable-crash-reporter",
	"--mute-audio",
	"--password-store=basic",
	"--use-mock-keychain",
];

/** Flags that weaken or remove Chromium's sandbox. Never passed; checked
 *  against the live command lines as part of the sandbox proof. */
const FORBIDDEN_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote", "--disable-seccomp-filter-sandbox", "--disable-namespace-sandbox", "--single-process", "--in-process-gpu"];

export class SandboxRefusal extends Error {}

/** @param {string} text */
function clip(text) {
	const value = String(text);
	return value.length > MAX_ENTRY_CHARS ? `${value.slice(0, MAX_ENTRY_CHARS)}…` : value;
}

/** @param {string[]} list @param {string} entry */
function push(list, entry) {
	if (list.length < MAX_ENTRIES) list.push(clip(entry));
}

// ─── process inspection ─────────────────────────────────────────────────────

/** @param {string} pid */
function readProc(pid) {
	try {
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
		const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? null;
		// Chromium's setproctitle rewrites argv as one space-joined string.
		const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]/).filter(Boolean);
		const ns = (kind) => { try { return fs.readlinkSync(`/proc/${pid}/ns/${kind}`); } catch { return null; } };
		return {
			pid: Number(pid),
			ppid: Number(field("PPid")),
			seccomp: field("Seccomp"),
			seccompFilters: Number(field("Seccomp_filters") ?? NaN),
			noNewPrivs: field("NoNewPrivs"),
			cmdline,
			ns: { user: ns("user"), pid: ns("pid"), net: ns("net") },
		};
	} catch {
		return null;
	}
}

/** Every live descendant of `root`, found through PPid links. */
export function descendants(root) {
	const all = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(readProc).filter(Boolean);
	const children = new Map();
	for (const proc of all) {
		const list = children.get(proc.ppid) ?? [];
		list.push(proc);
		children.set(proc.ppid, list);
	}
	const out = [];
	const queue = [root];
	while (queue.length > 0) {
		const pid = queue.shift();
		for (const child of children.get(pid) ?? []) {
			out.push(child);
			queue.push(child.pid);
		}
	}
	return out;
}

/**
 * Proof that renderers are actually sandboxed, read from the kernel rather
 * than inferred from flags: each renderer must sit in its own user, PID and
 * network namespace and carry more seccomp filters than this controller
 * (Docker's filter is common to both; Chromium's BPF policy is extra).
 */
export function inspectSandbox(browserPid) {
	const self = readProc(String(process.pid));
	const browser = readProc(String(browserPid));
	const tree = descendants(browserPid);
	const renderers = tree.filter((p) => p.cmdline.some((arg) => arg === "--type=renderer"));
	const problems = [];
	const flags = [browser, ...tree].filter(Boolean).flatMap((p) => p.cmdline.filter((arg) => FORBIDDEN_FLAGS.includes(arg)));
	if (flags.length > 0) problems.push(`forbidden flags present: ${[...new Set(flags)].join(" ")}`);
	if (!self || !Number.isFinite(self.seccompFilters)) problems.push("cannot read this process's seccomp state");
	if (renderers.length === 0) problems.push("no renderer process found");
	for (const renderer of renderers) {
		const label = `renderer ${renderer.pid}`;
		if (renderer.seccomp !== "2") problems.push(`${label}: seccomp mode ${renderer.seccomp}`);
		if (!(renderer.seccompFilters > (self?.seccompFilters ?? Infinity))) problems.push(`${label}: no Chromium seccomp-bpf filter`);
		if (renderer.noNewPrivs !== "1") problems.push(`${label}: no_new_privs unset`);
		for (const kind of ["user", "pid", "net"]) {
			const value = renderer.ns[kind];
			if (!value || value === self?.ns[kind]) problems.push(`${label}: shares the ${kind} namespace`);
		}
	}
	return {
		sandboxed: problems.length === 0,
		renderers: renderers.length,
		seccompFilters: { controller: self?.seccompFilters ?? null, renderers: renderers.map((r) => r.seccompFilters) },
		problems,
	};
}

/** A zygote-forked renderer renames itself shortly after fork, so give
 *  the process table a moment before concluding there is none. */
async function awaitRenderers(pid, signal) {
	let report = inspectSandbox(pid);
	for (let i = 0; i < 30 && report.renderers === 0; i++) {
		await abortableSleep(signal, 100);
		report = inspectSandbox(pid);
	}
	return report;
}

/** SIGKILL the browser and everything it started. */
export function killTree(rootPid) {
	let targets = [];
	try { targets = descendants(rootPid).map((p) => p.pid); } catch { /* /proc unreadable */ }
	for (const pid of [rootPid, ...targets]) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
	}
	try { process.kill(-rootPid, "SIGKILL"); } catch { /* group gone */ }
}

// ─── browser session ───────────────────────────────────────────────────────

/**
 * Launch a fresh browser and hand `fn` an attached page session.
 * @template T
 * @param {AbortSignal} signal
 * @param {(ctx: {cdp: CdpPipe, sessionId: string, pid: number}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFreshBrowser(signal, fn) {
	if (signal.aborted) throw signal.reason;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-run-"));
	const child = spawn(CHROMIUM, [...BROWSER_ARGS, `--user-data-dir=${path.join(home, "profile")}`, "about:blank"], {
		detached: true,
		// Nothing from the controller's environment, which is empty anyway.
		env: {
			PATH: "/usr/bin:/bin",
			HOME: home,
			TMPDIR: home,
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			DBUS_SESSION_BUS_ADDRESS: "disabled:",
		},
		stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
	const exited = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig })));
	const cdp = new CdpPipe(/** @type {any} */ (child.stdio[3]), /** @type {any} */ (child.stdio[4]));
	const cleanup = () => {
		cdp.close();
		if (child.pid) killTree(child.pid);
	};
	const onAbort = () => cleanup();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const failed = Promise.race([
			exited.then(({ code, sig }) => { throw new Error(`browser exited (${sig ?? code})${stderr ? `: ${clip(stderr.split("\n").find((l) => /ERROR|FATAL/.test(l)) ?? "")}` : ""}`); }),
			new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
		]);
		failed.catch(() => {});
		const launch = (async () => {
			await withTimeout(cdp.send("Browser.getVersion"), LAUNCH_TIMEOUT_MS, "browser start timed out");
			const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
			const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
			return sessionId;
		})();
		const sessionId = await Promise.race([launch, failed]).catch(async (error) => {
			// A browser that dies at start usually says why on stderr; the pipe
			// error alone (ECONNRESET) hides it.
			await Promise.race([exited, sleep(1000)]);
			if (/No usable sandbox/i.test(stderr)) throw new SandboxRefusal("Chromium found no usable sandbox and refused to start");
			throw error;
		});
		return await Promise.race([fn({ cdp, sessionId, pid: /** @type {number} */ (child.pid) }), failed]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		await Promise.race([cdp.send("Browser.close").catch(() => {}), sleep(1000)]);
		cleanup();
		await Promise.race([exited, sleep(2000)]);
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	}
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {AbortSignal} signal @param {number} ms */
function abortableSleep(signal, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
	});
}

/** @template T @param {Promise<T>} promise @param {number} ms @param {string} message @returns {Promise<T>} */
function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
	]).finally(() => clearTimeout(timer));
}

/** @param {any} arg */
function remoteText(arg) {
	if (!arg) return "";
	if ("value" in arg) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
	return arg.description ?? arg.unserializableValue ?? arg.type ?? "";
}

/**
 * Run one demo document. Throws SandboxRefusal before the document loads
 * when the renderer is not sandboxed.
 * @param {{html: string, probe?: string, settleMs?: number}} request
 * @param {AbortSignal} signal
 */
export async function runDemoDocument(request, signal) {
	const consoleErrors = [];
	const pageErrors = [];
	const failedRequests = [];
	let probeResult;
	let probed = false;
	let sandbox = null;

	await withFreshBrowser(signal, async ({ cdp, sessionId, pid }) => {
		let served = false;
		let documentPhase = false;
		/** @type {string | null} */
		let leftDocument = null;
		let mainFrameId = "";
		// Fetch interception never sees data:, blob: or about: navigations, so
		// watch the main frame itself: any document other than ours fails the
		// run and is never probed.
		const navigatedAway = (url) => {
			if (leftDocument !== null) return;
			leftDocument = url;
			push(failedRequests, `navigation away from the demo blocked: ${describeUrl(url)}`);
		};
		let resolveLoad;
		const loaded = new Promise((resolve) => { resolveLoad = resolve; });
		cdp.on(({ method, params, sessionId: from }) => {
			if (from !== sessionId || !documentPhase) return;
			if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
				push(consoleErrors, params.args.map(remoteText).join(" "));
			} else if (method === "Log.entryAdded" && params.entry.level === "error" && params.entry.source !== "network") {
				push(consoleErrors, params.entry.text);
			} else if (method === "Runtime.exceptionThrown") {
				const details = params.exceptionDetails;
				push(pageErrors, details.exception?.description ?? details.text ?? "uncaught exception");
			} else if (method === "Inspector.targetCrashed") {
				push(pageErrors, "the page crashed (out of memory or a renderer fault)");
				resolveLoad();
			} else if (method === "Page.loadEventFired") {
				resolveLoad();
			} else if (method === "Page.frameRequestedNavigation" && params.frameId === mainFrameId && served && leavesDocument(params.url)) {
				navigatedAway(params.url);
			} else if (method === "Page.frameNavigated" && !params.frame.parentId && leavesDocument(params.frame.url)) {
				navigatedAway(params.frame.url);
			} else if (method === "Fetch.requestPaused") {
				const { requestId, request: req, resourceType } = params;
				if (!served && req.url === DOCUMENT_URL && resourceType === "Document") {
					served = true;
					cdp.send("Fetch.fulfillRequest", {
						requestId,
						responseCode: 200,
						responseHeaders: [
							{ name: "Content-Type", value: "text/html; charset=utf-8" },
							{ name: "Content-Security-Policy", value: `sandbox allow-scripts; ${OFFLINE_DEMO_CSP}` },
							{ name: "Cache-Control", value: "no-store" },
						],
						body: Buffer.from(withOfflineDemoPolicy(request.html), "utf8").toString("base64"),
					}, sessionId).catch(() => {});
					return;
				}
				push(failedRequests, `${req.url.slice(0, 300)} (blocked: offline demo${resourceType === "Document" ? " navigation" : ""})`);
				cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
			}
		});
		// An empty local page first, so a renderer exists to inspect before
		// the demo's bytes reach the browser.
		await cdp.send("Page.enable", {}, sessionId);
		await loadWarmup(cdp, sessionId);
		mainFrameId = (await cdp.send("Page.getFrameTree", {}, sessionId)).frameTree.frame.id;
		await Promise.all([
			cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId),
			cdp.send("Runtime.enable", {}, sessionId),
			cdp.send("Log.enable", {}, sessionId),
		]);

		sandbox = await awaitRenderers(pid, signal);
		if (!sandbox.sandboxed) throw new SandboxRefusal(`Chromium sandbox not active: ${sandbox.problems.join("; ")}`);

		documentPhase = true;
		await cdp.send("Page.navigate", { url: DOCUMENT_URL }, sessionId);
		const loadResult = await Promise.race([
			loaded.then(() => "loaded"),
			abortableSleep(signal, LOAD_TIMEOUT_MS).then(() => "timeout"),
		]);
		if (loadResult === "timeout") push(pageErrors, `the page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`);
		const settleMs = Math.min(Math.max(request.settleMs ?? 2000, 0), MAX_SETTLE_MS);
		await abortableSleep(signal, settleMs);
		if (request.probe && leftDocument === null) {
			probed = true;
			const evaluation = await withTimeout(cdp.send("Runtime.evaluate", {
				expression: request.probe,
				returnByValue: true,
				awaitPromise: true,
				timeout: PROBE_TIMEOUT_MS,
			}, sessionId), PROBE_TIMEOUT_MS + 1000, "probe timed out").catch((error) => ({ error }));
			if (evaluation.error) push(pageErrors, `probe failed: ${evaluation.error.message}`);
			else if (evaluation.exceptionDetails) {
				push(pageErrors, `probe failed: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`);
			} else probeResult = boundedValue(evaluation.result?.value);
		}
		// The page may have started more renderers; prove those too.
		const after = await awaitRenderers(pid, signal);
		if (!after.sandboxed) throw new SandboxRefusal(`Chromium sandbox not active: ${after.problems.join("; ")}`);
	});

	return {
		consoleErrors,
		pageErrors,
		failedRequests,
		...(probed ? { probeResult } : {}),
		ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
		sandbox,
	};
}

/** @param {CdpPipe} cdp @param {string} sessionId */
async function loadWarmup(cdp, sessionId) {
	let stop = () => {};
	const loaded = new Promise((resolve) => {
		stop = cdp.on(({ method, sessionId: from }) => { if (from === sessionId && method === "Page.loadEventFired") resolve(undefined); });
	});
	try {
		await cdp.send("Page.navigate", { url: "data:text/html,<title>ready</title>" }, sessionId);
		await withTimeout(loaded, LOAD_TIMEOUT_MS, "the empty start page did not load");
	} finally {
		stop();
	}
}

/** Fragment links and javascript: URLs stay in the demo's document. */
function leavesDocument(url) {
	const text = String(url);
	if (/^javascript:/i.test(text)) return false;
	return text.split("#")[0] !== DOCUMENT_URL;
}

/** Scheme and a short prefix only: a data: URL can be the whole page. */
function describeUrl(url) {
	const text = String(url);
	const scheme = text.match(/^[a-z][a-z0-9+.-]*:/i)?.[0] ?? "";
	return scheme === "data:" || scheme === "blob:" ? `${scheme} document` : text.slice(0, 200);
}

/** @param {unknown} value */
function boundedValue(value) {
	const json = JSON.stringify(value);
	if (json === undefined || json.length <= MAX_PROBE_RESULT_CHARS) return value;
	return `[probe result truncated: ${json.length} characters] ${json.slice(0, MAX_PROBE_RESULT_CHARS)}`;
}

/** Chromium's own report from chrome://sandbox, in addition to /proc. */
export async function chromiumSandboxReport(signal) {
	return withFreshBrowser(signal, async ({ cdp, sessionId, pid }) => {
		await cdp.send("Page.enable", {}, sessionId);
		const loaded = new Promise((resolve) => cdp.on(({ method }) => { if (method === "Page.loadEventFired") resolve(); }));
		await cdp.send("Page.navigate", { url: "chrome://sandbox" }, sessionId);
		await withTimeout(loaded, LOAD_TIMEOUT_MS, "chrome://sandbox did not load");
		const { result } = await cdp.send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, sessionId);
		const { product } = await cdp.send("Browser.getVersion");
		const text = String(result?.value ?? "");
		return { product, text: text.slice(0, 2000), adequate: /You are adequately sandboxed/i.test(text), proc: await awaitRenderers(pid, signal) };
	});
}
