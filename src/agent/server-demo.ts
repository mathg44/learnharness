import * as http from "node:http";
import { installServerDemoReadiness } from "../core/server-capabilities.ts";
import {
	demoHtmlProblem,
	describeDemoHtmlProblem,
	MAX_DEMO_PROBE_CHARS,
	MAX_DEMO_REQUEST_BYTES,
} from "../core/demo-document-policy.ts";
import type { DemoRunResult, HeadlessApi, RunDemoOptions } from "./subagents/headless.ts";

/**
 * Server-mode demo runtime: the app talks to the offline worker container
 * (scripts/demo) over a Unix socket on the private shared volume. No TCP,
 * no CDP port, no Docker socket, no local browser.
 *
 * Readiness is a process-wide cache refreshed by polling GET /health. The
 * capability check in core is synchronous, so it reads the cache; a check
 * older than FRESH_MS denies.
 */

export const SERVER_DEMO_SOCKET = "/run/learnharness-demo/demo.sock";
const POLL_MS = 5_000;
const FRESH_MS = 15_000;
/** Absolute per-request limits. Health: 4 s. Run: one running plus two
 *  queued 60 s runs, with launch overhead. Mutable only as a test seam. */
export const serverDemoTimeouts = { healthMs: 4_000, runMs: 200_000 };
const MAX_RESPONSE_BYTES = 256 * 1024;

interface ReadinessState {
	socketPath: string;
	started: Promise<void> | null;
	timer: ReturnType<typeof setInterval> | null;
	lastHealthyAt: number;
	reason: string;
}

// Next can load this module in several server bundles; one state for all.
const store = globalThis as typeof globalThis & { __lhServerDemoState?: ReadinessState };
function state(): ReadinessState {
	return (store.__lhServerDemoState ??= {
		socketPath: SERVER_DEMO_SOCKET,
		started: null,
		timer: null,
		lastHealthyAt: 0,
		reason: "the demo worker has not been checked yet",
	});
}

function isFresh(now = Date.now()): boolean {
	const s = state();
	return s.lastHealthyAt > 0 && now - s.lastHealthyAt <= FRESH_MS;
}

function unavailableReason(): string | null {
	if (isFresh()) return null;
	return `The isolated demo runtime is not available: ${state().reason}.`;
}

interface SocketResponse {
	status: number;
	body: unknown;
}

function request(
	socketPath: string,
	method: "GET" | "POST",
	path: string,
	options: { body?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SocketResponse> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(options.signal.reason ?? new Error("aborted"));
			return;
		}
		let settled = false;
		// Every failure path settles once and tears the connection down,
		// which is also how the worker learns to cancel the run.
		const fail = (error: Error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
			req.destroy();
		};
		const req = http.request({
			socketPath,
			method,
			path,
			// Only what the worker needs. Nothing from the app's request context.
			headers: options.body !== undefined
				? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(options.body) }
				: {},
			timeout: options.timeoutMs,
			agent: false,
		}, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_RESPONSE_BYTES) {
					fail(new Error("demo worker response too large"));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (settled) return;
				settled = true;
				let body: unknown = null;
				try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* reported by the caller */ }
				resolve({ status: res.statusCode ?? 0, body });
			});
			res.on("error", fail);
			res.on("close", () => fail(new Error("demo worker closed the connection")));
		});
		const onAbort = () => fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("demo run cancelled"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// Idle timeout plus an absolute deadline: a trickling reply cannot
		// stretch the call past timeoutMs.
		const timedOut = () => fail(new Error("demo worker did not answer in time"));
		req.on("timeout", timedOut);
		const deadline = setTimeout(timedOut, options.timeoutMs);
		req.on("close", () => {
			clearTimeout(deadline);
			options.signal?.removeEventListener("abort", onAbort);
			fail(new Error("demo worker closed the connection"));
		});
		req.on("error", fail);
		req.end(options.body);
	});
}

