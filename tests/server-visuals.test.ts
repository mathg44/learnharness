/**
 * Server visuals (#26): native rendering under the static-SVG policy.
 *
 *   1. staticSvgProblem: local #fragment references only, no active
 *      content, bounded markup and <use> expansion, and one bounded
 *      app-embedded snapshot raster for annotation renders
 *   2. realHeadless.renderSvg in server mode (real resvg): file references
 *      refused before parsing, no browser fallback, bounded canvas
 *   3. runVisualMaker in server mode (faux engine): refused writes/edits,
 *      the inspect loop, render failure, cancellation, saved artifacts,
 *      and the job runner end to end
 *
 * No network and no real provider. Fixtures that name files point at a
 * scratch PNG, so a missed guard would show up as red pixels, not a leak.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import * as photon from "@silvia-odwyer/photon-node";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type ImageContent,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

// Isolate the profile before config or stores load (server-capabilities.test.ts).
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-visuals-"));
const priorEnv = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE"].map((key) => [key, process.env[key]]));
const home = path.join(profile, "home");
const auth = path.join(profile, "auth.json");
fs.mkdirSync(home);
fs.writeFileSync(auth, "{}\n", { mode: 0o600 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: auth });
delete process.env.LH_SERVER_MODE;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { SERVER_CAPABILITIES } = await import("../src/core/server-capabilities.ts");
const { staticSvgProblem, MAX_STATIC_SVG_BYTES } = await import("../src/agent/subagents/static-svg.ts");
const { realHeadless } = await import("../src/agent/subagents/headless.ts");
type HeadlessApi = import("../src/agent/subagents/headless.ts").HeadlessApi;
const { LEARNER_IMAGE_HREF, runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");
const { loadLearnerImage } = await import("../src/agent/tools/learner-image.ts");
const { createJobRunner, visualModelOverride } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { isSubagentFailure } = await import("../src/core/contracts.ts");
type VisualResult = import("../src/core/contracts.ts").VisualResult;
type SteerMessage = import("../src/core/contracts.ts").SteerMessage;
type PiEngine = import("../src/agent/models.ts").PiEngine;
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

const scratch = path.join(profile, "scratch");
fs.mkdirSync(scratch);

// MAIN owns the visual readiness wiring; until it lands, tests stand in for
// a ready check. The definition object is shared, so restore it after each.
const visualCapability = SERVER_CAPABILITIES.visual as { ready: () => boolean };
const shippedReady = visualCapability.ready;

afterEach(() => {
	visualCapability.ready = shippedReady;
	delete process.env.LH_SERVER_MODE;
	headlessOverride.current = undefined;
	visualModelOverride.current = undefined;
});

after(() => {
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} finally {
		for (const [key, value] of Object.entries(priorEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

async function withServer<T>(fn: () => Promise<T> | T, ready = true): Promise<T> {
	process.env.LH_SERVER_MODE = "tailscale";
	visualCapability.ready = () => ready;
	try {
		return await fn();
	} finally {
		delete process.env.LH_SERVER_MODE;
		visualCapability.ready = shippedReady;
	}
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function raster(width: number, height: number, color = "#ff0000"): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = color;
	context.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

function pixel(png: Buffer, x: number, y: number): [number, number, number] {
	const image = photon.PhotonImage.new_from_byteslice(png);
	try {
		const at = (y * image.get_width() + x) * 4;
		const raw = image.get_raw_pixels();
		return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
	} finally {
		image.free();
	}
}

const RED = path.join(scratch, "red.png");
fs.writeFileSync(RED, raster(10, 10));
const RED_DATA = `data:image/png;base64,${raster(10, 10).toString("base64")}`;

const svg = (body: string, attrs = "") =>
	`<svg xmlns="http://www.w3.org/2000/svg"${attrs} width="20" height="20" viewBox="0 0 20 20">${body}</svg>`;

const STATIC_FIGURE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100">
  <style>text{font-family:sans-serif;fill:#202830} .accent{stroke:url(#g)}</style>
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#36c"/></linearGradient>
    <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z"/></marker>
    <circle id="dot" r="3"/>
  </defs>
  <rect width="200" height="100" fill="#fff"/>
  <path class="accent" d="M10 50 L180 50" stroke-width="2" marker-end="url(#arrow)" style="fill:none;filter:url('#none')"/>
  <use href="#dot" x="10" y="50"/><use xlink:href="#dot" x="180" y="50"/>
  <text x="100" y="30" text-anchor="middle" font-size="16">x &amp; y</text>
</svg>`;

/** Faux engine that snapshots every provider-facing context. */
function scripted(steps: FauxResponseStep[], onRequest?: (n: number) => void) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const base = faux.getModel();
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: { ...base, input: ["text", "image"] },
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			onRequest?.(requests.length);
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

