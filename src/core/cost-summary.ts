/**
 * Graph-pipeline cost summary (2026-09 graph cost metrics wave) — the pure
 * fold behind the graph view's cost pill. Two usage channels in: chat
 * extraction runs (ChatRecord.extractions) and notes-source runs
 * (NotesSource.extractions). Out: per-stage totals (PDF transcription when
 * recorded, extraction, audit)
 * + a capped recent-runs list. (The cluster-naming channel died with the
 * extraction-UX close-out, 2026-09-24 — UI's displayCostTotals had already
 * dropped it; historical naming-runs.jsonl spend is simply not displayed,
 * the same ruling as wave 7's stages.embedding.)
 *
 * MONEY CHANNEL LAW: dollars are INFERRED here at read time via
 * an injected server-side Pi pricer — never stored anywhere. An unpriced model contributes
 * ZERO dollars but is counted in `unpricedRuns` so the UI can render
 * "— unpriced" honestly, never a silent zero. Tokens always sum.
 *
 * Client-safe: pure types + math, no node imports; exposed via the core
 * barrel so the pill/panel components carry no cost math.
 */

import type { CallUsage, EmissionStats, ExtractionRunUsage, ExtractionStageUsage } from "./contracts.ts";
import { sumSteps, isSubscriptionModel, subscriptionLabels, type CallPricer } from "./prices.ts";

/** One pipeline stage's cumulative cost across every run. */
export interface StageCost {
	/** Subscription stage-runs, excluded from API dollars and unpriced counts. */
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD summed over PRICED runs (partial when unpricedRuns > 0). */
	dollars: number;
	/** Stage-runs whose model is missing from Pi's catalog (render "—", never zero). */
	unpricedRuns: number;
	/** Runs that billed this stage. */
	runs: number;
	/** Token totals across every run. */
	tokens: CallUsage;
}

/** One run in the recent-runs list (extraction or naming). */
export interface RecentRun {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	startedAt: number;
	/** ISO wall-clock. */
	at: string;
	durationMs: number;
	/** "extraction" covers both front doors (chat + notes). */
	kind: "extraction";
	/** Chat title / source file path / fixed label for naming runs. */
	title: string;
	/** Non-subscription stages with no price. Present (zero included) on
	 *  every run that recorded transcription and absent otherwise; for older
	 *  runs the UI derives it from subscriptionRuns (one subscription stage
	 *  plus one unknown stage). */
	unpricedStages?: number;
	/** Whole-run inferred USD; null only when EVERY stage is unpriced. */
	dollars: number | null;
	tokens: CallUsage;
	/** What the run merged into the graph; absent on failed runs. */
	merged?: EmissionStats;
}

/** The cost pill's whole payload: stage totals + recent runs. */
export interface GraphCostSummary {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD across all priced stages of all runs. */
	totalDollars: number;
	/** Runs with no priced API stage and at least one unknown stage. */
	unpricedRuns: number;
	/** The billable pipeline stages. (Wave 7, owner ruling 2026-09-23:
	 *  the embedding stage is gone with the provider embedder; the
	 *  2026-09-24 close-out culled cluster naming the same way —
	 *  historical spend on either is simply not displayed.) */
	stages: {
		/** PDF transcription. Present only when some run recorded it, so
		 *  summaries without transcription keep their old shape. */
		transcription?: StageCost;
		extraction: StageCost;
		audit: StageCost;
	};
	/** Newest first, capped at `recentCap` (default 10). */
	runs: RecentRun[];
}

/** What the fold reads: already-collected run records, front-door-tagged. */
export interface CostSummaryInput {
	/** Chat-front-door runs: chat title + the record's usage log. */
	chats: { title: string; extractions: ExtractionRunUsage[] }[];
	/** Notes-front-door runs: imported file path + the source's usage log. */
	sources: { filePath: string; extractions: ExtractionRunUsage[] }[];
	recentCap?: number;
}

const ZERO_TOKENS: CallUsage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cacheReadTokens: undefined,
	cacheWriteTokens: undefined,
	reasoningTokens: undefined,
};

const emptyStage = (): StageCost => ({ dollars: 0, unpricedRuns: 0, runs: 0, tokens: { ...ZERO_TOKENS } });

/** One stage's dollars over its steps; null when the model is unpriced
 *  (all-or-nothing: a stage runs one model). */
function stageDollars(model: string, steps: readonly CallUsage[], price: CallPricer): number | null {
	if (isSubscriptionModel(model) || steps.length === 0) return null;
	let total = 0;
	for (const step of steps) {
		const c = price(step, model);
		if (c === null) return null;
		total += c;
	}
	return total;
}

