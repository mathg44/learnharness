/**
 * The server trial profile (core/server-trial.ts, LH_SERVER_TRIAL=1):
 * proves the hard restrictions at every gated layer —
 *
 *   1. core/server-trial.ts — the pure policy functions
 *   2. serverExecute (agent/tool-execute.ts) — the low-level tool-execution
 *      boundary: read/ls/find/grep and the research/demo/visual/pdf job
 *      tools refuse explicitly, without running their body
 *   3. job dispatch (agent/tools/jobs.ts) — a blocked kind never creates a
 *      job record or spawns the runner
 *   4. the job runner (agent/subagents/runner.ts) — a job of a blocked kind
 *      (including one that looks "restored": created directly in the
 *      store, never dispatched this run) refuses before any model engine
 *      is ever picked
 *   5. the sub-agent worker entrypoints (researcher/demo-builder/
 *      visual-maker/pdf-reader) — refuse directly, so even a caller that
 *      bypasses the runner never touches the network, a headless browser,
 *      or the filesystem
 *   6. the tool registries (agent/tools.ts createProberTools/
 *      createTeacherTools, agent/tools/practice.ts practiceTools) — drop
 *      the blocked tools from what the model is even told exists, and
 *      prove user/session settings (EnabledTools) cannot bring them back
 *
 * Every describe block also proves the symmetric case: with
 * LH_SERVER_TRIAL unset, behavior is byte-identical to before this policy
 * existed (core prober/teacher/practice tool sets, question tools, plan
 * tools, and the fs/job tools all present and functional).
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
	filterServerTrialTools,
	isServerTrialEnabled,
	serverTrialJobBlockReason,
	serverTrialToolBlockReason,
} from "../src/core/server-trial.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { lsTool } from "../src/agent/tools/ls.ts";
import { findTool } from "../src/agent/tools/find.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { createShowImageTool } from "../src/agent/tools/show-image.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createWebTools } from "../src/agent/tools/web.ts";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { createJobRunner, demoModelOverride, pdfModelOverride, researchModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import type { JobRecord, PdfResult, DemoResult, VisualResult, ResearchResult } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

const BLOCKED_TOOLS = ["read", "ls", "find", "grep", "show_image", "research", "demo", "visual", "pdf"] as const;

/** Toggle the env flag for exactly the scope of one callback, always restoring. */
async function withTrial<T>(on: boolean, fn: () => Promise<T> | T): Promise<T> {
	const prior = process.env.LH_SERVER_TRIAL;
	if (on) process.env.LH_SERVER_TRIAL = "1";
	else delete process.env.LH_SERVER_TRIAL;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env.LH_SERVER_TRIAL;
		else process.env.LH_SERVER_TRIAL = prior;
	}
}

/** Drive one AgentTool's native execute and return its result verbatim. */
async function run(tool: AgentTool<any>, params: unknown) {
	return tool.execute!("call-1", params, undefined as never);
}

const createdChats: string[] = [];
const createdJobs: string[] = [];

