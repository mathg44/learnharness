/**
 * Host backup command (#29): scripts/server-backup.mjs and the retention and
 * verification functions in scripts/backup/operator.mjs. Real disposable
 * directories throughout. Only the Docker executable is faked: a script on
 * PATH that logs its argv and answers from a per-test JSON plan.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto, { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { backupStatus, createSnapshot, helperArgs } from "../scripts/backup/operator.mjs";

const cli = path.resolve("scripts/server-backup.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_PLAN, "utf8"));
const args = process.argv.slice(2);
const stdin = args[0] === "run" || args[0] === "exec" && args.includes("-i") ? fs.readFileSync(0) : Buffer.alloc(0);
fs.appendFileSync(process.env.FAKE_DOCKER_PLAN + ".log", JSON.stringify({ args, stdin: stdin.toString("base64") }) + "\\n");
const key = args[0] === "container" || args[0] === "image" || args[0] === "volume" ? args[0] + " " + args[1] : args[0];
const answer = plan[key] ?? { status: 0 };
if (answer.stderr) process.stderr.write(answer.stderr);
// Later calls then fail to start at all, as if the docker binary went away.
if (answer.vanish) fs.unlinkSync(process.argv[1]);
if (answer.signal) process.kill(process.pid, answer.signal);
// Exit only once stdout has drained, or large answers arrive cut short.
const out = answer.json === undefined ? Buffer.from(answer.stdout ?? "", "base64") : JSON.stringify(answer.json);
process.stdout.write(out, () => process.exit(answer.status ?? 0));
`;

type Answer = { stdout?: string; json?: unknown; stderr?: string; status?: number; vanish?: boolean; signal?: string };
type Plan = Record<string, Answer>;

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const imageId = "sha256:" + "a".repeat(64);
const profileBytes = Buffer.from("synthetic gzip profile bytes");

const appEnv = ["LH_SERVER_ORIGIN=https://synthetic.example", "NODE_ENV=production", "LH_DATA_DIR=/data", "LH_AUTH_FILE=/auth/auth.json"];
const appMounts = [
	{ Type: "volume", Name: "synthetic_app-data", Source: "/srv/docker-root/volumes/synthetic_app-data/_data", Destination: "/data", RW: true },
	{ Type: "volume", Name: "synthetic_app-auth", Source: "/srv/docker-root/volumes/synthetic_app-auth/_data", Destination: "/auth", RW: true },
	// "@POLICY@" becomes each case's own policy file when the plan is written.
	{ Type: "bind", Source: "@POLICY@", Destination: "/etc/learnharness/egress.json", RW: false },
];
const inspectWith = (change: { env?: string[]; mounts?: unknown[] }) => ({
	"container inspect": { json: [{ Id: "c0ffee", Image: imageId, Config: { Env: change.env ?? appEnv }, Mounts: change.mounts ?? appMounts }] },
});

function healthyPlan(): Plan {
	return {
		ps: { stdout: b64("c0ffee\n") },
		...inspectWith({}),
		exec: { stdout: b64(profileBytes) },
		run: { status: 0 },
		"image inspect": { stdout: b64(imageId + "\n") },
		"volume inspect": { status: 1, stderr: "no such volume" },
	};
}

let caseNumber = 0;
function setup(plan: Plan = healthyPlan()) {
	const dir = path.join(root, `case-${caseNumber++}`);
	const bin = path.join(dir, "bin");
	const backups = path.join(dir, "backups");
	const priv = path.join(dir, "private");
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(backups, { mode: 0o700 });
	fs.mkdirSync(priv, { mode: 0o700 });
	fs.writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
	const planFile = path.join(dir, "plan.json");
	const writePlan = (next: Plan) => fs.writeFileSync(planFile, JSON.stringify(next).replaceAll("@POLICY@", policy));
	const policy = path.join(priv, "egress.json");
	fs.writeFileSync(policy, '{"synthetic":true}\n', { mode: 0o600 });
	writePlan(plan);
	const envFile = path.join(priv, "server.env");
	fs.writeFileSync(envFile, `LH_SERVER_ORIGIN=https://synthetic.example\nLH_EGRESS_POLICY_FILE=${policy}\n`, { mode: 0o600 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_PLAN: planFile };
	const run = (...args: string[]) => {
		const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	const calls = () => fs.existsSync(planFile + ".log")
		? fs.readFileSync(planFile + ".log", "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; stdin: string })
		: [];
	return { dir, backups, envFile, policy, run, calls, planFile, env, writePlan };
}

it("create publishes a snapshot that verify accepts", () => {
	const t = setup();
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.equal(created.status, 0, created.stderr);
	const result = JSON.parse(created.stdout) as { snapshot: string; kind: string; createdAt: string };
	assert.deepEqual(Object.keys(result), ["snapshot", "kind", "createdAt"]);
	assert.equal(result.kind, "daily");
	assert.equal(path.dirname(result.snapshot), t.backups);
	assert.match(path.basename(result.snapshot), /^daily-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
	assert.deepEqual(fs.readdirSync(t.backups), [path.basename(result.snapshot)]);
	assert.deepEqual(fs.readFileSync(path.join(result.snapshot, "profile.tar.gz")), profileBytes);
	const verified = t.run("verify", result.snapshot);
	assert.equal(verified.status, 0, verified.stderr);
	assert.deepEqual(JSON.parse(verified.stdout), result);
});

it("captures through the app's export CLI and checks the profile in the recorded image with no network or mounts", () => {
	const t = setup();
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups, "--project", "lh-synthetic");
	assert.equal(created.status, 0, created.stderr);
	const calls = t.calls();
	const ps = calls.find((call) => call.args[0] === "ps")!;
	assert.ok(ps.args.includes("label=com.docker.compose.project=lh-synthetic"));
	assert.ok(ps.args.includes("label=com.docker.compose.service=app"));
	assert.deepEqual(calls.find((call) => call.args[0] === "exec")!.args, ["exec", "c0ffee", "node", "/usr/local/lib/learnharness/backup/export.mjs"]);
	const helper = calls.find((call) => call.args[0] === "run")!;
	assert.deepEqual(Buffer.from(helper.stdin, "base64"), profileBytes);
	const flags = helper.args.slice(0, helper.args.indexOf(imageId));
	for (const expected of [["--network", "none"], ["--read-only"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--user", "1000:1000"], ["--pull", "never"], ["--entrypoint", "node"]]) {
		const at = flags.indexOf(expected[0]!);
		assert.ok(at >= 0, expected[0]);
		assert.deepEqual(flags.slice(at, at + expected.length), expected);
	}
	assert.ok(!flags.some((flag) => /^(--mount|-v|--volume|-p|--publish|--privileged)$/.test(flag)));
	assert.ok(!calls.some((call) => call.args[0] === "pull"));
});

it("records the image, runtime env and config the app ran with", () => {
	const t = setup();
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups, "--kind", "pre-update");
	assert.equal(created.status, 0, created.stderr);
	const { snapshot } = JSON.parse(created.stdout) as { snapshot: string };
	assert.match(path.basename(snapshot), /^pre-update-/);
	const runtime = JSON.parse(fs.readFileSync(path.join(snapshot, "runtime.json"), "utf8"));
	assert.equal(runtime.imageId, imageId);
	assert.deepEqual(runtime.env, appEnv);
	assert.equal(fs.readFileSync(path.join(snapshot, "config/server.env"), "utf8"), fs.readFileSync(t.envFile, "utf8"));
	assert.equal(fs.readFileSync(path.join(snapshot, "config/egress.json"), "utf8"), '{"synthetic":true}\n');
	assert.equal(fs.readFileSync(path.join(snapshot, "config/compose.yaml"), "utf8"), fs.readFileSync("compose.yaml", "utf8"));
	assert.equal(fs.readFileSync(path.join(snapshot, "config/compose.server.yaml"), "utf8"), fs.readFileSync("compose.server.yaml", "utf8"));
	const meta = JSON.parse(fs.readFileSync(path.join(snapshot, "snapshot.json"), "utf8"));
	assert.equal(meta.kind, "pre-update");
	assert.equal(Date.parse(meta.protectedUntil) - Date.parse(meta.createdAt), 14 * 24 * 60 * 60 * 1000);
	assert.deepEqual(JSON.parse(t.run("verify", snapshot).stdout), { snapshot, kind: "pre-update", createdAt: meta.createdAt });
	for (const entry of [snapshot, path.join(snapshot, "config")]) assert.equal(fs.statSync(entry).mode & 0o777, 0o700);
	for (const file of ["runtime.json", "profile.tar.gz", "config/server.env"]) assert.equal(fs.statSync(path.join(snapshot, file)).mode & 0o777, 0o600);
});

it("prints no profile bytes, env values or Docker output", () => {
	const plan = healthyPlan();
	plan.exec = { stdout: b64(profileBytes), stderr: "synthetic-docker-stderr" };
	const t = setup(plan);
	const ok = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	const failing = setup({ ...healthyPlan(), exec: { stdout: b64("partial"), stderr: "synthetic-docker-stderr", status: 1 } });
	const bad = failing.run("create", "--env-file", failing.envFile, "--directory", failing.backups);
	for (const output of [ok.stdout, ok.stderr, bad.stdout, bad.stderr]) {
		for (const secret of ["synthetic.example", "synthetic gzip", "synthetic-docker-stderr", "NODE_ENV", "partial"]) assert.ok(!output.includes(secret), secret);
	}
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /^server-backup: CAPTURE_FAILED: /);
});

for (const [label, change, code] of [
	["the export fails", { exec: { stdout: b64("half"), status: 1 } }, "CAPTURE_FAILED"],
	["the export is empty", { exec: { stdout: "" } }, "CAPTURE_FAILED"],
	["the image rejects the profile", { run: { status: 3 } }, "PROFILE_INVALID"],
	["no app is running", { ps: { stdout: "" } }, "APP_NOT_RUNNING"],
	["two apps match", { ps: { stdout: b64("aa\nbb\n") } }, "APP_NOT_RUNNING"],
	["the data directory is not the /data mount", inspectWith({ env: appEnv.map((e) => e.replace("LH_DATA_DIR=/data", "LH_DATA_DIR=/data/profile")) }), "APP_LAYOUT_UNSUPPORTED"],
	["the auth file is outside the /auth mount", inspectWith({ env: appEnv.map((e) => e.replace("/auth/auth.json", "/data/auth.json")) }), "APP_LAYOUT_UNSUPPORTED"],
	["the env names no data directory", inspectWith({ env: appEnv.filter((e) => !e.startsWith("LH_DATA_DIR=")) }), "APP_LAYOUT_UNSUPPORTED"],
	["/auth is not a mount", inspectWith({ mounts: appMounts.slice(0, 1) }), "APP_LAYOUT_UNSUPPORTED"],
	["inspect returns no image ID", { "container inspect": { stdout: b64('[{"Image":"learnharness:server","Config":{"Env":[]}}]') } }, "DOCKER_FAILED"],
] as const) {
	it(`publishes nothing and leaves no partial folder when ${label}`, () => {
		const t = setup({ ...healthyPlan(), ...change });
		const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`^server-backup: ${code}: `));
		assert.deepEqual(fs.readdirSync(t.backups), []);
	});
}

it("refuses a policy path missing from the env file", () => {
	const t = setup();
	fs.writeFileSync(t.envFile, "LH_SERVER_ORIGIN=https://synthetic.example\n");
	const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.match(result.stderr, /^server-backup: POLICY_FILE_INVALID: /);
	assert.deepEqual(t.calls(), []);
	assert.deepEqual(fs.readdirSync(t.backups), []);
});

it("refuses backup roots that are shared, symlinked, missing, relative or inside the checkout", () => {
	const t = setup();
	const shared = path.join(t.dir, "shared");
	fs.mkdirSync(shared, { mode: 0o755 });
	fs.chmodSync(shared, 0o755);
	const link = path.join(t.dir, "link");
	fs.symlinkSync(t.backups, link);
	const below = path.join(link, "nested");
	fs.mkdirSync(below, { mode: 0o700 });
	// A private folder inside the checkout would land in the build context.
	const inCheckout = fs.mkdtempSync(path.resolve(".lh-backup-test-"));
	try {
		for (const directory of [shared, link, below, path.join(t.dir, "missing"), "relative/backups", inCheckout]) {
			const result = t.run("create", "--env-file", t.envFile, "--directory", directory);
			assert.equal(result.status, 1, directory);
			assert.match(result.stderr, /^server-backup: BACKUP_ROOT_INVALID: /, directory);
		}
		assert.deepEqual(fs.readdirSync(inCheckout), []);
	} finally {
		fs.rmSync(inCheckout, { recursive: true, force: true });
	}
	assert.deepEqual(t.calls(), []);
});

it("refuses to run while another command holds the backup root", () => {
	const t = setup();
	fs.writeFileSync(path.join(t.backups, ".lock"), "12345\n");
	const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.match(result.stderr, /^server-backup: BACKUP_LOCKED: /);
	assert.deepEqual(fs.readdirSync(t.backups), [".lock"]);
	assert.deepEqual(t.calls(), []);
});

it("verify refuses altered, missing, extra, linked and partial snapshots", () => {
	const t = setup();
	const created = () => (JSON.parse(t.run("create", "--env-file", t.envFile, "--directory", t.backups).stdout) as { snapshot: string }).snapshot;
	const damage: Array<(snapshot: string) => string> = [
		(s) => (fs.appendFileSync(path.join(s, "profile.tar.gz"), "x"), s),
		(s) => (fs.rmSync(path.join(s, "config/egress.json")), s),
		(s) => (fs.writeFileSync(path.join(s, "config/extra"), ""), s),
		(s) => (fs.rmSync(path.join(s, "runtime.json")), fs.symlinkSync(t.envFile, path.join(s, "runtime.json")), s),
		(s) => (fs.writeFileSync(path.join(s, "snapshot.json"), "{"), s),
		(s) => {
			const partial = path.join(t.backups, `.partial-${path.basename(s)}`);
			fs.renameSync(s, partial);
			return partial;
		},
		(s) => {
			const renamed = s.replace(/-[0-9a-f]{8}$/, "-00000000").replace("daily-", "pre-update-");
			fs.renameSync(s, renamed);
			return renamed;
		},
		(s) => path.join(t.backups, "daily-20260101T000000Z-00000000") + s.slice(s.length),
	];
	for (const [index, harm] of damage.entries()) {
		const result = t.run("verify", harm(created()));
		assert.equal(result.status, 1, `damage ${index}`);
		assert.match(result.stderr, /^server-backup: SNAPSHOT_INVALID: /, `damage ${index}`);
	}
});

const DAY = 24 * 60 * 60 * 1000;
const T = Date.parse("2026-11-10T03:00:00.000Z");

/** Creates snapshots through the exported function at chosen times, with the same fake Docker. */
function at(t: ReturnType<typeof setup>) {
	process.env.FAKE_DOCKER_PLAN = t.planFile;
	const docker = path.join(t.dir, "bin", "docker");
	return async (time: number, kind: "daily" | "pre-update" = "daily") =>
		createSnapshot({ envFile: t.envFile, directory: t.backups, kind, now: () => new Date(time), docker });
}