async function probeHealth(): Promise<void> {
	const s = state();
	try {
		const { status, body } = await request(s.socketPath, "GET", "/health", { timeoutMs: serverDemoTimeouts.healthMs });
		const health = body as { ready?: unknown; reason?: unknown; sandbox?: { proc?: { sandboxed?: unknown } } } | null;
		if (status === 200 && health?.ready === true && health.sandbox?.proc?.sandboxed === true) {
			s.lastHealthyAt = Date.now();
			return;
		}
		s.lastHealthyAt = 0;
		s.reason = typeof health?.reason === "string" ? health.reason.slice(0, 300) : `worker health returned ${status}`;
	} catch (error) {
		s.lastHealthyAt = 0;
		s.reason = `worker unreachable (${error instanceof Error ? error.message : String(error)})`;
	}
}

/**
 * Start the process-wide readiness cache. Idempotent: every caller gets the
 * same promise, which settles after the first health probe completes
 * (healthy or not), so nothing is admitted on an unchecked worker.
 */
export function startServerDemoReadiness(options: { socketPath?: string } = {}): Promise<void> {
	const s = state();
	if (s.started) return s.started;
	if (options.socketPath) s.socketPath = options.socketPath;
	installServerDemoReadiness(() => isFresh());
	s.started = probeHealth().then(() => {
		s.timer = setInterval(() => { void probeHealth(); }, POLL_MS);
		s.timer.unref?.();
	});
	return s.started;
}

/** Test seam: forget the cache and stop polling. */
export function resetServerDemoReadiness(): void {
	const s = state();
	if (s.timer) clearInterval(s.timer);
	installServerDemoReadiness(undefined);
	delete store.__lhServerDemoState;
}

function stringList(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? value.slice(0, 50) : null;
}

/** Run one document in the worker. Throws on transport, refusal or busy. */
export async function runServerDemo(html: string, opts: RunDemoOptions = {}): Promise<DemoRunResult> {
	const reason = unavailableReason();
	if (reason) throw new Error(reason);
	const problem = demoHtmlProblem(html);
	if (problem) throw new Error(`demo refused: ${describeDemoHtmlProblem(problem)}`);
	if (opts.probe !== undefined && opts.probe.length > MAX_DEMO_PROBE_CHARS) {
		throw new Error(`demo refused: the probe is longer than ${MAX_DEMO_PROBE_CHARS} characters`);
	}
	const body = JSON.stringify({
		html,
		...(opts.probe ? { probe: opts.probe } : {}),
		...(opts.settleMs !== undefined ? { settleMs: Math.round(opts.settleMs) } : {}),
	});
	if (Buffer.byteLength(body) > MAX_DEMO_REQUEST_BYTES) {
		throw new Error(`demo refused: the request is larger than ${MAX_DEMO_REQUEST_BYTES / 1024} KB once encoded`);
	}
	const s = state();
	const { status, body: reply } = await request(s.socketPath, "POST", "/run", {
		body,
		timeoutMs: serverDemoTimeouts.runMs,
		signal: opts.signal,
	});
	const record = (reply ?? {}) as Record<string, unknown>;
	if (status !== 200) {
		const message = typeof record.error === "string" ? record.error.slice(0, 500) : `status ${status}`;
		if (status === 503 && /sandbox/i.test(message)) {
			// A refusal is authoritative: deny the capability until health recovers.
			s.lastHealthyAt = 0;
			s.reason = message;
		}
		throw new Error(`demo worker: ${message}`);
	}
	const consoleErrors = stringList(record.consoleErrors);
	const pageErrors = stringList(record.pageErrors);
	const failedRequests = stringList(record.failedRequests);
	if (!consoleErrors || !pageErrors || !failedRequests || typeof record.ok !== "boolean") {
		throw new Error("demo worker returned a malformed result");
	}
	return {
		consoleErrors,
		pageErrors,
		failedRequests,
		...("probeResult" in record ? { probeResult: record.probeResult } : {}),
		ok: record.ok && consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
	};
}

/** The server's HeadlessApi: demos go to the worker, the rest stays native. */
export function createServerHeadless(native: Pick<HeadlessApi, "renderSvg" | "renderPdfPages">): HeadlessApi {
	return {
		available: () => isFresh(),
		unavailableReason,
		runDemo: runServerDemo,
		renderSvg: native.renderSvg,
		renderPdfPages: native.renderPdfPages,
	};
}