afterEach(() => {
	for (const id of createdJobs) {
		try {
			const job = jobStore.getJob(id);
			if (job && job.status === "running") jobStore.updateJob(id, { status: "done", activity: "settled (fence)" });
		} catch {
			/* already gone */
		}
	}
	researchModelOverride.current = undefined;
	demoModelOverride.current = undefined;
	visualModelOverride.current = undefined;
	pdfModelOverride.current = undefined;
});

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(PATHS.data, "jobs", `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function trackChat(id: string): string {
	createdChats.push(id);
	return id;
}
function trackJob(id: string): string {
	createdJobs.push(id);
	return id;
}

// ─── 1. the pure policy module ───────────────────────────────────────────────

describe("core/server-trial.ts — pure policy", () => {
	it("isServerTrialEnabled reads LH_SERVER_TRIAL=1 exactly, nothing else", async () => {
		await withTrial(false, () => assert.equal(isServerTrialEnabled(), false));
		await withTrial(true, () => assert.equal(isServerTrialEnabled(), true));
		const prior = process.env.LH_SERVER_TRIAL;
		try {
			process.env.LH_SERVER_TRIAL = "true"; // not the literal "1" — stays off
			assert.equal(isServerTrialEnabled(), false);
		} finally {
			if (prior === undefined) delete process.env.LH_SERVER_TRIAL;
			else process.env.LH_SERVER_TRIAL = prior;
		}
	});

	it("serverTrialToolBlockReason / serverTrialJobBlockReason: null off, a reason on, only for the blocked names", async () => {
		await withTrial(false, () => {
			for (const name of BLOCKED_TOOLS) assert.equal(serverTrialToolBlockReason(name), null);
			assert.equal(serverTrialJobBlockReason("research"), null);
		});
		await withTrial(true, () => {
			for (const name of BLOCKED_TOOLS) {
				const reason = serverTrialToolBlockReason(name);
				assert.ok(reason && reason.includes("server trial"), `${name} should be blocked`);
			}
			assert.equal(serverTrialToolBlockReason("quiz"), null, "an unrelated tool is never touched");
			assert.equal(serverTrialToolBlockReason("plan_init"), null);
			for (const kind of ["research", "demo", "visual", "pdf"]) {
				assert.ok(serverTrialJobBlockReason(kind)?.includes("server trial"));
			}
		});
	});

	it("filterServerTrialTools: unconditional drop under trial, identity otherwise", async () => {
		const tools = { read: readTool, ls: lsTool, quiz: readTool /* stand-in */, probe_done: readTool };
		await withTrial(false, () => {
			assert.deepEqual(Object.keys(filterServerTrialTools(tools)).sort(), Object.keys(tools).sort());
		});
		await withTrial(true, () => {
			assert.deepEqual(Object.keys(filterServerTrialTools(tools)).sort(), ["probe_done", "quiz"]);
		});
	});
});

// ─── 2. serverExecute — the low-level tool-execution boundary ───────────────

describe("serverExecute gate: the learner-fs tools", () => {
	const SELF = path.join(import.meta.dirname, "server-trial-tools.test.ts");

	it("read/ls/find/grep refuse explicitly under the trial, without touching disk", async () => {
		await withTrial(true, async () => {
			for (const [tool, params] of [
				[readTool, { path: SELF }],
				[lsTool, { path: import.meta.dirname }],
				[findTool, { pattern: "*.ts", path: import.meta.dirname }],
				[grepTool, { pattern: "server trial", path: import.meta.dirname }],
			] as const) {
				const result = await run(tool, params);
				assert.equal(result.isError, true, `${tool.name} should refuse`);
				const text = (result.content[0] as { text: string }).text;
				assert.match(text, /server trial/);
				assert.equal((result.details as { tool: string }).tool, tool.name);
			}
		});
	});

	it("read/ls/find/grep work normally when the trial is off (unchanged)", async () => {
		await withTrial(false, async () => {
			const readResult = await run(readTool, { path: SELF });
			assert.notEqual(readResult.isError, true);
			assert.match((readResult.content[0] as { text: string }).text, /learner-fs tools/);

			const lsResult = await run(lsTool, { path: import.meta.dirname });
			assert.notEqual(lsResult.isError, true);
			assert.match((lsResult.content[0] as { text: string }).text, /server-trial-tools\.test\.ts/);
		});
	});
});

describe("serverExecute gate: the job-dispatch tools", () => {
	function spawnSpy() {
		const calls: JobRecord[] = [];
		return { calls, spawn: (job: JobRecord) => void calls.push(job) };
	}

	it("research/demo/visual/pdf refuse explicitly under the trial — no job created, nothing spawned", async () => {
		await withTrial(true, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: dispatch blocked").id);
			const { calls, spawn } = spawnSpy();
			const tools = jobTools({ chatId, jobStore, spawn });

			const cases: Array<[string, unknown]> = [
				["research", { question: "q" }],
				["demo", { title: "t", brief: "b" }],
				["visual", { brief: "b" }],
				["pdf", { path: "/tmp/does-not-matter.pdf", question: "q" }],
			];
			for (const [name, params] of cases) {
				const result = await run(tools[name]!, params);
				assert.equal(result.isError, true, `${name} should refuse`);
				assert.match((result.content[0] as { text: string }).text, /server trial/);
			}
			assert.equal(calls.length, 0, "nothing was ever spawned");
			assert.equal(jobStore.listJobs(chatId).length, 0, "no job record was created");
		});
	});

	it("research dispatch works normally when the trial is off (unchanged)", async () => {
		await withTrial(false, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: dispatch unblocked").id);
			const { calls, spawn } = spawnSpy();
			const tools = jobTools({ chatId, jobStore, spawn });

			const result = await run(tools.research!, { question: "q" });
			assert.notEqual(result.isError, true);
			assert.match((result.content[0] as { text: string }).text, /Dispatched/);
			assert.equal(calls.length, 1, "the runner was spawned");
			const created = jobStore.listJobs(chatId);
			assert.equal(created.length, 1);
			trackJob(created[0]!.id);
		});
	});
});

describe("direct web and PDF tool execution", () => {
	it("refuses before network or filesystem access, even outside a worker registry", async () => {
		await withTrial(true, async () => {
			const tools = { ...createWebTools(() => { throw new Error("search must not resolve"); }), ...createPdfReadTools("/does/not/exist") };
			for (const [name, params] of [
				["web_search", { query: "q" }],
				["web_fetch", { url: "https://example.invalid" }],
				["web_fetch_pdf", { url: "https://example.invalid/a.pdf" }],
				["pdf_info", { path: "a.pdf" }],
				["pdf_extract", { path: "a.pdf", pages: "all" }],
				["pdf_search", { path: "a.pdf", query: "q" }],
			] as const) {
				const result = await run(tools[name]!, params);
				assert.equal(result.isError, true);
				assert.match((result.content[0] as { text: string }).text, /server trial/);
			}
		});
	});
});

// ─── 3/4. the job runner — including "restored" jobs ────────────────────────

describe("the job runner: blocked kinds refuse before any engine is picked", () => {
	for (const kind of ["research", "demo", "visual", "pdf"] as const) {
		it(`a ${kind} job refuses under the trial even with NO test engine override (never reaches model selection)`, async () => {
			await withTrial(true, async () => {
				const chat = chatStore.createChat(`Trial test: runner blocked ${kind}`);
				trackChat(chat.id);
				const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `call-${kind}` });
				trackJob(job.id);

				const steers: unknown[] = [];
				const runner = createJobRunner({ chatStore, jobStore, deliver: async (s) => void steers.push(s), engineFor: () => { throw new Error("provider must not resolve"); } });
				// No *ModelOverride set for this kind — if the trial gate did not
				// fire first, pickEngine would come up empty and the job would
				// refuse with a DIFFERENT ("models not configured") message.
				await runner.runJob(job.id, kind === "pdf" ? { path: "/tmp/x.pdf", question: "q" } : ({ question: "q", title: "t", brief: "b" } as never));

				const done = jobStore.getJob(job.id)!;
				assert.equal(done.status, "error");
				assert.match(done.error ?? "", /server trial/, "the trial gate fired, not the missing-model refusal");
				assert.equal(steers.length, 1, "the teacher still learns the outcome via a steer");
			});
		});

		it(`a "restored" ${kind} job (created before the flag flipped, never dispatched this run) still refuses explicitly`, async () => {
			await withTrial(true, async () => {
				const chat = chatStore.createChat(`Trial test: restored ${kind}`);
				trackChat(chat.id);
				// No dispatch-time input and no transcript tool call — exactly the
				// shape of a job recovered from the store with nothing else to go
				// on (resolveInput falls through to undefined, same as a crash
				// recovery re-spawn of a job that predates this trial).
				const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `call-restored-${kind}` });
				trackJob(job.id);
				const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {} });

				await runner.runJob(job.id);

				const done = jobStore.getJob(job.id)!;
				assert.equal(done.status, "error");
				assert.match(done.error ?? "", /server trial/);
			});
		});
	}

	it("non-trial: a research job runs to completion as before (unchanged)", async () => {
		await withTrial(false, async () => {
			const chat = chatStore.createChat("Trial test: runner non-trial research");
			trackChat(chat.id);
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-non-trial" });
			trackJob(job.id);

			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage([fauxText("## Summary\nfine\n\n## Findings\n\n## Sources\n")])]);
			researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple } satisfies PiEngine;

			const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {}, searchProvider: () => null });
			await runner.runJob(job.id, { question: "q" });

			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done");
			assert.doesNotMatch(done.error ?? "", /server trial/);
			assert.match((done.result as ResearchResult).brief, /fine/);
		});
	});
});

// ─── 5. direct worker entrypoints ────────────────────────────────────────────

describe("sub-agent worker entrypoints refuse directly under the trial", () => {
	it("runResearcherAgent throws before touching web_search/web_fetch", async () => {
		await withTrial(true, async () => {
			await assert.rejects(() => runResearcherAgent("anything"), /server trial/);
		});
	});

	it("runDemoBuilder returns the FAILED shape before the headless browser starts", async () => {
		await withTrial(true, async () => {
			const result: DemoResult = await runDemoBuilder({ title: "t", brief: "b" });
			assert.equal(result.html, "");
			assert.equal(result.tested, true);
			assert.match(result.notes ?? "", /server trial/);
		});
	});

	it("runVisualMaker returns the FAILED shape before any render happens", async () => {
		await withTrial(true, async () => {
			const result: VisualResult = await runVisualMaker({ brief: "b" });
			assert.equal(result.svg, "");
			assert.match(result.notes ?? "", /server trial/);
		});
	});

	it("runPdfReaderAgent refuses before even stat-ing the path (local or a web-fetched temp file alike)", async () => {
		await withTrial(true, async () => {
			const result: PdfResult = await runPdfReaderAgent({ path: "/definitely/does/not/exist.pdf", question: "q?" });
			assert.match(result.brief, /^PDF failed:/);
			assert.match(result.brief, /server trial/);
			assert.deepEqual(result.pagesRead, []);
			assert.deepEqual(result.pagesConsulted, []);
		});
	});
});

// ─── 6. the tool registries: prompt declarations + the settings floor ──────

describe("tool registries drop the blocked tools, and settings cannot bring them back", () => {
	function teacherCtx(chatId: string) {
		return { chatId, chatStore, jobStore, spawn: () => {} };
	}
	function proberCtx(chatId: string) {
		return { chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} };
	}

	it("createTeacherTools: under the trial, the fs + job-dispatch tools are gone; the core set remains", async () => {
		await withTrial(true, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: teacher registry trial").id);
			// enabled=undefined means "everything the user can toggle stays
			// enabled" — the point is that EVEN SO, the trial floor holds.
			const keys = Object.keys(createTeacherTools(teacherCtx(chatId), undefined));
			for (const b of BLOCKED_TOOLS) assert.ok(!keys.includes(b), `${b} must be absent`);
			for (const must of ["quiz", "ask_user_question", "plan_init"]) assert.ok(keys.includes(must), `${must} must remain`);
		});
	});

	it("show_image is unavailable in trial lessons and refuses direct execution", async () => {
		await withTrial(true, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: learner image blocked").id);
			const directTool = createShowImageTool({ chatId, chatStore });
			const result = await run(directTool, { path: "/definitely/does/not/exist.png" });
			assert.equal(result.isError, true);
			assert.match((result.content[0] as { text: string }).text, /server trial/);
			assert.equal((result.details as { tool: string }).tool, "show_image");
			assert.equal(chatStore.getChat(chatId)!.imageSnapshots, undefined);
			assert.ok(!("show_image" in createTeacherTools(teacherCtx(chatId), undefined)));
		});
	});

	it("createTeacherTools: non-trial keeps the full set (unchanged)", async () => {
		await withTrial(false, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: teacher registry non-trial").id);
			const keys = Object.keys(createTeacherTools(teacherCtx(chatId), undefined));
			for (const must of [...BLOCKED_TOOLS, "quiz", "ask_user_question", "plan_init"]) {
				assert.ok(keys.includes(must), `${must} should be present outside the trial`);
			}
		});
	});

	it("createProberTools: under the trial, the fs + research/pdf tools are gone; probe_done always survives", async () => {
		await withTrial(true, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: prober registry trial").id);
			const keys = Object.keys(createProberTools(proberCtx(chatId), undefined));
			for (const b of ["read", "ls", "find", "grep", "research", "pdf"]) assert.ok(!keys.includes(b));
			for (const must of ["probe", "ask_user_question", "probe_done"]) assert.ok(keys.includes(must));
		});
	});

	it("createProberTools: non-trial keeps the full set (unchanged)", async () => {
		await withTrial(false, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: prober registry non-trial").id);
			const keys = Object.keys(createProberTools(proberCtx(chatId), undefined));
			for (const must of ["read", "ls", "find", "grep", "research", "pdf", "probe", "ask_user_question", "probe_done"]) {
				assert.ok(keys.includes(must), `${must} should be present outside the trial`);
			}
		});
	});

	it("practiceTools: under the trial, the fs + research/pdf tools are gone; problem/conclude remain", async () => {
		await withTrial(true, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: practice registry trial", "practice").id);
			const keys = Object.keys(
				practiceTools({ chatId, chatStore, jobs: { chatId, jobStore, spawn: () => {} } }),
			);
			for (const b of ["read", "ls", "find", "grep", "research", "pdf"]) assert.ok(!keys.includes(b));
			for (const must of ["problem", "conclude"]) assert.ok(keys.includes(must));
		});
	});

	it("practiceTools: non-trial keeps the full set (unchanged)", async () => {
		await withTrial(false, async () => {
			const chatId = trackChat(chatStore.createChat("Trial test: practice registry non-trial", "practice").id);
			const keys = Object.keys(
				practiceTools({ chatId, chatStore, jobs: { chatId, jobStore, spawn: () => {} } }),
			);
			for (const must of ["read", "ls", "find", "grep", "research", "pdf", "problem", "conclude"]) {
				assert.ok(keys.includes(must), `${must} should be present outside the trial`);
			}
		});
	});
});
