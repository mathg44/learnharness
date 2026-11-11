/**
 * Update and rollback check (#30): scripts/check-server-updates.mjs. These
 * cases cover the refusals that happen before any container or volume
 * exists. Only the Docker executable is faked: a script on PATH that logs
 * its argv and answers `image inspect` from a per-test plan. The full
 * seed, snapshot, candidate and rollback flow runs only against real Docker.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const cli = path.resolve("scripts/check-server-updates.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-update-runner-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs");
// The runner gives Docker only daemon variables, so the plan sits next to bin/.
const planFile = require("node:path").join(__dirname, "..", "plan.json");
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(planFile + ".log", JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
	const answer = plan.images[args.at(-1)];
	if (!answer) { process.stderr.write("Error: No such image: synthetic-docker-detail\\n"); process.exit(1); }
	process.stdout.write(JSON.stringify([answer]));
	process.exit(0);
}
// Anything else is a container or volume query for a resource that does not exist.
process.stderr.write("Error: synthetic-docker-detail\\n");
process.exit(1);
`;

const idA = "sha256:" + "a".repeat(64);
const idB = "sha256:" + "b".repeat(64);
const image = (Id: string) => ({ Id, Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_ENV=production"] } });

/** The run's single evidence file. */
function evidenceFile(dir: string) {
	const files = fs.readdirSync(dir);
	assert.equal(files.length, 1);
	return path.join(dir, files[0] as string);
}

let caseNumber = 0;
/** `prepare` may create the evidence path first and return the path to pass instead. */
function run(args: string[], images: Record<string, unknown> = {}, prepare?: (evidence: string) => string) {
	const dir = path.join(root, `case-${caseNumber++}`);
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
	const plan = path.join(dir, "plan.json");
	fs.writeFileSync(plan, JSON.stringify({ images }));
	const evidence = path.join(dir, "evidence");
	const evidenceArg = prepare ? prepare(evidence) : evidence;
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LH_UPDATE_CHECK_EVIDENCE_DIR: evidenceArg },
	});
	const log = fs.existsSync(plan + ".log")
		? fs.readFileSync(plan + ".log", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
		: [];
	return { ...result, log, evidence };
}

it("refuses the wrong number of arguments or a flag before calling Docker", () => {
	for (const args of [[], ["lh-a:1"], ["lh-a:1", "lh-b:1", "lh-c:1"], ["--help", "lh-b:1"], ["lh-a:1", "-x"]]) {
		const result = run(args);
		assert.equal(result.status, 2, `args ${JSON.stringify(args)}`);
		assert.match(result.stderr, /Usage: node scripts\/check-server-updates\.mjs PREVIOUS_IMAGE CANDIDATE_IMAGE/);
		assert.deepEqual(result.log, []);
	}
});

it("refuses a production learnharness tag in either position before calling Docker", () => {
	const production = [
		"learnharness:server", "learnharness", "learnharness:server-20261111T000000Z-b5b154e",
		"docker.io/library/learnharness:server", "library/learnharness:egress", "docker.io/learnharness:demo",
		"registry.example:5000/learnharness:server", "learnharness@" + idA,
	];
	for (const tag of production) {
		for (const args of [[tag, "lh-update-check:candidate"], ["lh-update-check:previous", tag]]) {
			const result = run(args, { [tag]: image(idA) });
			assert.equal(result.status, 2, `args ${JSON.stringify(args)}`);
			assert.match(result.stderr, /Refusing a production learnharness image/);
			assert.deepEqual(result.log, []);
		}
	}
});

it("refuses an image that is not present locally without pulling, building or running anything", () => {
	for (const [args, images, which] of [
		[["lh-update-check:previous", "lh-update-check:candidate"], { "lh-update-check:candidate": image(idB) }, "PREVIOUS_IMAGE"],
		[["lh-update-check:previous", "lh-update-check:candidate"], { "lh-update-check:previous": image(idA) }, "CANDIDATE_IMAGE"],
	] as const) {
		const result = run([...args], images);
		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`${which} is not present locally`));
		assert.doesNotMatch(result.stderr + result.stdout, /synthetic-docker-detail/);
		assert.ok(result.log.length > 0 && result.log.every((call) => call[0] === "image" && call[1] === "inspect"), JSON.stringify(result.log));
		const file = evidenceFile(result.evidence);
		assert.equal(fs.statSync(result.evidence).mode & 0o777, 0o700);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(evidence.result, "fail");
		assert.doesNotMatch(JSON.stringify(evidence), /synthetic-docker-detail/);
	}
});

it("refuses two tags that resolve to the same image before creating anything", () => {
	const result = run(["lh-update-check:previous", "lh-update-check:candidate"], {
		"lh-update-check:previous": image(idA), "lh-update-check:candidate": image(idA),
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /PREVIOUS_IMAGE and CANDIDATE_IMAGE resolve to the same image/);
	assert.doesNotMatch(result.stderr + result.stdout, /synthetic-docker-detail|sha256:/);
	assert.ok(result.log.every((call) => call[0] === "image" && call[1] === "inspect"), JSON.stringify(result.log));
	const evidence = JSON.parse(fs.readFileSync(evidenceFile(result.evidence), "utf8"));
	assert.equal(evidence.result, "fail");
	assert.equal(evidence.candidate, "not-run");
	assert.equal(evidence.rollback, "not-run");
});

it("writes evidence only into a canonical directory of mode exactly 0700", () => {
	const images = { "lh-update-check:previous": image(idA), "lh-update-check:candidate": image(idA) };
	const args = ["lh-update-check:previous", "lh-update-check:candidate"];
	for (const [label, prepare] of [
		["sticky 1700", (evidence: string) => { fs.mkdirSync(evidence); fs.chmodSync(evidence, 0o1700); return evidence; }],
		["setgid 2700", (evidence: string) => { fs.mkdirSync(evidence); fs.chmodSync(evidence, 0o2700); return evidence; }],
		["symlinked root", (evidence: string) => {
			fs.mkdirSync(evidence, { mode: 0o700 });
			const link = evidence + "-link";
			fs.symlinkSync(evidence, link);
			return link;
		}],
		["symlinked ancestor", (evidence: string) => {
			const parent = evidence + "-parent";
			fs.mkdirSync(parent, { mode: 0o700 });
			fs.symlinkSync(parent, evidence);
			fs.mkdirSync(path.join(parent, "private"), { mode: 0o700 });
			return path.join(evidence, "private");
		}],
	] as const) {
		const result = run(args, images, prepare);
		assert.equal(result.status, 1, label);
		assert.match(result.stderr, /Evidence directory must be a real directory owned by this user with mode 0700/, label);
		const written = fs.readdirSync(path.dirname(result.evidence), { recursive: true }).map(String).filter((name) => name.endsWith(".json") && name !== "plan.json");
		assert.deepEqual(written, [], label);
	}
});
