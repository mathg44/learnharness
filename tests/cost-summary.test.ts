/**
 * Tests for src/core/cost-summary.ts — the graph cost pill's pure fold.
 * Same laws as the money channel everywhere: dollars INFERRED at read
 * time (core/prices.ts), unpriced models excluded-but-counted (render
 * "—", never a silent zero), tokens always sum.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	graphCostSummary as foldGraphCostSummary,
	type CostSummaryInput,
	type GraphCostSummary,
} from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage, ExtractionStageUsage } from "../src/core/contracts.ts";
import { callCost } from "../src/server/pricing.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, callCost);

/** A model with full published pricing (from the generated registry). */
const PRICED = "openrouter:z-ai/glm-5.3-flash";
assert.notEqual(callCost({ inputTokens: 1, outputTokens: 1 }, PRICED), null);

const step = (input: number, output: number): CallUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: 0,
	cacheWriteTokens: undefined,
	reasoningTokens: 0,
});

const extractionRun = (
	startedAt: number,
	extractorModel: string,
	auditorModel: string,
	stats?: ExtractionRunUsage["stats"],
): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 10_000,
	stages: {
		extractor: { model: extractorModel, steps: [step(1000, 200)] },
		auditor: { model: auditorModel, steps: [step(2000, 100)] },
	},
	...(stats ? { stats } : {}),
});

describe("graphCostSummary (the cost pill's fold)", () => {
	test("folds both channels: stage totals, tokens, newest-first runs", () => {
		// (The cluster-naming channel died with the extraction-UX close-out,
		// 2026-09-24 — two channels: chat + notes front doors.)
		const input: CostSummaryInput = {
			chats: [{ title: "Testing session", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/modal.md", extractions: [extractionRun(200, PRICED, PRICED)] }],
		};
		const s = graphCostSummary(input);
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.stages.extraction.dollars, extStep * 2);
		assert.equal(s.stages.audit.dollars, audStep * 2);
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.extraction.tokens.inputTokens, 2000);
		assert.equal(s.stages.audit.tokens.outputTokens, 200);
		assert.equal(s.totalDollars, extStep * 2 + audStep * 2);
		// Both runs, newest first, titles joined per front door — every
		// run is kind "extraction" now.
		assert.deepEqual(
			s.runs.map((r) => r.title),
			["/vault/modal.md", "Testing session"],
		);
		assert.deepEqual(s.runs.map((r) => r.kind), ["extraction", "extraction"]);
		assert.equal(s.unpricedRuns, 0);
	});

	test("unpriced models: excluded dollars, counted honestly, run null only when BOTH stages unpriced", () => {
		const s: GraphCostSummary = graphCostSummary({
			chats: [{ title: "partial", extractions: [extractionRun(100, PRICED, "unknown-model")] }],
			sources: [{ filePath: "/vault/x.md", extractions: [extractionRun(200, "unknown-model", "unknown-model")] }],
		});
		assert.equal(s.stages.audit.unpricedRuns, 2);
		assert.equal(s.stages.audit.dollars, 0); // never a silent zero: unpricedRuns says it
		assert.equal(s.stages.extraction.unpricedRuns, 1);
		// The partial run still prices its extractor side; the fully
		// unpriced run renders "—". Newest first: 200 (both unpriced), 100.
		assert.equal(s.runs[0]!.dollars, null);
		assert.notEqual(s.runs[1]!.dollars, null);
		assert.equal(s.unpricedRuns, 1); // run-level: only the both-stages run
	});

	test("recent runs cap: newest survive", () => {
		const extractions = [1, 2, 3, 4].map((n) => extractionRun(n * 100, PRICED, PRICED));
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions }],
			sources: [],
			recentCap: 2,
		});
		assert.equal(s.runs.length, 2);
		assert.deepEqual(s.runs.map((r) => r.startedAt), [400, 300]);
		// stage totals still count EVERY run, cap is presentational.
		assert.equal(s.stages.extraction.runs, 4);
	});

	test("failed runs carry no merged stats; empty input folds to zero", () => {
		const s = graphCostSummary({
			chats: [{ title: "failed", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [],
		});
		assert.equal(s.runs[0]!.merged, undefined);
		const empty = graphCostSummary({ chats: [], sources: [] });
		assert.equal(empty.totalDollars, 0);
		assert.equal(empty.runs.length, 0);
		assert.equal(empty.stages.extraction.tokens.inputTokens, undefined);
	});
});

const PLACEHOLDER: ExtractionStageUsage = { model: "unknown", steps: [] };
const CLI = `${CLAUDE_CODE_MODELS[0]!.provider}:${CLAUDE_CODE_MODELS[0]!.id}`;
assert.equal(callCost(step(1, 1), CLI), null);

/** A standalone PDF transcription run: real transcription stage,
 *  step-less extractor/auditor placeholders. */
const transcriptionRun = (startedAt: number, model: string, steps = [step(5000, 800)]): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 1000,
	stages: { transcription: { model, steps }, extractor: PLACEHOLDER, auditor: PLACEHOLDER },
});