function images(context: TranscriptContext): ImageContent[] {
	return context.messages.flatMap((message) =>
		Array.isArray(message.content) ? message.content.filter((part): part is ImageContent => part.type === "image") : [],
	);
}

function text(context: TranscriptContext): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n"),
		)
		.join("\n");
}

/** Real native rendering; the browser-related checks report "unavailable",
 *  as they would in a server container without Chrome. */
function nativeHeadless(): HeadlessApi & { svgCalls: string[] } {
	const svgCalls: string[] = [];
	return {
		svgCalls,
		available: () => false,
		unavailableReason: () => "no browser in this container",
		runDemo: async () => { throw new Error("unexpected demo run"); },
		renderSvg: async (source, opts) => {
			svgCalls.push(source);
			return realHeadless.renderSvg(source, opts);
		},
		renderPdfPages: async () => { throw new Error("unexpected pdf render"); },
	};
}

const write = (source: string, id: string) => fauxToolCall("write_svg", { svg: source }, { id });
const render = (id: string) => fauxToolCall("render_svg", {}, { id });
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

// ─── 1. the static policy ────────────────────────────────────────────────────

describe("staticSvgProblem", () => {
	it("accepts an ordinary static figure with local fragment references", () => {
		assert.equal(staticSvgProblem(STATIC_FIGURE), null);
	});

	const refused: Array<[string, string, RegExp]> = [
		["absolute file image", svg(`<image href="${RED}" width="10" height="10"/>`), /other files, URLs or data/],
		["relative file image", svg('<image href="red.png" width="10" height="10"/>'), /other files, URLs or data/],
		["file URL", svg('<image href="file:///etc/hostname"/>'), /other files, URLs or data/],
		["network image", svg('<image href="https://example.invalid/a.png"/>'), /other files, URLs or data/],
		["xlink external use", svg('<use xlink:href="other.svg#a"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'), /other files, URLs or data/],
		["feImage file", svg(`<filter id="f"><feImage href="${RED}"/></filter>`), /other files, URLs or data/],
		["invented raster", svg(`<image href="${RED_DATA}" width="10" height="10"/>`), /other files, URLs or data/],
		["nested SVG data", svg(`<image href="data:image/svg+xml;base64,${Buffer.from(svg(`<image href="${RED}"/>`)).toString("base64")}"/>`), /other files, URLs or data/],
		["upper-case href", svg(`<image HREF="${RED}"/>`), /other files, URLs or data/],
		["external paint", svg('<rect width="5" height="5" fill="url(/tmp/x.svg#p)"/>'), /local #fragment/],
		["entity-encoded url()", svg('<rect width="5" height="5" fill="&#117;rl(/tmp/x.svg#p)"/>'), /local #fragment/],
		["external style attribute", svg('<rect style="fill:url(https://example.invalid/p)"/>'), /local #fragment/],
		["style block url", svg("<style>rect{fill:url(/tmp/x.svg#p)}</style>"), /local #fragment/],
		["style block in CDATA", svg("<style><![CDATA[rect{fill:url(x.svg#p)}]]></style>"), /local #fragment/],
		["style import", svg('<style>@import "x.css";</style>'), /import/],
		["escaped CSS", svg("<style>rect{fill:\\75 rl(x)}</style>"), /escaped/],
		["document type", `<!DOCTYPE svg [<!ENTITY e SYSTEM "${RED}">]>${svg("<text>&e;</text>")}`, /entities or a document type/],
		["processing instruction", svg('<?xml-stylesheet href="x.css"?>'), /processing instructions/],
		["script", svg("<script>alert(1)</script>"), /static/],
		["foreignObject", svg("<foreignObject><div/></foreignObject>"), /static/],
		["animation", svg('<rect><animate attributeName="x" to="5"/></rect>'), /static/],
		["event handler", svg("", ' onload="alert(1)"'), /event handlers/],
		["xml:base", svg('<g xml:base="/etc/"><use href="#a"/></g>'), /qualified attribute/],
		["namespace alias", svg('<g xmlns:x="http://www.w3.org/1999/xlink"/>'), /namespace aliases/],
		["prefixed element", svg('<svg:image xmlns:svg="http://www.w3.org/2000/svg"/>'), /namespace/],
		["foreign default namespace", svg('<g xmlns="http://www.w3.org/1999/xhtml"/>'), /SVG namespace/],
		["not an SVG", "<html><body/></html>", /complete SVG/],
		["learner placeholder outside image mode", svg(`<image href="${LEARNER_IMAGE_HREF}"/>`), /other files, URLs or data/],
	];
	for (const [name, source, problem] of refused) {
		it(`refuses ${name}`, () => assert.match(staticSvgProblem(source) ?? "(accepted)", problem));
	}

	it("refuses markup over the byte bound", () => {
		const padding = `<!--${"x".repeat(MAX_STATIC_SVG_BYTES)}-->`;
		assert.match(staticSvgProblem(svg(padding)) ?? "", /exceeds 1 MiB/);
	});

	it("bounds <use> fan-out and refuses reference cycles", () => {
		let defs = '<g id="l0"><rect width="1" height="1"/></g>';
		for (let level = 1; level <= 6; level++) defs += `<g id="l${level}">${`<use href="#l${level - 1}"/>`.repeat(10)}</g>`;
		assert.match(staticSvgProblem(svg(`<defs>${defs}</defs><use href="#l6"/>`)) ?? "", /expands to more than/);
		assert.match(staticSvgProblem(svg('<g id="a"><use href="#a"/></g>')) ?? "", /cycle/);
	});

	it("refuses duplicate ids, so a later small duplicate cannot hide the first target's size", () => {
		// resvg resolves the FIRST id: 1000 elements × 100 uses = 100k expanded.
		const big = `<g id="t">${'<rect width="1" height="1"/>'.repeat(1000)}</g>`;
		const source = svg(`<defs>${big}<g id="t"/></defs>${'<use href="#t"/>'.repeat(100)}`);
		assert.ok(source.length < MAX_STATIC_SVG_BYTES);
		assert.match(staticSvgProblem(source) ?? "(accepted)", /ids must be unique/);
		assert.match(staticSvgProblem(svg('<rect id="a"/><circle id="a"/>')) ?? "(accepted)", /ids must be unique/);
		// Without the duplicate, the same fan-out is caught by the expansion bound.
		assert.match(staticSvgProblem(svg(`<defs>${big}</defs>${'<use href="#t"/>'.repeat(100)}`)) ?? "", /expands to more than/);
	});

	it("allows the learner placeholder only on an image while authoring an annotation", () => {
		assert.equal(staticSvgProblem(svg(`<image href="${LEARNER_IMAGE_HREF}"/>`), { learnerPlaceholder: true }), null);
		assert.match(staticSvgProblem(svg(`<use href="${LEARNER_IMAGE_HREF}"/>`), { learnerPlaceholder: true }) ?? "", /other files/);
		assert.match(staticSvgProblem(svg(`<image href="${RED_DATA}"/>`), { learnerPlaceholder: true }) ?? "", /other files/);
	});

	it("admits exactly one bounded PNG or JPEG raster for an annotation render", () => {
		assert.equal(staticSvgProblem(svg(`<image href="${RED_DATA}"/>`), { embeddedRaster: true }), null);
		assert.match(staticSvgProblem(svg(`<image href="${RED_DATA}"/><image href="${RED_DATA}"/>`), { embeddedRaster: true }) ?? "", /only one/);
		assert.match(staticSvgProblem(svg(`<image href="data:image/svg+xml;base64,${Buffer.from(svg("")).toString("base64")}"/>`), { embeddedRaster: true }) ?? "", /PNG or JPEG/);
		assert.match(staticSvgProblem(svg(`<image href="${RED_DATA.replace("image/png", "image/jpeg")}"/>`), { embeddedRaster: true }) ?? "", /do not match/);
		// A PNG header claiming 100000×100000 pixels: refused from the header, never decoded.
		const bomb = raster(1, 1);
		bomb.writeUInt32BE(100_000, 16);
		bomb.writeUInt32BE(100_000, 20);
		assert.match(staticSvgProblem(svg(`<image href="data:image/png;base64,${bomb.toString("base64")}"/>`), { embeddedRaster: true }) ?? "", /out of bounds/);
		assert.match(staticSvgProblem(svg(`<rect fill="url(${RED_DATA})"/>`), { embeddedRaster: true }) ?? "", /local #fragment/);
	});
});

// ─── 2. native rendering in server mode ──────────────────────────────────────

describe("renderSvg in server mode (real resvg)", () => {
	const fileFigure = svg(`<image href="${RED}" width="20" height="20"/>`);

	it("desktop control: resvg itself reads a file path named by <image href>", async () => {
		assert.deepEqual(pixel(await realHeadless.renderSvg(fileFigure), 10, 10), [255, 0, 0]);
	});

	it("refuses file, relative and nested references before resvg parses", async () => {
		await withServer(async () => {
			await assert.rejects(realHeadless.renderSvg(fileFigure), /SVG refused: .*other files/);
			await assert.rejects(realHeadless.renderSvg(fileFigure, { nativeOnly: true }), /SVG refused/);
			const previous = process.cwd();
			process.chdir(scratch);
			try {
				await assert.rejects(realHeadless.renderSvg(svg('<image href="red.png" width="20" height="20"/>')), /SVG refused/);
			} finally {
				process.chdir(previous);
			}
		});
	});

	it("fails malformed SVG natively instead of falling back to a browser", async () => {
		await withServer(async () => {
			await assert.rejects(
				realHeadless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10"'),
				(error: Error) => !/browser|Chrome/i.test(error.message),
			);
		});
	});

	it("refuses a render canvas over the page bounds before allocating it", async () => {
		await withServer(async () => {
			await assert.rejects(
				realHeadless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 100000"><rect width="1" height="1"/></svg>'),
				/exceeds 8192px per side or 16 megapixels/,
			);
			await assert.rejects(realHeadless.renderSvg(svg(""), { width: 100_000, height: 10 }), /exceeds/);
		});
	});

	it("renders a static figure, and the snapshot raster only for the annotation render", async () => {
		await withServer(async () => {
			const png = await realHeadless.renderSvg(STATIC_FIGURE);
			assert.equal(png.readUInt32BE(16), 200);
			const embedded = svg(`<image href="${RED_DATA}" width="20" height="20"/>`);
			assert.deepEqual(pixel(await realHeadless.renderSvg(embedded, { nativeOnly: true }), 10, 10), [255, 0, 0]);
			await assert.rejects(realHeadless.renderSvg(embedded), /SVG refused/);
		});
	});
});

// ─── 3. the maker in server mode ─────────────────────────────────────────────

const GOOD = svg('<rect width="20" height="20" fill="#fff"/><circle cx="10" cy="10" r="5" fill="#36c"/>');
const LEAKY = svg(`<image href="${RED}" width="20" height="20"/>`);

describe("visual maker in server mode", () => {
	it("stays refused while the capability is not ready", async () => {
		const headless = nativeHeadless();
		const { engine, requests } = scripted([]);
		const result = await withServer(() => runVisualMaker({ brief: "b" }, { engine, headless }), false);
		assert.match(result.notes ?? "", /^FAILED: The "visual" job is not available on this server/);
		assert.equal(requests.length, 0);
		assert.equal(headless.svgCalls.length, 0);
	});

	it("refuses file references, then renders, inspects and delivers a static SVG without a browser", async () => {
		const headless = nativeHeadless();
		const { engine, requests } = scripted([
			toolUse(write(LEAKY, "w0")),
			toolUse(write(GOOD, "w1")),
			toolUse(fauxToolCall("edit_svg", { old_text: 'fill="#36c"', new_text: `fill="url(${RED})"` }, { id: "e1" })),
			toolUse(render("r1")),
			fauxAssistantMessage([fauxText("A blue dot.")]),
		]);
		const result = await withServer(() => runVisualMaker({ brief: "A dot." }, { engine, headless }));
		assert.match(text(requests[1]!), /ERROR: SVGs cannot reference other files, URLs or data/);
		assert.match(text(requests[3]!), /ERROR: edit not applied — SVG resources must be local #fragment references/);
		assert.deepEqual(headless.svgCalls, [GOOD], "only the accepted SVG reaches the renderer");
		assert.equal(images(requests[4]!).length, 1, "the render came back to the model to inspect");
		assert.deepEqual(result, { svg: GOOD, notes: "A blue dot." });
	});

	it("desktop keeps accepting the same authored SVG", async () => {
		const calls: string[] = [];
		const headless: HeadlessApi = { ...nativeHeadless(), unavailableReason: () => null, renderSvg: async (source) => { calls.push(source); return raster(4, 4); } };
		const { engine } = scripted([toolUse(write(LEAKY, "w1"), render("r1")), fauxAssistantMessage([fauxText("Done.")])]);
		const result = await runVisualMaker({ brief: "b" }, { engine, headless });
		assert.equal(result.svg, LEAKY);
		assert.deepEqual(calls, [LEAKY]);
	});

	it("reports a native render failure to the model and continues", async () => {
		const malformed = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect></svg>';
		const headless = nativeHeadless();
		const { engine, requests } = scripted([
			toolUse(write(malformed, "w1"), render("r1")),
			toolUse(write(GOOD, "w2"), render("r2")),
			fauxAssistantMessage([fauxText("Fixed.")]),
		]);
		const result = await withServer(() => runVisualMaker({ brief: "b" }, { engine, headless }));
		assert.match(text(requests[1]!), /RENDER ERROR \(the SVG may be malformed\)/);
		assert.doesNotMatch(text(requests[1]!), /browser|Chrome/i);
		assert.deepEqual(result, { svg: GOOD, notes: "Fixed." });
	});

	it("never delivers an unlooked SVG: the finish gate renders natively first", async () => {
		const headless = nativeHeadless();
		const { engine, requests } = scripted([
			toolUse(write(GOOD, "w1")),
			fauxAssistantMessage([fauxText("Done early.")]),
			fauxAssistantMessage([fauxText("Looked; it is right.")]),
		]);
		const result = await withServer(() => runVisualMaker({ brief: "b" }, { engine, headless }));
		assert.match(text(requests[2]!), /You finished without looking/);
		assert.equal(images(requests[2]!).length, 1);
		assert.deepEqual(result, { svg: GOOD, notes: "Looked; it is right." });
	});

	it("an abort during a render fails the job and delivers nothing", async () => {
		const controller = new AbortController();
		const headless: HeadlessApi = {
			...nativeHeadless(),
			renderSvg: async (source, opts) => {
				const png = await realHeadless.renderSvg(source, opts);
				controller.abort();
				return png;
			},
		};
		const { engine } = scripted([toolUse(write(GOOD, "w1"), render("r1")), fauxAssistantMessage([fauxText("Done.")])]);
		const result = await withServer(() => runVisualMaker({ brief: "b" }, { engine, headless, abortSignal: controller.signal }));
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: the maker crashed — aborted/);
	});

	it("annotates a learner image: placeholder authored, snapshot raster rendered, placeholder saved", async () => {
		const image = await loadLearnerImage(path.join(scratch, "red.png"));
		const marked = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${LEARNER_IMAGE_HREF}" x="0" y="0" width="10" height="10"/><circle cx="5" cy="5" r="3" fill="none" stroke="#00f"/></svg>`;
		const extraRaster = marked.replace("<circle", `<rect width="1" height="1" fill="url(${RED_DATA})"/><circle`);
		const headless = nativeHeadless();
		const { engine, requests } = scripted([
			toolUse(write(extraRaster, "w0")),
			toolUse(write(marked, "w1"), render("r1")),
			fauxAssistantMessage([fauxText("Circled the centre.")]),
		]);
		const result = await withServer(() => runVisualMaker({ brief: "Circle the centre.", image }, { engine, headless }));
		assert.match(text(requests[1]!), /ERROR: (annotation )?SVG resources must be local #?fragment references/);
		assert.equal(headless.svgCalls.length, 1);
		assert.ok(headless.svgCalls[0]!.includes(`href="data:${image.mimeType};base64,${image.data}"`), "the app embedded the snapshot for rendering");
		assert.equal(images(requests[2]!).length, 2, "the picture up front, then the render to inspect");
		assert.equal(result.svg, marked, "the saved SVG keeps the placeholder, not the bytes");
		assert.deepEqual(result.image, { path: image.path, snapshotId: image.snapshotId });
	});
});

describe("visual job runner in server mode", () => {
	it("saves the verified SVG and steers it to the chat", async () => {
		const chat = chatStore.createChat("Test: server visual");
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "draw a dot", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-sv", name: "visual", arguments: { brief: "A dot." } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
			{ id: "r1", role: "toolResult", toolCallId: "call-sv", toolName: "visual", content: [{ type: "text", text: "Dispatched." }], details: "Dispatched.", isError: false, timestamp: 1 } as never,
		]);
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-sv", input: { brief: "A dot." } });
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				steers.push(steer);
				const current = jobStore.getJob(job.id);
				if (current?.status === "running") {
					const failed = current.result ? isSubagentFailure(current.kind, current.result as never) : true;
					jobStore.updateJob(job.id, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
				}
			},
		});
		headlessOverride.current = nativeHeadless();
		visualModelOverride.current = scripted([toolUse(write(GOOD, "w1"), render("r1")), fauxAssistantMessage([fauxText("A dot.")])]).engine;
		await withServer(() => runner.runJob(job.id));
		const saved = jobStore.getJob(job.id)!;
		assert.equal(saved.status, "done");
		assert.equal((saved.result as VisualResult).svg, GOOD);
		assert.equal(steers.length, 1);
	});
});