it("after a successful snapshot, deletes daily and pre-update snapshots 14 days old or more and nothing else", async () => {
	const t = setup();
	const create = at(t);
	const old = await create(T - 15 * DAY);
	const edge = await create(T - 14 * DAY);
	const young = await create(T - 14 * DAY + 60_000);
	const oldUpdate = await create(T - 14 * DAY, "pre-update");
	const youngUpdate = await create(T - 13 * DAY, "pre-update");
	fs.mkdirSync(path.join(t.backups, "owner-notes"));
	fs.mkdirSync(path.join(t.backups, ".partial-leftover"));
	const latest = await create(T);
	assert.deepEqual(latest.retention.deleted.sort(), [old, edge, oldUpdate].map((s) => path.basename(s.snapshot)).sort());
	assert.deepEqual(latest.retention.invalid, []);
	assert.deepEqual(fs.readdirSync(t.backups).sort(), [
		".partial-leftover", "owner-notes", ...[young, youngUpdate, latest].map((s) => path.basename(s.snapshot)),
	].sort());
});

it("keeps many snapshots a day; retention is by age, not count", async () => {
	const t = setup();
	const create = at(t);
	for (let i = 0; i < 6; i++) await create(T - i * 60_000);
	assert.equal(fs.readdirSync(t.backups).length, 6);
});