describe("graphCostSummary with PDF transcription", () => {
	test("old records without transcription keep the old summary shape", () => {
		const s = graphCostSummary({
			chats: [{ title: "old", extractions: [extractionRun(100, PRICED, "unknown-model"), { ...extractionRun(200, PRICED, PRICED), stages: { extractor: PLACEHOLDER, auditor: PLACEHOLDER } }] }],
			sources: [],
		});
		assert.deepEqual(Object.keys(s.stages), ["extraction", "audit"]);
		assert.ok(s.runs.every((r) => !("unpricedStages" in r)));
		// Legacy empty-steps placeholders still count as unpriced stage-runs.
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.audit.unpricedRuns, 2);
		assert.equal(s.unpricedRuns, 1);
	});

	test("priced standalone transcription: no phantom extractor or auditor runs", () => {
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(100, PRICED)] }] });
		const dollars = callCost(step(5000, 800), PRICED)!;
		assert.deepEqual(s.stages.transcription, { dollars, unpricedRuns: 0, runs: 1, tokens: { ...sumTokens(5000, 800) } });
		assert.equal(s.stages.extraction.runs, 0);
		assert.equal(s.stages.audit.runs, 0);
		assert.equal(s.stages.extraction.unpricedRuns + s.stages.audit.unpricedRuns, 0);
		assert.equal(s.totalDollars, dollars);
		assert.equal(s.unpricedRuns, 0);
		assert.equal(s.runs[0]!.dollars, dollars);
		assert.equal(s.runs[0]!.unpricedStages, 0);
		assert.equal(s.runs[0]!.tokens.inputTokens, 5000);
	});

	for (const [label, model] of [["unknown", "unknown-model"], ["CLI", CLI]] as const) {
		test(`${label} transcription model is one unpriced run, not three`, () => {
			const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(100, model)] }] });
			assert.equal(s.stages.transcription!.unpricedRuns, 1);
			assert.equal(s.stages.transcription!.tokens.inputTokens, 5000, "tokens still sum");
			assert.equal(s.stages.extraction.unpricedRuns + s.stages.audit.unpricedRuns, 0);
			assert.equal(s.unpricedRuns, 1);
			assert.equal(s.runs[0]!.dollars, null);
			assert.equal(s.runs[0]!.unpricedStages, 1);
			assert.equal(s.subscriptionRuns, undefined);
		});
	}

	test("subscription transcription alone is fully subscription, not unpriced", () => {
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(100, "chatgpt:gpt-5")] }] });
		assert.equal(s.stages.transcription!.subscriptionRuns, 1);
		assert.deepEqual(s.stages.transcription!.subscriptionProviders, ["ChatGPT"]);
		assert.equal(s.stages.transcription!.unpricedRuns, 0);
		assert.equal(s.unpricedRuns, 0);
		assert.equal(s.subscriptionRuns, 1);
		assert.equal(s.totalDollars, 0);
		assert.equal(s.runs[0]!.dollars, null);
		assert.equal(s.runs[0]!.subscriptionRuns, 1);
		assert.equal(s.runs[0]!.unpricedStages, 0);
	});

	test("subscription transcription plus unknown extractor counts the run unpriced once", () => {
		const run: ExtractionRunUsage = { ...transcriptionRun(100, "chatgpt:gpt-5"), stages: { transcription: { model: "chatgpt:gpt-5", steps: [step(5000, 800)] }, extractor: { model: "unknown-model", steps: [step(1000, 200)] }, auditor: PLACEHOLDER } };
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [run] }] });
		assert.equal(s.stages.extraction.unpricedRuns, 1);
		assert.equal(s.stages.audit.runs, 0, "the placeholder auditor is skipped");
		assert.equal(s.unpricedRuns, 1);
		assert.equal(s.runs[0]!.unpricedStages, 1);
	});

	test("transcription folded with full extraction: combined stage and overall totals", () => {
		const full: ExtractionRunUsage = { ...extractionRun(300, PRICED, PRICED), stages: { ...extractionRun(300, PRICED, PRICED).stages, transcription: { model: PRICED, steps: [step(5000, 800)] } } };
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(200, PRICED), full] }],
		});
		const tr = callCost(step(5000, 800), PRICED)!;
		const ext = callCost(step(1000, 200), PRICED)!;
		const aud = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.stages.transcription!.runs, 2);
		assert.equal(s.stages.transcription!.dollars, tr * 2);
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.audit.runs, 2);
		assert.equal(s.totalDollars, tr * 2 + ext * 2 + aud * 2);
		assert.deepEqual(s.runs.map((r) => r.dollars), [tr + ext + aud, tr, ext + aud]);
		assert.deepEqual(s.runs.map((r) => r.tokens.inputTokens), [8000, 5000, 3000]);
		assert.equal(s.runs[2]!.unpricedStages, undefined, "the old-style run keeps its old shape");
	});

	test("transcription cache writes keep the long-cache split rules", () => {
		const known = transcriptionRun(100, PRICED, [{ ...step(5000, 800), cacheWriteTokens: 3000, cacheWrite1hTokens: 1000 }]);
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [known, transcriptionRun(200, PRICED, [{ ...step(5000, 800), cacheWriteTokens: 2000, cacheWrite1hTokens: 500 }])] }] });
		assert.equal(s.stages.transcription!.tokens.cacheWriteTokens, 5000);
		assert.equal(s.stages.transcription!.tokens.cacheWrite1hTokens, 1500);
		const unknownSplit = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/scan.pdf", extractions: [known, transcriptionRun(200, PRICED, [{ ...step(5000, 800), cacheWriteTokens: 2000 }])] }] });
		assert.equal(unknownSplit.stages.transcription!.tokens.cacheWrite1hTokens, undefined);
	});
});

function sumTokens(input: number, output: number): CallUsage {
	return { cacheWrite1hTokens: undefined, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}
