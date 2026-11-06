/**
 * PDF notes import through the real pipeline, offline. The PDF bytes are
 * built here (one text page, one image page, one blank page) and rendered
 * by pdfjs + @napi-rs/canvas. Every model is a faux engine. The graph lives
 * in memory and the chat store is a stub that throws on use: the notes path
 * has no business touching chats or the data directory.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { CoverageEntry, ExtractionRunUsage, GraphChain, GraphNode, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { abortExtraction, createExtractionPipeline, extractionStatuses, NotesImportError, type ExtractionPipelineDeps } from "../src/agent/subagents/extraction.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing } from "../src/core/settings.ts";

// ─── a tiny synthetic PDF ────────────────────────────────────────────────────

/** Three pages: typed text, a 2x2 RGB image, nothing. Offsets are computed so
 *  pdfjs reads the xref as written instead of reconstructing it. */
function tinyPdf(): Uint8Array {
	const text = "BT /F1 24 Tf 72 700 Td (Synthetic heading) Tj ET";
	const image = "q 200 0 0 200 100 300 cm /Im1 Do Q";
	const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 9 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		null, // the image, binary
		`<< /Length ${image.length} >>\nstream\n${image}\nendstream`,
	];
	const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
	const offsets: number[] = [];
	let length = chunks[0]!.length;
	const push = (b: Buffer) => { chunks.push(b); length += b.length; };
	objects.forEach((body, i) => {
		offsets.push(length);
		push(Buffer.from(`${i + 1} 0 obj\n`));
		if (body === null) {
			push(Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`));
			push(pixels);
			push(Buffer.from("\nendstream"));
		} else push(Buffer.from(body));
		push(Buffer.from("\nendobj\n"));
	});
	const xref = length;
	const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
	push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
	return new Uint8Array(Buffer.concat(chunks));
}

// ─── fixtures ────────────────────────────────────────────────────────────────

type Faux = ReturnType<typeof createFauxCore>;

function engine(steps: FauxResponseStep[], vision = false): { engine: PiEngine; faux: Faux } {
	const faux = createFauxCore(vision ? { models: [{ id: "faux-vision", input: ["text", "image"] }] } : {});
	faux.setResponses(steps);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, faux };
}

const FINDINGS = {
	propositions: [{ id: "p1", name: "Synthetic heading", statement: "The synthetic page has a heading.", aliases: [] }],
	chains: [],
};

function submit(name: string, input: unknown, seen?: string[]) {
	return engine([(context: TranscriptContext) => {
		seen?.push(contextText(context));
		return fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" });
	}]);
}

function contextText(context: TranscriptContext): string {
	return context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : m.content.flatMap((c) => c.type === "text" ? [c.text] : [])).join("\n");
}

const PAGE_REPLIES = ["# Synthetic heading", "Figure: three colored squares", "[blank page]"];

/** A page step: a plain-text reply, after checking the page really arrived as an image. */
function pageReply(text: string, before?: () => void | Promise<void>): FauxResponseStep {
	return async (context) => {
		const last = context.messages.at(-1)!;
		assert.ok(Array.isArray(last.content) && last.content.some((c) => c.type === "image"), "each page is sent as an image");
		await before?.();
		return fauxAssistantMessage(text);
	};
}

function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const positions = new Map<string, { x: number; y: number }>();
	return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		deleteSources: (ids: ReadonlySet<string>) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (source && !source.extractions?.some((r) => r.startedAt === entry.startedAt)) source.extractions = [...(source.extractions ?? []), entry];
		},
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes);
			if (next.chains) chains.splice(0, chains.length, ...next.chains);
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage);
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints);
		},
	} satisfies GraphStore;
}

/** The notes path must never reach the chat store. */
const noChats = new Proxy({}, { get: (_, key) => { throw new Error(`notes import touched chatStore.${String(key)}`); } }) as ExtractionPipelineDeps["chatStore"];

const sourceId = (filePath: string) => `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

const outcome = (expected: NotesImportError["outcome"]) => (error: unknown) => {
	assert.ok(error instanceof NotesImportError, String(error));
	assert.equal(error.outcome, expected);
	return true;
};

async function until(cond: () => boolean, ms = 5000): Promise<void> {
	for (const t0 = Date.now(); !cond(); ) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true in time");
		await new Promise((r) => setTimeout(r, 2));
	}
}

const transcriptionOnly = (run: ExtractionRunUsage | undefined) => {
	assert.ok(run, "a usage record exists");
	assert.deepEqual(run.stages.extractor, { model: "unknown", steps: [] });
	assert.deepEqual(run.stages.auditor, { model: "unknown", steps: [] });
	return run.stages.transcription!;
};

// ─── tests ───────────────────────────────────────────────────────────────────

describe("PDF notes import (offline pipeline)", () => {
	for (const server of [false, true]) it(`transcribes every page in order and hands the whole Markdown to the extractor${server ? " in server mode" : ""}`, async (t) => {
		const previous = process.env.LH_SERVER_MODE;
		if (server) process.env.LH_SERVER_MODE = "tailscale";
		else delete process.env.LH_SERVER_MODE;
		t.after(() => {
			if (previous === undefined) delete process.env.LH_SERVER_MODE;
			else process.env.LH_SERVER_MODE = previous;
		});
		const ledgers = memoryLedgers();
		const seen: string[] = [];
		const reader = engine(PAGE_REPLIES.map((text) => pageReply(text)), true);
		const extractor = submit("submit_findings", FINDINGS, seen);
		const auditor = submit("submit_review", { links: [] });
		const pdf = tinyPdf();
		const before = Buffer.from(pdf);
		// An uploaded relative path with no file behind it: the bytes are the only input.
		const filePath = "Uploads/no-such-dir/course.pdf";
		const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, pdfReader: reader.engine, extractor: extractor.engine, auditor: auditor.engine });

		assert.deepEqual(await pipeline.importNotes({ filePath, text: "ignored for PDFs", pdf }), { nodes: 1, chains: 0 });

		assert.equal(reader.faux.state.callCount, 3, "one call per page");
		assert.equal(seen.length, 1);
		const prompt = seen[0]!;
		const expected = "--- Page 1 ---\n\n# Synthetic heading\n\n--- Page 2 ---\n\nFigure: three colored squares\n\n--- Page 3 ---\n\n[blank page]";
		assert.ok(prompt.includes(expected), `extractor saw the ordered transcription:\n${prompt}`);
		assert.ok(!prompt.includes("ignored for PDFs"), "PDF transcription replaces the text field");
		assert.deepEqual(Buffer.from(pdf), before, "caller's bytes untouched");
		assert.equal(ledgers.readNodes().length, 1);

		const [source] = ledgers.readSources();
		assert.equal(source!.id, sourceId(filePath));
		const runs = source!.extractions ?? [];
		const transcription = transcriptionOnly(runs.find((r) => r.stages.transcription));
		assert.equal(transcription.steps.length, 3);
		assert.ok(transcription.steps.every((s) => (s.inputTokens ?? 0) > 0));
		assert.ok(runs.some((r) => !r.stages.transcription && r.stages.extractor.steps.length > 0), "graph extraction usage is its own record");
		assert.equal(extractionStatuses().length, 0);
	});

	for (const failure of ["truncated", "thrown"] as const) it(`a ${failure} page fails the import with no graph work, keeping usage already admitted`, async () => {
		const ledgers = memoryLedgers();
		const bad: FauxResponseStep = failure === "truncated"
			? fauxAssistantMessage("# Synthetic hea", { stopReason: "length" })
			: () => { throw new Error("synthetic provider failure"); };
		const reader = engine([pageReply(PAGE_REPLIES[0]!), bad, pageReply(PAGE_REPLIES[2]!)], true);
		const extractor = submit("submit_findings", FINDINGS);
		const auditor = submit("submit_review", { links: [] });
		const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, pdfReader: reader.engine, extractor: extractor.engine, auditor: auditor.engine });

		await assert.rejects(pipeline.importNotes({ filePath: `${failure}.pdf`, text: "", pdf: tinyPdf() }), (error) => {
			outcome("failed")(error);
			assert.match((error as Error).message, /page 2 of 3/);
			return true;
		});
		assert.equal(reader.faux.state.callCount, 2, "page 3 never sent");
		assert.equal(extractor.faux.state.callCount, 0);
		assert.equal(auditor.faux.state.callCount, 0);
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readChains().length, 0);
		const [source] = ledgers.readSources();
		assert.ok(source, "the source record may exist after a failed transcription");
		assert.equal(source.extractions?.length, 1);
		const transcription = transcriptionOnly(source.extractions![0]);
		assert.equal(transcription.steps.length, 2, "page 1 and the failed page 2 are both billed");
		assert.equal(extractionStatuses().length, 0);
	});

	it("unreadable bytes behind a %PDF- header fail with a source but no model call or graph write", async () => {
		const ledgers = memoryLedgers();
		const reader = engine([], true);
		const extractor = submit("submit_findings", FINDINGS);
		const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, pdfReader: reader.engine, extractor: extractor.engine, auditor: submit("submit_review", { links: [] }).engine });
		await assert.rejects(pipeline.importNotes({ filePath: "broken.pdf", text: "", pdf: new TextEncoder().encode("%PDF-1.4\nnot really") }), (error) => {
			outcome("failed")(error);
			assert.match((error as Error).message, /Could not open this PDF/);
			return true;
		});
		assert.equal(reader.faux.state.callCount, 0);
		assert.equal(extractor.faux.state.callCount, 0);
		assert.equal(ledgers.readNodes().length, 0);
		assert.deepEqual(ledgers.readSources()[0]?.extractions, [], "no usage, nothing billed");
	});

	describe("readiness refuses before any model call or source write", () => {
		const cases: { label: string; reader: boolean; deps: () => Partial<ExtractionPipelineDeps>; check: (error: unknown) => boolean }[] = [
			{
				label: "no PDF reader (vision slot) configured",
				reader: false,
				deps: () => ({ extractor: submit("submit_findings", FINDINGS).engine, auditor: submit("submit_review", { links: [] }).engine }),
				check: (error) => error instanceof ModelsNotConfiguredError && JSON.stringify(error.envelope.missing) === JSON.stringify(["vision"]),
			},
			{
				label: "no extractor (cheap slot) configured",
				reader: true,
				deps: () => ({ auditor: submit("submit_review", { links: [] }).engine }),
				check: (error) => error instanceof ModelsNotConfiguredError && JSON.stringify(error.envelope.missing) === JSON.stringify(["cheap"]),
			},
			{
				label: "the PDF reader's provider key is gone",
				reader: true,
				deps: () => ({
					extractor: submit("submit_findings", FINDINGS).engine,
					auditor: submit("submit_review", { links: [] }).engine,
					providerKeyMissing: (provider, tier) => (tier === "vision" ? providerKeyMissing(provider, [tier]) : null),
				}),
				check: (error) => error instanceof ProviderKeyMissingError && JSON.stringify(error.envelope.slots) === JSON.stringify(["vision"]),
			},
		];
		for (const { label, reader: withReader, deps, check } of cases) it(label, async () => {
			const ledgers = memoryLedgers();
			const reader = engine([pageReply("never")], true);
			const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, ...(withReader ? { pdfReader: reader.engine } : {}), ...deps() });
			await assert.rejects(pipeline.importNotes({ filePath: "refused.pdf", text: "", pdf: tinyPdf() }), check);
			assert.equal(reader.faux.state.callCount, 0);
			assert.deepEqual(ledgers.readSources(), []);
			assert.equal(extractionStatuses().length, 0);
		});

		it("the key gate sees the PDF reader as the vision tier, after the cheap stages", async () => {
			const tiers: string[] = [];
			const reader = engine([], true);
			const pipeline = createExtractionPipeline({
				chatStore: noChats, graphStore: memoryLedgers(),
				pdfReader: reader.engine,
				extractor: submit("submit_findings", FINDINGS).engine,
				auditor: submit("submit_review", { links: [] }).engine,
				providerKeyMissing: (provider, tier) => { tiers.push(tier); return tier === "vision" ? providerKeyMissing(provider, [tier]) : null; },
			});
			await assert.rejects(pipeline.importNotes({ filePath: "gate.pdf", text: "", pdf: tinyPdf() }), ProviderKeyMissingError);
			assert.deepEqual(tiers, ["cheap", "cheap", "vision"]);
		});
	});

	it("the source is busy while pages transcribe, the status row says so, and a failure releases it for retry", async () => {
		const ledgers = memoryLedgers();
		let upserts = 0;
		const tracked: GraphStore = { ...ledgers, upsertSource: (s) => { upserts++; ledgers.upsertSource(s); } };
		const filePath = "busy.pdf";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let page2Started = false;
		const reader = engine([
			pageReply(PAGE_REPLIES[0]!),
			pageReply("", async () => { page2Started = true; await gate; throw new Error("synthetic page failure"); }),
		], true);
		const extractor = submit("submit_findings", FINDINGS);
		const make = (pdfReader: PiEngine, ext = extractor.engine) =>
			createExtractionPipeline({ chatStore: noChats, graphStore: tracked, pdfReader, extractor: ext, auditor: submit("submit_review", { links: [] }).engine });

		const first = make(reader.engine).importNotes({ filePath, text: "", pdf: tinyPdf() });
		await until(() => page2Started);
		try {
			const row = extractionStatuses().find((r) => r.chatId === sourceId(filePath));
			assert.equal(row?.phase, "transcribing");
			assert.equal(row?.kind, "notes");
			assert.equal(row?.label, filePath);
			assert.deepEqual(row?.part, { i: 2, n: 3 });
			await assert.rejects(make(engine([], true).engine).importNotes({ filePath, text: "", pdf: tinyPdf() }), outcome("busy"));
			await assert.rejects(make(engine([], true).engine).importNotes({ filePath, text: "plain text, same path" }), outcome("busy"));
			assert.equal(upserts, 1, "busy attempts never write source metadata");
		} finally { release(); }
		await assert.rejects(first, outcome("failed"));
		assert.equal(extractor.faux.state.callCount, 0);
		assert.equal(ledgers.readNodes().length, 0);

		const retryReader = engine(PAGE_REPLIES.map((text) => pageReply(text)), true);
		const retryExtractor = submit("submit_findings", FINDINGS);
		assert.deepEqual(await make(retryReader.engine, retryExtractor.engine).importNotes({ filePath, text: "", pdf: tinyPdf() }), { nodes: 1, chains: 0 });
		assert.equal(ledgers.readSources().length, 1);
		const runs = ledgers.readSources()[0]!.extractions ?? [];
		assert.deepEqual(runs.filter((r) => r.stages.transcription).map((r) => r.stages.transcription!.steps.length), [2, 3], "failed and retried transcriptions both billed");
	});

	it("the source stays busy from transcription through graph extraction", async () => {
		const ledgers = memoryLedgers();
		const filePath = "held.pdf";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let extracting = false;
		const extractor = engine([async () => {
			extracting = true;
			await gate;
			return fauxAssistantMessage([fauxToolCall("submit_findings", FINDINGS as unknown as ToolCall["arguments"], { id: "f" })], { stopReason: "toolUse" });
		}]);
		const make = (pdfReader: PiEngine) => createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, pdfReader, extractor: extractor.engine, auditor: submit("submit_review", { links: [] }).engine });
		const first = make(engine(PAGE_REPLIES.map((text) => pageReply(text)), true).engine).importNotes({ filePath, text: "", pdf: tinyPdf() });
		await until(() => extracting);
		try {
			await assert.rejects(make(engine([], true).engine).importNotes({ filePath, text: "", pdf: tinyPdf() }), outcome("busy"));
		} finally { release(); }
		assert.deepEqual(await first, { nodes: 1, chains: 0 });
	});

	it("abort during a page stops later pages and extraction, and persists the usage so far", async () => {
		const ledgers = memoryLedgers();
		const filePath = "abort.pdf";
		const reader = engine([
			pageReply(PAGE_REPLIES[0]!),
			pageReply(PAGE_REPLIES[1]!, () => { assert.equal(abortExtraction(sourceId(filePath)), true); }),
			pageReply(PAGE_REPLIES[2]!),
		], true);
		const extractor = submit("submit_findings", FINDINGS);
		const auditor = submit("submit_review", { links: [] });
		const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: ledgers, pdfReader: reader.engine, extractor: extractor.engine, auditor: auditor.engine });

		await assert.rejects(pipeline.importNotes({ filePath, text: "", pdf: tinyPdf() }), outcome("aborted"));
		assert.equal(reader.faux.state.callCount, 2, "page 3 never sent");
		assert.equal(extractor.faux.state.callCount, 0);
		assert.equal(auditor.faux.state.callCount, 0);
		assert.equal(ledgers.readNodes().length, 0);
		const runs = ledgers.readSources()[0]!.extractions ?? [];
		assert.equal(runs.length, 1);
		assert.equal(transcriptionOnly(runs[0]).steps.length, 2, "page 1 and the aborted page 2 reply are both billed");
		assert.equal(extractionStatuses().length, 0, "row removed");
		assert.equal(abortExtraction(sourceId(filePath)), false);
	});
});