it("leaves an old snapshot that fails verification and reports it after publishing the new one", async () => {
	const t = setup();
	const create = at(t);
	const old = await create(T - 20 * DAY);
	fs.appendFileSync(path.join(old.snapshot, "runtime.json"), " ");
	const latest = await create(T);
	assert.deepEqual(latest.retention, { deleted: [], invalid: [path.basename(old.snapshot)] });
	assert.ok(fs.existsSync(old.snapshot));
	const cli = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.equal(cli.status, 1);
	assert.match(cli.stderr, /^server-backup: RETENTION_BLOCKED: /);
	assert.equal(fs.readdirSync(t.backups).length, 3);
	assert.equal(t.run("verify", JSON.parse(cli.stdout).snapshot).status, 0);
});

it("status reports the newest valid daily snapshot and fails when there is none or it is over a day old", async () => {
	const t = setup();
	const create = at(t);
	const directory = t.backups;
	assert.deepEqual(await backupStatus({ directory, now: () => new Date(T) }), { snapshot: null, createdAt: null, ageHours: null, healthy: false, invalid: 0 });
	const daily = await create(T - 2 * DAY);
	const fresh = await create(T - 23 * 60 * 60 * 1000);
	await create(T - 60_000, "pre-update");
	assert.deepEqual(await backupStatus({ directory, now: () => new Date(T) }), {
		snapshot: fresh.snapshot, createdAt: fresh.createdAt, ageHours: 23, healthy: true, invalid: 0,
	});
	assert.deepEqual(await backupStatus({ directory, now: () => new Date(T + 2 * 60 * 60 * 1000) }), {
		snapshot: fresh.snapshot, createdAt: fresh.createdAt, ageHours: 25, healthy: false, invalid: 0,
	});
	// A newer daily that fails verification doesn't count as the latest, and makes the backups unhealthy.
	const damaged = await create(T - 30_000);
	fs.rmSync(path.join(damaged.snapshot, "profile.tar.gz"));
	assert.deepEqual(await backupStatus({ directory, now: () => new Date(T) }), {
		snapshot: fresh.snapshot, createdAt: fresh.createdAt, ageHours: 23, healthy: false, invalid: 1,
	});
	assert.ok(daily.snapshot);
});

