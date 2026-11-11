/**
 * Server-mode demo documents without a browser: the shared policy module,
 * the demo card under each RuntimePolicy (saved replays included), and the
 * demo builder's server prompt, offline gate and cancellation with a
 * scripted model and a fake headless API. The real-browser proofs live in
 * tests/demo-browser (they need Docker and the worker image).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import {
	demoHtmlProblem,
	findExternalReferences,
	MAX_DEMO_HTML_BYTES,
	OFFLINE_DEMO_CSP,
	OFFLINE_DEMO_DOWNLOAD_CSP,
	OFFLINE_DEMO_PARENT_CSP,
	offlineDemoDownload,
	withOfflineDemoPolicy,
} from "../src/core/demo-document-policy.ts";
import { buildDemoSrcDoc, demoDownloadFor, demoSrcDocFor, DemoOutputCard } from "../components/artifacts/demo-card.tsx";
import { RuntimePolicyProvider } from "../components/runtime-policy.tsx";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import type { DemoRunResult, HeadlessApi, RunDemoOptions } from "../src/agent/subagents/headless.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { installServerDemoReadiness } from "../src/core/server-capabilities.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const previousMode = process.env.LH_SERVER_MODE;
afterEach(() => {
	installServerDemoReadiness(undefined);
	if (previousMode === undefined) delete process.env.LH_SERVER_MODE;
	else process.env.LH_SERVER_MODE = previousMode;
});

function serverMode() {
	process.env.LH_SERVER_MODE = "tailscale";
	installServerDemoReadiness(() => true);
}

describe("offline demo-document policy", () => {
	it("puts the CSP before every demo element, after the doctype", () => {
		const doc = withOfflineDemoPolicy("<!DOCTYPE html><html><head><script>x()</script></head></html>");
		assert.ok(doc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\""));
		assert.ok(doc.indexOf(OFFLINE_DEMO_CSP) < doc.indexOf("<script>"));
		const bare = withOfflineDemoPolicy("<div>fragment</div>");
		assert.ok(bare.startsWith("<meta http-equiv=\"Content-Security-Policy\""), "no doctype added: quirks mode kept");
	});

	it("allows inline code only and denies every fetching directive", () => {
		for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
			assert.ok(OFFLINE_DEMO_CSP.includes(directive), directive);
		}
		assert.doesNotMatch(OFFLINE_DEMO_CSP, /https?:|\*|'self'/);
		assert.equal(OFFLINE_DEMO_PARENT_CSP, "frame-src 'none'; child-src 'none'");
	});

	it("refuses malformed and oversized documents", () => {
		assert.deepEqual(demoHtmlProblem(42), { kind: "not-text" });
		assert.deepEqual(demoHtmlProblem(" \n"), { kind: "empty" });
		assert.deepEqual(demoHtmlProblem("a\u0000b"), { kind: "nul" });
		assert.deepEqual(demoHtmlProblem("a\ud800b"), { kind: "lone-surrogate" });
		assert.equal(demoHtmlProblem("é".repeat(MAX_DEMO_HTML_BYTES / 2)), null, "exactly at the byte limit");
		assert.equal(demoHtmlProblem(`${"é".repeat(MAX_DEMO_HTML_BYTES / 2)}x`)?.kind, "too-large");
		assert.equal(demoHtmlProblem("<p>😀</p>"), null);
	});

	it("finds network addresses but not XML namespaces", () => {
		const html = `<svg xmlns="http://www.w3.org/2000/svg"></svg>
			<script src="https://cdn.example/lib.js"></script><img src="//img.example/a.png">
			<style>@import "//css.example/x.css"; b{background:url(file:///etc/passwd)}</style>`;
		assert.deepEqual(findExternalReferences(html), [
			"https://cdn.example/lib.js", "file:///etc/passwd", "//img.example/a.png", "//css.example/x.css",
		]);
		assert.deepEqual(findExternalReferences("createElementNS('http://www.w3.org/2000/svg','g')"), []);
	});

	it("downloads a fixed script-free outer page with the demo only in the sandboxed srcdoc", () => {
		const html = `<!doctype html><script>alert("a&b")</script><p title="q">x</p>`;
		const file = offlineDemoDownload(`My "demo" <1>`, html);
		const [outer, ...rest] = file.split("srcdoc=\"");
		assert.equal(rest.length, 1);
		assert.doesNotMatch(outer!, /<script/i, "no executable code outside the frame");
		assert.ok(outer!.includes(OFFLINE_DEMO_DOWNLOAD_CSP));
		assert.match(OFFLINE_DEMO_DOWNLOAD_CSP, /script-src 'none'/);
		assert.match(OFFLINE_DEMO_DOWNLOAD_CSP, /frame-src 'none'; child-src 'none'/);
		assert.match(outer!, /<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"/);
		assert.match(outer!, /<title>My &quot;demo&quot; &lt;1&gt;<\/title>/);
		const attribute = rest[0]!.slice(0, rest[0]!.indexOf("\""));
		assert.doesNotMatch(attribute, /[<>"]/, "srcdoc fully escaped");
		const decoded = attribute.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
		assert.equal(decoded, withOfflineDemoPolicy(html));
	});
});

describe("demo card under the runtime policy", () => {
	const saved = { title: "Pendulum", html: "<!doctype html><html><body><canvas></canvas></body></html>", tested: true as const };

	it("desktop documents are unchanged", () => {
		assert.equal(demoSrcDocFor(saved.html, "desktop"), buildDemoSrcDoc(saved.html));
		assert.equal(demoDownloadFor("t", saved.html, "desktop"), saved.html);
		const markup = renderToStaticMarkup(<DemoOutputCard output={saved} />);
		assert.doesNotMatch(markup, /Content-Security-Policy/);
	});

	it("a saved demo replayed on the server opens with the offline policy", () => {
		const srcDoc = demoSrcDocFor(saved.html, "offline");
		assert.ok(srcDoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${OFFLINE_DEMO_CSP}">`));
		assert.match(srcDoc, /demo-resize/, "bridge still injected, inside the frame");
		const markup = renderToStaticMarkup(
			<RuntimePolicyProvider policy={{ demoDocuments: "offline" }}><DemoOutputCard output={saved} /></RuntimePolicyProvider>,
		);
		assert.match(markup, /sandbox="allow-scripts"/);
		assert.match(markup, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
		assert.match(markup, /Content-Security-Policy/);
		assert.doesNotMatch(markup, /demo-offline-note/);
	});

	it("a saved demo that names network resources shows the offline note", () => {
		const cdn = { ...saved, html: `<script src="https://cdn.jsdelivr.net/npm/d3"></script>` };
		const markup = renderToStaticMarkup(
			<RuntimePolicyProvider policy={{ demoDocuments: "offline" }}><DemoOutputCard output={cdn} /></RuntimePolicyProvider>,
		);
		assert.match(markup, /demo-offline-note/);
		const desktop = renderToStaticMarkup(<DemoOutputCard output={cdn} />);
		assert.doesNotMatch(desktop, /demo-offline-note/);
	});

	it("a saved demo over the server limit is refused, not framed", () => {
		const huge = { ...saved, html: "x".repeat(MAX_DEMO_HTML_BYTES + 1) };
		const markup = renderToStaticMarkup(
			<RuntimePolicyProvider policy={{ demoDocuments: "offline" }}><DemoOutputCard output={huge} /></RuntimePolicyProvider>,
		);
		assert.match(markup, /demo-card-failed/);
		assert.match(markup, /cannot be shown on this server/);
		assert.doesNotMatch(markup, /<iframe/);
	});
});

// ─── builder ────────────────────────────────────────────────────────────────

type Turn = { toolCalls?: Array<{ toolName: string; input: unknown }>; text?: string };

function scriptedModel(turns: Turn[], prompts: string[] = []): PiEngine {
	let n = 0;
	const steps: FauxResponseStep[] = turns.map((step) => (context) => {
		// The system prompt is the transcript's leading system message.
		prompts.push(JSON.stringify((context as { messages?: unknown[] }).messages?.[0] ?? ""));
		if (step.toolCalls) {
			return fauxAssistantMessage(
				step.toolCalls.map((c) => fauxToolCall(c.toolName, c.input as ToolCall["arguments"], { id: `call-${n++}` })),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(step.text ?? "");
	});
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const CLEAN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };

function fakeHeadless(run: (html: string, opts?: RunDemoOptions) => Promise<DemoRunResult> = async () => CLEAN) {
	const calls: Array<{ html: string; opts?: RunDemoOptions }> = [];
	const api: HeadlessApi = {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async (html, opts) => { calls.push({ html, opts }); return run(html, opts); },
		renderSvg: async () => Buffer.alloc(0),
		renderPdfPages: async () => [],
	};
	return { api, calls };
}

const GOOD = "<!doctype html><html><body><input type=range><script>window.ok=1</script></body></html>";

describe("demo builder in server mode", () => {
	it("tells the model the runtime is offline, desktop keeps CDN guidance", async () => {
		const serverPrompts: string[] = [];
		serverMode();
		await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] }, { toolCalls: [{ toolName: "run_demo", input: {} }] }, { text: "notes" }], serverPrompts),
			headless: fakeHeadless().api,
		});
		assert.match(serverPrompts[0]!, /fully OFFLINE/);
		assert.doesNotMatch(serverPrompts[0]!, /CDN imports .* are allowed/);

		delete process.env.LH_SERVER_MODE;
		const desktopPrompts: string[] = [];
		await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] }, { toolCalls: [{ toolName: "run_demo", input: {} }] }, { text: "notes" }], desktopPrompts),
			headless: fakeHeadless().api,
		});
		assert.match(desktopPrompts[0]!, /CDN imports/);
		assert.doesNotMatch(desktopPrompts[0]!, /{{runtime}}/);
	});

	it("synthetic success passes the job's signal to every run", async () => {
		serverMode();
		const { api, calls } = fakeHeadless();
		const controller = new AbortController();
		const result = await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] }, { toolCalls: [{ toolName: "run_demo", input: { probe: "window.ok" } }] }, { text: "Drag the slider." }]),
			headless: api,
			abortSignal: controller.signal,
		});
		assert.equal(result.html, GOOD);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.opts?.probe, "window.ok");
		assert.equal(calls[0]!.opts?.signal, controller.signal);
	});

	it("a CDN reference fails the run, the model fixes it, the fixed demo ships", async () => {
		serverMode();
		const cdn = `<!doctype html><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas></canvas>`;
		const { api, calls } = fakeHeadless();
		const result = await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolName: "write_demo", input: { html: cdn } }] },
				{ toolCalls: [{ toolName: "run_demo", input: {} }] },
				{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] },
				{ toolCalls: [{ toolName: "run_demo", input: {} }] },
				{ text: "fixed" },
			]),
			headless: api,
		});
		assert.equal(result.html, GOOD);
		assert.equal(calls.length, 2);
	});

	it("never delivers a demo that still names a network address", async () => {
		serverMode();
		const cdn = `<!doctype html><script src="https://unpkg.com/three"></script>`;
		const result = await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: cdn } }] }, { text: "done (claims success)" }]),
			headless: fakeHeadless().api,
		});
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /network addresses are not allowed offline: https:\/\/unpkg\.com\/three/);
	});

	it("refuses to save an oversized document", async () => {
		serverMode();
		const { api, calls } = fakeHeadless();
		const result = await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: "x".repeat(MAX_DEMO_HTML_BYTES + 10) } }] }, { text: "done" }]),
			headless: api,
		});
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /never wrote a demo/);
		assert.equal(calls.length, 0);
	});

	it("worker errors reach the model as HEADLESS ERROR and the build recovers", async () => {
		serverMode();
		let first = true;
		const { api } = fakeHeadless(async () => {
			if (first) { first = false; throw new Error("demo worker: demo runtime busy"); }
			return CLEAN;
		});
		const result = await runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] },
				{ toolCalls: [{ toolName: "run_demo", input: {} }] },
				{ toolCalls: [{ toolName: "run_demo", input: {} }] },
				{ text: "ok" },
			]),
			headless: api,
		});
		assert.equal(result.html, GOOD);
	});

	it("cancellation during the final verification delivers nothing", async () => {
		serverMode();
		const controller = new AbortController();
		const { api } = fakeHeadless(async (_html, opts) => {
			controller.abort(new Error("Aborted by learner"));
			throw opts?.signal?.reason ?? new Error("not cancelled");
		});
		await assert.rejects(runDemoBuilder({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ toolCalls: [{ toolName: "write_demo", input: { html: GOOD } }] }, { text: "done" }]),
			headless: api,
			abortSignal: controller.signal,
		}), /Aborted by learner/);
	});

	it("an unready worker refuses the job before the model runs", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerDemoReadiness(() => false);
		const prompts: string[] = [];
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: scriptedModel([{ text: "x" }], prompts), headless: fakeHeadless().api });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /not available on this server/);
		assert.equal(prompts.length, 0);
	});
});