/** Merge one step-set's tokens into an accumulating CallUsage. */
function mergeTokens(into: CallUsage, steps: readonly CallUsage[]): void {
	const summed = sumSteps(steps);
	// Fold this before updating total writes, so an older write-bearing
	// aggregate with a missing split remains unknown even after fresh data.
	into.cacheWrite1hTokens = sumSteps([into, summed]).cacheWrite1hTokens;
	into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
	into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
	into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
	into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
	into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}

/** Fold one stage-run into its accumulator; returns the stage's dollars
 *  (null when subscription or unpriced). */
function foldStage(into: StageCost, stage: ExtractionStageUsage, price: CallPricer): number | null {
	into.runs++;
	mergeTokens(into.tokens, stage.steps);
	const dollars = stageDollars(stage.model, stage.steps, price);
	if (isSubscriptionModel(stage.model)) {
		into.subscriptionRuns = (into.subscriptionRuns ?? 0) + 1;
		into.subscriptionProviders = [...new Set([...(into.subscriptionProviders ?? []), ...subscriptionLabels([stage.model])])];
	}
	else if (dollars === null) into.unpricedRuns++;
	else into.dollars += dollars;
	return dollars;
}

/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export function graphCostSummary(input: CostSummaryInput, price: CallPricer): GraphCostSummary {
	const transcription = emptyStage();
	const extraction = emptyStage();
	const audit = emptyStage();
	let sawTranscription = false;
	const runs: (RecentRun & { unpriced: boolean })[] = [];

	const foldExtractionRun = (run: ExtractionRunUsage, title: string) => {
		const stages = run.stages ?? { extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } };
		// Which stages this run billed. Legacy runs (no transcription) always
		// count both stages, empty steps included. A run that recorded
		// transcription writes step-less placeholders for the stages it
		// never ran; counting those would invent unpriced extractor/auditor runs.
		const counted: [StageCost, ExtractionStageUsage][] = [];
		if (stages.transcription) {
			sawTranscription = true;
			counted.push([transcription, stages.transcription]);
		}
		for (const pair of [[extraction, stages.extractor], [audit, stages.auditor]] as [StageCost, ExtractionStageUsage][]) {
			if (!stages.transcription || pair[1].steps.length > 0) counted.push(pair);
		}

		// Per-stage: tokens always count; dollars only when priced.
		const dollars = counted.map(([acc, stage]) => foldStage(acc, stage, price));
		const models = counted.map(([, stage]) => stage.model);
		const subscriptionRuns = models.filter(isSubscriptionModel).length;
		const unpricedStages = dollars.filter((d, i) => d === null && !isSubscriptionModel(models[i])).length;

		// Run-level: null only when EVERY stage is unpriced.
		const runDollars = dollars.every((d) => d === null)
			? null
			: dollars.reduce<number>((a, d) => a + (d ?? 0), 0);
		runs.push({
			...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: subscriptionLabels(models) } : {}),
			...(stages.transcription ? { unpricedStages } : {}),
			startedAt: run.startedAt,
			at: run.at,
			durationMs: run.durationMs,
			kind: "extraction",
			title,
			dollars: runDollars,
			tokens: sumSteps(counted.flatMap(([, stage]) => stage.steps)),
			...(run.stats ? { merged: run.stats } : {}),
			// A run is "unpriced" when it billed nothing countable at all:
			// no priced stage and at least one stage that is not subscription.
			unpriced: runDollars === null && unpricedStages > 0,
		});
	};

	for (const chat of input.chats) {
		for (const run of chat.extractions) foldExtractionRun(run, chat.title);
	}
	for (const source of input.sources) {
		for (const run of source.extractions) foldExtractionRun(run, source.filePath);
	}

	runs.sort((a, b) => b.startedAt - a.startedAt);
	const capped = runs.slice(0, input.recentCap ?? 10).map(({ unpriced: _, ...run }) => run);

	const unpricedRuns = runs.filter((r) => r.unpriced).length;
	const stageList = sawTranscription ? [transcription, extraction, audit] : [extraction, audit];
	const subscriptionRuns = stageList.reduce((n, stage) => n + (stage.subscriptionRuns ?? 0), 0);
	return {
		...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: [...new Set(stageList.flatMap((stage) => stage.subscriptionProviders ?? []))] } : {}),
		totalDollars: stageList.reduce((n, stage) => n + stage.dollars, 0),
		unpricedRuns,
		stages: { ...(sawTranscription ? { transcription } : {}), extraction, audit },
		runs: capped,
	};
}