it("status exits nonzero with a code when the newest daily backup is missing or stale", () => {
	const t = setup();
	const missing = t.run("status", "--directory", t.backups);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /^server-backup: BACKUP_MISSING: /);
	assert.equal(t.run("create", "--env-file", t.envFile, "--directory", t.backups, "--kind", "pre-update").status, 0);
	assert.equal(t.run("status", "--directory", t.backups).status, 1);
	assert.equal(t.run("create", "--env-file", t.envFile, "--directory", t.backups).status, 0);
	const ok = t.run("status", "--directory", t.backups);
	assert.equal(ok.status, 0, ok.stderr);
	assert.deepEqual(Object.keys(JSON.parse(ok.stdout)), ["snapshot", "createdAt", "ageHours", "healthy", "invalid"]);
	assert.equal(JSON.parse(ok.stdout).healthy, true);
	assert.deepEqual(JSON.parse(missing.stdout), { snapshot: null, createdAt: null, ageHours: null, healthy: false, invalid: 0 });
	fs.mkdirSync(path.join(t.backups, "daily-20260101T000000Z-00000000"), { mode: 0o700 });
	const invalid = t.run("status", "--directory", t.backups);
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /^server-backup: BACKUP_INVALID: /);
	assert.equal(JSON.parse(invalid.stdout).invalid, 1);
	assert.equal(JSON.parse(invalid.stdout).snapshot, JSON.parse(ok.stdout).snapshot);
});

function snapshotFor(t: ReturnType<typeof setup>): string {
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.equal(created.status, 0, created.stderr);
	return (JSON.parse(created.stdout) as { snapshot: string }).snapshot;
}
const callsSince = (t: ReturnType<typeof setup>, count: number) => t.calls().slice(count);

it("restore fills two new volumes from the recorded image and returns what an integration run needs", () => {
	const t = setup();
	const snapshot = snapshotFor(t);
	const before = t.calls().length;
	const restored = t.run("restore", snapshot);
	assert.equal(restored.status, 0, restored.stderr);
	const result = JSON.parse(restored.stdout);
	assert.match(result.volumes.data, /^lh-restore-[0-9a-f-]{36}-data$/);
	assert.equal(result.volumes.auth, result.volumes.data.replace(/-data$/, "-auth"));
	assert.deepEqual(Object.keys(result), ["volumes", "imageId", "runtimeFile"]);
	assert.equal(result.imageId, imageId);
	assert.equal(result.runtimeFile, path.join(snapshot, "runtime.json"));
	assert.equal(JSON.parse(fs.readFileSync(result.runtimeFile, "utf8")).imageId, imageId);
	const calls = callsSince(t, before);
	assert.ok(!calls.some((call) => call.args[0] === "pull" || call.args.includes("start") || call.args[0] === "compose"));
	const creates = calls.filter((call) => call.args[0] === "volume" && call.args[1] === "create");
	assert.deepEqual(creates.map((call) => call.args.at(-1)), [result.volumes.data, result.volumes.auth]);
	const uuid = result.volumes.data.slice("lh-restore-".length, -"-data".length);
	for (const call of creates) assert.deepEqual(call.args.slice(2, -1), ["--label", `learnharness.restore=${uuid}`]);
	const helper = calls.find((call) => call.args[0] === "run")!;
	assert.deepEqual(Buffer.from(helper.stdin, "base64"), profileBytes);
	assert.equal(helper.args.at(-1), "restore");
	const flags = helper.args.slice(0, helper.args.indexOf(imageId));
	const mounts = flags.flatMap((flag, i) => (flag === "--mount" ? [flags[i + 1]] : []));
	assert.deepEqual(mounts, [`type=volume,src=${result.volumes.data},dst=/data`, `type=volume,src=${result.volumes.auth},dst=/auth`]);
	for (const expected of [["--network", "none"], ["--read-only"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--user", "1000:1000"], ["--pull", "never"], ["--entrypoint", "node"]]) {
		const at = flags.indexOf(expected[0]!);
		assert.deepEqual(flags.slice(at, at + expected.length), expected);
	}
	assert.ok(!flags.some((flag) => /^(-v|--volume|-p|--publish|--privileged|--volumes-from)$/.test(flag) || /docker\.sock|learnharness_app/.test(flag)));
	assert.ok(!calls.some((call) => call.args[0] === "volume" && call.args[1] === "rm"));
	const second = JSON.parse(t.run("restore", snapshot).stdout);
	assert.notEqual(second.volumes.data, result.volumes.data);
});

it("restore removes only the volumes it created when the helper fails", () => {
	const t = setup();
	const snapshot = snapshotFor(t);
	t.writePlan(({ ...healthyPlan(), run: { status: 3, stderr: "synthetic-helper-detail" } }));
	const before = t.calls().length;
	const restored = t.run("restore", snapshot);
	assert.equal(restored.status, 1);
	assert.match(restored.stderr, /^server-backup: RESTORE_FAILED: /);
	assert.ok(!restored.stderr.includes("synthetic-helper-detail"));
	const calls = callsSince(t, before);
	const created = calls.filter((call) => call.args[0] === "volume" && call.args[1] === "create").map((call) => call.args.at(-1));
	const removed = calls.filter((call) => call.args[0] === "volume" && call.args[1] === "rm").flatMap((call) => call.args.slice(2));
	assert.equal(created.length, 2);
	assert.deepEqual(removed.sort(), [...created].sort());
});

it("restore refuses a damaged snapshot, a missing image or an existing volume name before writing anything", () => {
	const t = setup();
	const snapshot = snapshotFor(t);
	const writes = (calls: ReturnType<typeof t.calls>) => calls.filter((call) => call.args[0] === "run" || call.args[1] === "create" || call.args[1] === "rm");

	t.writePlan(({ ...healthyPlan(), "image inspect": { status: 1 } }));
	let before = t.calls().length;
	let result = t.run("restore", snapshot);
	assert.match(result.stderr, /^server-backup: IMAGE_MISSING: /);
	assert.deepEqual(writes(callsSince(t, before)), []);

	t.writePlan(({ ...healthyPlan(), "image inspect": { stdout: b64("sha256:" + "b".repeat(64)) } }));
	before = t.calls().length;
	result = t.run("restore", snapshot);
	assert.match(result.stderr, /^server-backup: IMAGE_MISSING: /);
	assert.deepEqual(writes(callsSince(t, before)), []);

	t.writePlan(({ ...healthyPlan(), "volume inspect": { status: 0, stdout: b64("[]") } }));
	before = t.calls().length;
	result = t.run("restore", snapshot);
	assert.match(result.stderr, /^server-backup: RESTORE_FAILED: /);
	assert.deepEqual(writes(callsSince(t, before)), []);

	t.writePlan((healthyPlan()));
	fs.appendFileSync(path.join(snapshot, "profile.tar.gz"), "x");
	before = t.calls().length;
	result = t.run("restore", snapshot);
	assert.match(result.stderr, /^server-backup: SNAPSHOT_INVALID: /);
	assert.deepEqual(callsSince(t, before), []);
});

it("ships a daily 03:00 local timer and a generic service template with no private values", () => {
	const timer = fs.readFileSync("scripts/backup/learnharness-backup.timer", "utf8");
	assert.match(timer, /^OnCalendar=\*-\*-\* 03:00:00$/m);
	assert.match(timer, /^Persistent=true$/m);
	assert.doesNotMatch(timer, /UTC|Europe|America/);
	const service = fs.readFileSync("scripts/backup/learnharness-backup.service", "utf8");
	assert.match(service, /^Type=oneshot$/m);
	assert.match(service, /^EnvironmentFile=\/etc\/learnharness\/backup\.env$/m);
	assert.match(service, /^ExecStart=\/usr\/bin\/node \$\{LH_BACKUP_CHECKOUT\}\/scripts\/server-backup\.mjs create --env-file \$\{LH_BACKUP_SERVER_ENV\} --directory \/var\/lib\/learnharness-backups --kind daily$/m);
	assert.doesNotMatch(service + timer, /https?:\/\/|ts\.net|LH_SERVER_ORIGIN=|sk-/);
	for (const file of ["scripts/server-backup.mjs", "scripts/backup/operator.mjs"]) {
		assert.equal(spawnSync(process.execPath, ["--check", file]).status, 0, file);
		assert.doesNotMatch(fs.readFileSync(file, "utf8"), /systemctl|\bprune\b|"pull"|"start"|"compose"/);
	}
});

it("refuses a backup root that overlaps any of the app's mount sources, wherever Docker keeps them", () => {
	const t = setup();
	for (const source of [t.backups, path.dirname(t.backups), path.join(t.backups, "volumes/x/_data")]) {
		const mounts = [...appMounts, { Type: "bind", Source: source, Destination: "/etc/learnharness/egress.json" }];
		t.writePlan(({ ...healthyPlan(), ...inspectWith({ mounts }) }));
		const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
		assert.equal(result.status, 1, source);
		assert.match(result.stderr, /^server-backup: BACKUP_ROOT_INVALID: /, source);
		assert.ok(!t.calls().some((call) => call.args[0] === "exec"), source);
		assert.deepEqual(fs.readdirSync(t.backups), []);
	}
});

it("verify refuses a snapshot whose runtime record is malformed even when its hashes match", async () => {
	const t = setup();
	const create = at(t);
	const bad: Array<(runtime: Record<string, unknown>) => unknown> = [
		(r) => ({ ...r, imageId: "learnharness:server" }),
		(r) => ({ ...r, env: ["OK=1", 7] }),
		(r) => ({ ...r, env: undefined }),
		(r) => ({ ...r, version: 2 }),
		(r) => ({ ...r, mounts: "none" }),
		() => [],
	];
	for (const [index, change] of bad.entries()) {
		const { snapshot } = await create(T - index * 60_000);
		const file = path.join(snapshot, "runtime.json");
		const text = JSON.stringify(change(JSON.parse(fs.readFileSync(file, "utf8"))));
		fs.writeFileSync(file, text);
		const metaFile = path.join(snapshot, "snapshot.json");
		const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
		const entry = meta.files.find((f: { path: string }) => f.path === "runtime.json");
		entry.size = Buffer.byteLength(text);
		entry.sha256 = createHash("sha256").update(text).digest("hex");
		fs.writeFileSync(metaFile, JSON.stringify(meta));
		const result = t.run("verify", snapshot);
		assert.equal(result.status, 1, `change ${index}`);
		assert.match(result.stderr, /^server-backup: SNAPSHOT_INVALID: /, `change ${index}`);
	}
});

it("stores a large capture byte for byte", () => {
	const big = Buffer.alloc(8 * 1024 * 1024 + 7);
	for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
	const t = setup({ ...healthyPlan(), exec: { stdout: big.toString("base64") } });
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.equal(created.status, 0, created.stderr);
	assert.ok(fs.readFileSync(path.join(JSON.parse(created.stdout).snapshot, "profile.tar.gz")).equals(big));
});

it("asks the owner to confirm no backup is running before removing a leftover lock", () => {
	const t = setup();
	fs.writeFileSync(path.join(t.backups, ".lock"), "12345\n");
	const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.match(result.stderr, /^server-backup: BACKUP_LOCKED: .*no server-backup\.mjs process is running.*\.lock/);
});

for (const [label, change] of [
	["the env file's origin differs from the running app's", (t: ReturnType<typeof setup>) => fs.writeFileSync(t.envFile, `LH_SERVER_ORIGIN=https://other.example\nLH_EGRESS_POLICY_FILE=${t.policy}\n`)],
	["the app runs without LH_SERVER_ORIGIN", (t: ReturnType<typeof setup>) => t.writePlan({ ...healthyPlan(), ...inspectWith({ env: appEnv.filter((e) => !e.startsWith("LH_SERVER_ORIGIN=")) }) })],
	["the env file names a different policy than the one mounted", (t: ReturnType<typeof setup>) => {
		const other = path.join(path.dirname(t.policy), "other.json");
		fs.writeFileSync(other, "{}");
		fs.writeFileSync(t.envFile, `LH_SERVER_ORIGIN=https://synthetic.example\nLH_EGRESS_POLICY_FILE=${other}\n`);
	}],
	["no policy is mounted into the app", (t: ReturnType<typeof setup>) => t.writePlan({ ...healthyPlan(), ...inspectWith({ mounts: appMounts.slice(0, 2) }) })],
] as const) {
	it(`refuses to capture when ${label}`, () => {
		const t = setup();
		change(t);
		const result = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^server-backup: CONFIG_MISMATCH: /);
		assert.ok(!t.calls().some((call) => call.args[0] === "exec"));
		assert.deepEqual(fs.readdirSync(t.backups), []);
	});
}

it("records the app's mounts in runtime.json", () => {
	const t = setup();
	const created = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
	assert.equal(created.status, 0, created.stderr);
	const runtime = JSON.parse(fs.readFileSync(path.join(JSON.parse(created.stdout).snapshot, "runtime.json"), "utf8"));
	assert.deepEqual(runtime.mounts, [
		{ type: "volume", name: "synthetic_app-data", source: appMounts[0]!.Source, destination: "/data", readOnly: false },
		{ type: "volume", name: "synthetic_app-auth", source: appMounts[1]!.Source, destination: "/auth", readOnly: false },
		{ type: "bind", name: null, source: t.policy, destination: "/etc/learnharness/egress.json", readOnly: true },
	]);
});

it("refuses an env file or policy file inside the checkout", () => {
	const t = setup();
	const inCheckout = fs.mkdtempSync(path.resolve(".lh-backup-test-"));
	try {
		const env = path.join(inCheckout, "server.env");
		fs.writeFileSync(env, fs.readFileSync(t.envFile));
		const envResult = t.run("create", "--env-file", env, "--directory", t.backups);
		assert.match(envResult.stderr, /^server-backup: ENV_FILE_INVALID: /);
		const policy = path.join(inCheckout, "egress.json");
		fs.copyFileSync(t.policy, policy);
		fs.writeFileSync(t.envFile, `LH_SERVER_ORIGIN=https://synthetic.example\nLH_EGRESS_POLICY_FILE=${policy}\n`);
		const policyResult = t.run("create", "--env-file", t.envFile, "--directory", t.backups);
		assert.match(policyResult.stderr, /^server-backup: POLICY_FILE_INVALID: /);
		assert.deepEqual(t.calls(), []);
		assert.deepEqual(fs.readdirSync(t.backups), []);
	} finally {
		fs.rmSync(inCheckout, { recursive: true, force: true });
	}
});

// Opt-in, real Docker: LH_BACKUP_HELPER_IMAGE=<disposable app image>. Runs the
// actual helper on a synthetic profile into two new lh-restore-debug-* volumes.
const helperImage = process.env.LH_BACKUP_HELPER_IMAGE;
it("the real helper verifies a synthetic profile and loads it into two empty new volumes", { skip: !helperImage && "set LH_BACKUP_HELPER_IMAGE" }, () => {
	const dir = path.join(root, `helper-${caseNumber++}`);
	fs.mkdirSync(path.join(dir, "src/data/chats"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src/auth"));
	fs.writeFileSync(path.join(dir, "src/data/chats/synthetic.json"), '{"synthetic":true}\n');
	fs.writeFileSync(path.join(dir, "src/data/settings.json"), "{}\n");
	fs.writeFileSync(path.join(dir, "src/auth/auth.json"), '{"synthetic":"auth"}\n');
	const require = createRequire(import.meta.url);
	const { captureProfile } = require("../scripts/backup/profile.cjs");
	const manifest = captureProfile({ dataDirectory: path.join(dir, "src/data"), authDirectory: path.join(dir, "src/auth"), destination: path.join(dir, "stage") });
	const archive = path.join(dir, "profile.tar.gz");
	assert.equal(spawnSync("tar", ["-czf", archive, "-C", path.join(dir, "stage"), "data", "auth", "manifest.json"]).status, 0);
	const image = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", helperImage!], { encoding: "utf8" }).stdout.trim();
	const docker = (args: string[], input?: Buffer) => spawnSync("docker", args, { input, encoding: "utf8" });
	assert.equal(docker(helperArgs(image, "verify"), fs.readFileSync(archive)).status, 0);
	const id = crypto.randomUUID();
	const volumes = [`lh-restore-debug-${id}-data`, `lh-restore-debug-${id}-auth`];
	try {
		for (const volume of volumes) assert.equal(docker(["volume", "create", "--label", `learnharness.restore=${id}`, volume]).status, 0);
		const mounts = ["--mount", `type=volume,src=${volumes[0]},dst=/data`, "--mount", `type=volume,src=${volumes[1]},dst=/auth`];
		assert.equal(docker(helperArgs(image, "restore", mounts), fs.readFileSync(archive)).status, 0);
		const listing = docker([
			"run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "1000:1000",
			"--mount", `type=volume,src=${volumes[0]},dst=/v/data,readonly`, "--mount", `type=volume,src=${volumes[1]},dst=/v/auth,readonly`,
			"--entrypoint", "node", image, "-e",
			`const fs=require("fs"),c=require("crypto"),out=[];(function walk(r){for(const n of fs.readdirSync("/v/"+r).sort()){const p=r+"/"+n,s=fs.lstatSync("/v/"+p);if(s.isDirectory())walk(p);else out.push({path:p,size:s.size,sha256:c.createHash("sha256").update(fs.readFileSync("/v/"+p)).digest("hex")})}})("auth");(function walk(r){for(const n of fs.readdirSync("/v/"+r).sort()){const p=r+"/"+n,s=fs.lstatSync("/v/"+p);if(s.isDirectory())walk(p);else out.push({path:p,size:s.size,sha256:c.createHash("sha256").update(fs.readFileSync("/v/"+p)).digest("hex")})}})("data");console.log(JSON.stringify({files:out,roots:["/v/data","/v/auth"].map(d=>{const s=fs.statSync(d);return [s.uid,s.mode&0o777]})}))`,
		]);
		assert.equal(listing.status, 0, listing.stderr);
		const restored = JSON.parse(listing.stdout);
		assert.deepEqual(restored.files, manifest.files);
		assert.deepEqual(restored.roots, [[1000, 0o700], [1000, 0o700]]);
		// A second load into the now-filled volumes is refused.
		assert.notEqual(docker(helperArgs(image, "restore", mounts), fs.readFileSync(archive)).status, 0);
	} finally {
		docker(["volume", "rm", ...volumes]);
	}
});

for (const [label, change] of [
	["docker volume rm exits nonzero", { "volume rm": { status: 1, stderr: "synthetic-rm-detail" } }],
	["docker volume rm is killed", { "volume rm": { signal: "SIGKILL" } }],
	["docker cannot be started for the cleanup", { run: { status: 3, vanish: true } }],
] as const) {
	it(`restore reports that cleanup failed when ${label}`, () => {
		const t = setup();
		const snapshot = snapshotFor(t);
		t.writePlan({ ...healthyPlan(), run: { status: 3 }, ...change });
		const restored = t.run("restore", snapshot);
		assert.equal(restored.status, 1);
		assert.match(restored.stderr, /^server-backup: RESTORE_CLEANUP_FAILED: /);
		assert.ok(!restored.stderr.includes("synthetic-rm-detail"));
		assert.equal(restored.stdout, "");
	});
}
