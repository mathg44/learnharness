/**
 * Release preservation command (#30): scripts/server-release.mjs. Real
 * disposable directories and a real Git repository fixture with its own
 * commit. Only the Docker executable is faked: a script on PATH that logs its
 * argv, keeps image tags in a state file and answers from a per-test plan.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const cli = path.resolve("scripts/server-release.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-release-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
// Compose runs with a scrubbed environment, so the plan sits next to bin/.
const planFile = path.join(__dirname, "..", "plan.json");
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const stateFile = planFile + ".state";
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { tags: {} };
const args = process.argv.slice(2);
const entry = { args, env: Object.keys(process.env).sort() };
if (args[0] === "compose") {
	const dir = args[args.indexOf("--project-directory") + 1];
	entry.files = args.flatMap((arg, i) => args[i - 1] === "-f" ? [fs.readFileSync(path.resolve(dir, arg), "utf8")] : []);
}
fs.appendFileSync(planFile + ".log", JSON.stringify(entry) + "\\n");
// Opt-in: hand Compose to the real CLI. It only reads files for "config"; the daemon is not contacted.
if (args[0] === "compose" && plan.realDocker) {
	const real = require("node:child_process").spawnSync(plan.realDocker, args, { stdio: ["ignore", "pipe", "pipe"] });
	process.stdout.write(real.stdout, () => process.exit(real.status ?? 1));
	return;
}
const value = (flag) => args.find((arg) => arg.startsWith(flag))?.slice(flag.length);
let key = args[0];
if (args[0] === "ps") key = "ps " + value("label=com.docker.compose.service=");
else if (args[0] === "container" || args[0] === "image") key = args[0] + " " + args[1];
// Answers may name a substring of the argv they apply to.
const candidates = [plan[key + " " + args.at(-1)], plan[key]].filter(Boolean).flat();
let answer = candidates.find((a) => !a.match || args.join(" ").includes(a.match));
const resolve = (ref) => state.tags[ref] ?? (plan.images ?? []).find((id) => id === ref);
if (!answer) {
	answer = { status: 0, stdout: "" };
	if (key === "info") answer.stdout = "/srv/docker-root\\n";
	else if (key === "image ls") answer.stdout = resolve(value("reference=")) ? resolve(value("reference=")) + "\\n" : "";
	else if (key === "image inspect") {
		const id = resolve(args.at(-1));
		answer = id ? { stdout: id + "\\n" } : { status: 1, stderr: "Error: No such image" };
	} else if (key === "image tag") {
		const id = resolve(args[2]);
		if (!id) answer = { status: 1 };
		else state.tags[args[3]] = id;
	} else if (key === "image rm") {
		if (state.tags[args.at(-1)]) delete state.tags[args.at(-1)];
		else answer = { status: 1 };
	}
}
fs.writeFileSync(stateFile, JSON.stringify(state));
if (answer.stderr) process.stderr.write(answer.stderr);
const out = answer.json === undefined ? answer.stdout ?? "" : JSON.stringify(answer.json);
process.stdout.write(out, () => process.exit(answer.status ?? 0));
`;

type Answer = { stdout?: string; json?: unknown; stderr?: string; status?: number; match?: string };
type Plan = Record<string, Answer | Answer[] | string[] | string>;

const hex = (seed: string, length = 64) => crypto.createHash("sha256").update(seed).digest("hex").slice(0, length);
const ids = { app: "sha256:" + hex("app-image"), egress: "sha256:" + hex("egress-image"), demo: "sha256:" + hex("demo-image") };
const containers = { app: hex("app-container"), egress: hex("egress-container"), demo: hex("demo-container") };
const hashes = { app: hex("app-hash"), egress: hex("egress-hash"), demo: hex("demo-hash") };
const releaseHashes = { app: hex("app-release-hash"), egress: hex("egress-release-hash"), demo: hex("demo-release-hash") };
const hashLines = (h: Record<Service, string>) => `app ${h.app}\ndemo ${h.demo}\negress ${h.egress}\n`;
const DAY = 24 * 60 * 60 * 1000;

// Shaped like the real recipes where it matters: named data/auth volumes, the policy bind, a relative seccomp path.
const composeBase = [
	"services:", "  app:", "    image: learnharness:local", "    build:", "      context: .", "    read_only: true", "    volumes:", "      - app-data:/data", "      - app-auth:/auth",
	"volumes:", "  app-data:", "  app-auth:", "",
].join("\n");
const composeServer = [
	"services:",
	"  egress:", "    image: learnharness:egress", "    volumes:", "      - type: bind", "        source: ${LH_EGRESS_POLICY_FILE:?Set the policy}", "        target: /etc/learnharness/egress.json", "        read_only: true",
	"  demo:", "    image: learnharness:demo", "    network_mode: none", "    security_opt:", "      - no-new-privileges:true", "      - seccomp=./scripts/demo/seccomp.json",
	"  app:", "    image: learnharness:server", "    network_mode: service:egress", "    environment:", "      LH_SERVER_ORIGIN: ${LH_SERVER_ORIGIN:?Set the origin}",
	"    volumes:", "      - type: bind", "        source: ${LH_EGRESS_POLICY_FILE:?Set the policy}", "        target: /etc/learnharness/egress.json", "        read_only: true",
	"",
].join("\n");
const seccomp = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read", "write"], action: "SCMP_ACT_ALLOW" }] };
const seccompText = JSON.stringify(seccomp, null, "\t") + "\n";

function gitEnv() {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv(), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

/** A real repository with one commit holding the recipes this release must match. */
function makeSource(dir: string, files: Record<string, string> = {}) {
	fs.mkdirSync(path.join(dir, "scripts/demo"), { recursive: true });
	const all = { "compose.yaml": composeBase, "compose.server.yaml": composeServer, "scripts/demo/seccomp.json": seccompText, "README.md": "synthetic source\n", ...files };
	for (const [file, text] of Object.entries(all)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	}
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "synthetic");
	return git(dir, "rev-parse", "HEAD");
}

const compact = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Writes a pre-update snapshot in the #29 format, the way server-backup.mjs publishes one. */
function makeSnapshot(backups: string, policy: string, { createdAt = new Date(Math.floor(Date.now() / 1000) * 1000 - DAY).toISOString(), compose = composeBase, server = composeServer, volumes = defaultVolumes } = {}) {
	const name = `pre-update-${compact(createdAt)}-${hex(createdAt + Math.random(), 8)}`;
	const dir = path.join(backups, name);
	fs.mkdirSync(path.join(dir, "config"), { recursive: true, mode: 0o700 });
	const runtime = {
		version: 1, project: "learnharness", container: containers.app, imageId: ids.app,
		env: ["LH_SERVER_ORIGIN=https://synthetic.example", "LH_DATA_DIR=/data", "LH_AUTH_FILE=/auth/auth.json"],
		mounts: [
			{ type: "volume", name: volumes.data, source: `/srv/docker-root/volumes/${volumes.data}/_data`, destination: "/data", readOnly: false },
			{ type: "volume", name: volumes.auth, source: `/srv/docker-root/volumes/${volumes.auth}/_data`, destination: "/auth", readOnly: false },
			{ type: "bind", name: null, source: policy, destination: "/etc/learnharness/egress.json", readOnly: true },
		],
	};
	const payload: Record<string, string> = {
		"config/compose.server.yaml": server,
		"config/compose.yaml": compose,
		"config/egress.json": fs.readFileSync(policy, "utf8"),
		"config/server.env": `LH_SERVER_ORIGIN=https://synthetic.example\nLH_EGRESS_POLICY_FILE=${policy}\n`,
		"profile.tar.gz": "synthetic profile bytes",
		"runtime.json": JSON.stringify(runtime, null, "\t") + "\n",
	};
	const files = [];
	for (const [file, text] of Object.entries(payload)) {
		fs.writeFileSync(path.join(dir, file), text, { mode: 0o600 });
		files.push({ path: file, size: Buffer.byteLength(text), sha256: sha(text) });
	}
	const protectedUntil = new Date(Date.parse(createdAt) + 14 * DAY).toISOString();
	fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ version: 1, kind: "pre-update", createdAt, protectedUntil, files }, null, "\t") + "\n", { mode: 0o600 });
	return { dir, name, createdAt, protectedUntil };
}

type Service = "app" | "egress" | "demo";
const defaultVolumes = { data: "learnharness_app-data", auth: "learnharness_app-auth" };
const appMounts = (policy: string, volumes = defaultVolumes) => [
	{ Type: "volume", Name: volumes.data, Source: `/srv/docker-root/volumes/${volumes.data}/_data`, Destination: "/data", RW: true },
	{ Type: "volume", Name: volumes.auth, Source: `/srv/docker-root/volumes/${volumes.auth}/_data`, Destination: "/auth", RW: true },
	{ Type: "bind", Source: policy, Destination: "/etc/learnharness/egress.json", RW: false },
];
const runningImage = { app: "learnharness:server", egress: "learnharness:egress", demo: "learnharness:demo" };

function inspect(service: Service, policy: string, change: { image?: string; labels?: Record<string, string>; securityOpt?: string[]; mounts?: unknown[]; imageId?: string } = {}) {
	const policyMount = { Type: "bind", Source: policy, Destination: "/etc/learnharness/egress.json", RW: false };
	const mounts = {
		app: appMounts(policy),
		egress: [policyMount, { Type: "volume", Name: "learnharness_egress-state", Source: "/srv/docker-root/volumes/egress/_data", Destination: "/run/lh-egress", RW: true }],
		demo: [{ Type: "volume", Name: "learnharness_demo-socket", Source: "/srv/docker-root/volumes/demo/_data", Destination: "/run/learnharness-demo", RW: true }],
	}[service];
	const securityOpt = service === "demo" ? ["no-new-privileges:true", "seccomp=" + JSON.stringify(seccomp)] : ["no-new-privileges:true"];
	return {
		json: [{
			Id: containers[service], Image: change.imageId ?? ids[service],
			Config: {
				Image: change.image ?? runningImage[service], Env: ["SYNTHETIC_SECRET=do-not-print"],
				Labels: {
					"com.docker.compose.project": "learnharness", "com.docker.compose.service": service,
					"com.docker.compose.config-hash": hashes[service], ...change.labels,
				},
			},
			HostConfig: { SecurityOpt: change.securityOpt ?? securityOpt },
			Mounts: change.mounts ?? mounts,
		}],
	};
}

/** What `docker compose config --format json` reports for the release arrangement's volumes. */
function effectiveConfig(volumes: Record<string, { name: string; external?: boolean }> = { "app-data": { name: defaultVolumes.data }, "app-auth": { name: defaultVolumes.auth } }) {
	return {
		services: { app: { volumes: [{ type: "volume", source: "app-data", target: "/data", volume: {} }, { type: "volume", source: "app-auth", target: "/auth", volume: {} }] } },
		volumes,
	};
}

function healthyPlan(policy: string): Plan {
	return {
		"ps app": { stdout: containers.app + "\n" },
		"ps egress": { stdout: containers.egress + "\n" },
		"ps demo": { stdout: containers.demo + "\n" },
		[`container inspect ${containers.app}`]: inspect("app", policy),
		[`container inspect ${containers.egress}`]: inspect("egress", policy),
		[`container inspect ${containers.demo}`]: inspect("demo", policy),
		compose: [
			{ json: effectiveConfig(), match: "--format json" },
			{ stdout: hashLines(hashes), match: ".running.override.yaml" },
			{ stdout: hashLines(releaseHashes), match: "images.override.yaml" },
		],
		images: Object.values(ids),
	};
}

let caseNumber = 0;
function setup({ plan, source: files }: { plan?: (policy: string) => Plan; source?: Record<string, string> } = {}) {
	const dir = path.join(root, `case-${caseNumber++}`);
	const bin = path.join(dir, "bin");
	const releases = path.join(dir, "releases");
	const backups = path.join(dir, "backups");
	const priv = path.join(dir, "private");
	const source = path.join(dir, "source");
	for (const folder of [bin, releases, backups, priv]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
	const policy = path.join(priv, "egress.json");
	fs.writeFileSync(policy, '{"synthetic":"policy"}\n', { mode: 0o600 });
	const revision = makeSource(source, files);
	const planFile = path.join(dir, "plan.json");
	const writePlan = (next: Plan) => fs.writeFileSync(planFile, JSON.stringify(next));
	writePlan((plan ?? healthyPlan)(policy));
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYNTHETIC_HOST_SECRET: "host-secret" };
	const run = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
		const result = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...options.env }, cwd: options.cwd ?? source, encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	const calls = () => fs.existsSync(planFile + ".log")
		? fs.readFileSync(planFile + ".log", "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: string[]; files?: string[] })
		: [];
	const tags = () => (fs.existsSync(planFile + ".state") ? JSON.parse(fs.readFileSync(planFile + ".state", "utf8")).tags : {}) as Record<string, string>;
	const snapshot = (options?: Parameters<typeof makeSnapshot>[2]) => makeSnapshot(backups, policy, options);
	const preserve = (snap: string, extra: string[] = [], options?: Parameters<typeof run>[1]) =>
		run(["preserve", "--snapshot", snap, "--revision", revision, "--directory", releases, ...extra], options);
	return { dir, releases, backups, policy, source, revision, run, calls, tags, writePlan, snapshot, preserve, planFile };
}

type Release = { release: string; revision: string; createdAt: string; protectedUntil: string; images: Record<Service, { id: string; tag: string }> };

it("preserve publishes a release that verify accepts, tagging the exact running images", () => {
	const t = setup();
	const snap = t.snapshot();
	const preserved = t.preserve(snap.dir);
	assert.equal(preserved.status, 0, preserved.stderr);
	const result = JSON.parse(preserved.stdout) as Release;
	assert.deepEqual(Object.keys(result), ["release", "revision", "createdAt", "protectedUntil", "images"]);
	assert.equal(result.revision, t.revision);
	assert.equal(result.protectedUntil, snap.protectedUntil);
	const stamp = compact(result.createdAt);
	const short = t.revision.slice(0, 12);
	assert.equal(path.dirname(result.release), t.releases);
	assert.match(path.basename(result.release), new RegExp(`^release-${stamp}-${short}-[0-9a-f]{8}$`));
	assert.deepEqual(result.images, {
		app: { id: ids.app, tag: `learnharness:server-${stamp}-${short}` },
		egress: { id: ids.egress, tag: `learnharness:egress-${stamp}-${short}` },
		demo: { id: ids.demo, tag: `learnharness:demo-${stamp}-${short}` },
	});
	assert.deepEqual(t.tags(), { [result.images.app.tag]: ids.app, [result.images.egress.tag]: ids.egress, [result.images.demo.tag]: ids.demo });
	assert.deepEqual(fs.readdirSync(t.releases), [path.basename(result.release)]);
	const verified = t.run(["verify", result.release]);
	assert.equal(verified.status, 0, verified.stderr);
	assert.deepEqual(JSON.parse(verified.stdout), { ...result, expired: false });
});

function preserved(t: ReturnType<typeof setup>, snap = t.snapshot()) {
	const result = t.preserve(snap.dir);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as Release;
}

it("verify refuses altered, missing, extra, linked, loosened and partial releases", () => {
	const damage: Array<(release: string, t: ReturnType<typeof setup>) => string> = [
		(r) => (fs.appendFileSync(path.join(r, "source.tar"), "x"), r),
		(r) => (fs.appendFileSync(path.join(r, "images.override.yaml"), "  extra: {}\n"), r),
		(r) => (fs.rmSync(path.join(r, "scripts/demo/seccomp.json")), r),
		(r) => (fs.writeFileSync(path.join(r, "notes.txt"), "", { mode: 0o600 }), r),
		(r, t) => (fs.rmSync(path.join(r, "egress.json")), fs.symlinkSync(t.policy, path.join(r, "egress.json")), r),
		(r) => (fs.chmodSync(path.join(r, "server.env"), 0o644), r),
		(r) => (fs.chmodSync(path.join(r, "scripts"), 0o755), r),
		(r) => (fs.writeFileSync(path.join(r, "release.json"), "{"), r),
		(r) => {
			const snapshotDir = path.join(r, "snapshot", fs.readdirSync(path.join(r, "snapshot"))[0]!);
			fs.appendFileSync(path.join(snapshotDir, "profile.tar.gz"), "x");
			return r;
		},
		(r, t) => {
			const partial = path.join(t.releases, `.partial-${path.basename(r)}`);
			fs.renameSync(r, partial);
			return partial;
		},
		(r) => {
			const renamed = r.replace(/release-\d{8}T/, "release-20200101T");
			fs.renameSync(r, renamed);
			return renamed;
		},
	];
	for (const [index, harm] of damage.entries()) {
		// Each release gets its own case: two preserves in the same second would need the same tags.
		const t = setup();
		const result = t.run(["verify", harm(preserved(t).release, t)]);
		assert.equal(result.status, 1, `damage ${index}`);
		assert.match(result.stderr, /^server-release: RELEASE_INVALID: /, `damage ${index}`);
	}
});

it("verify requires every recorded image locally and every retention tag still naming it", () => {
	const t = setup();
	const release = preserved(t);
	const before = t.calls().length;
	const state = t.planFile + ".state";
	const tags = t.tags();

	fs.writeFileSync(state, JSON.stringify({ tags: { ...tags, [release.images.egress.tag]: ids.app } }));
	let result = t.run(["verify", release.release]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: TAG_MISMATCH: /);

	const { [release.images.demo.tag]: _removed, ...rest } = tags;
	fs.writeFileSync(state, JSON.stringify({ tags: rest }));
	result = t.run(["verify", release.release]);
	assert.match(result.stderr, /^server-release: TAG_MISMATCH: /);

	fs.writeFileSync(state, JSON.stringify({ tags }));
	t.writePlan({ ...healthyPlan(t.policy), images: [ids.app, ids.demo] });
	result = t.run(["verify", release.release]);
	assert.match(result.stderr, /^server-release: IMAGE_MISSING: /);
	// verify only reads.
	assert.deepEqual([...new Set(t.calls().slice(before).map((call) => call.args.slice(0, 2).join(" ")))].sort(), ["image inspect", "info --format"]);
});

it("keeps the snapshot's original deadline and reports the release expired once it passes", async () => {
	const t = setup();
	const createdAt = new Date(Date.now() - 14 * DAY + 3000).toISOString();
	const snap = t.snapshot({ createdAt });
	const release = preserved(t, snap);
	assert.equal(release.protectedUntil, new Date(Date.parse(createdAt) + 14 * DAY).toISOString());
	const copied = JSON.parse(fs.readFileSync(path.join(release.release, "snapshot", snap.name, "snapshot.json"), "utf8"));
	assert.equal(copied.protectedUntil, snap.protectedUntil);
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(release.protectedUntil) - Date.now()) + 50));
	const result = t.run(["verify", release.release]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: RELEASE_EXPIRED: /);
	assert.deepEqual(JSON.parse(result.stdout), { ...release, expired: true });
});

it("preserve refuses an expired, daily or damaged snapshot before tagging anything", () => {
	const t = setup();
	const expired = t.snapshot({ createdAt: new Date(Date.now() - 14 * DAY - 1000).toISOString() });
	let result = t.preserve(expired.dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: SNAPSHOT_EXPIRED: /);

	const daily = t.snapshot();
	const dailyName = daily.name.replace("pre-update-", "daily-");
	const meta = JSON.parse(fs.readFileSync(path.join(daily.dir, "snapshot.json"), "utf8"));
	delete meta.protectedUntil;
	fs.writeFileSync(path.join(daily.dir, "snapshot.json"), JSON.stringify({ ...meta, kind: "daily" }));
	fs.renameSync(daily.dir, path.join(t.backups, dailyName));
	result = t.preserve(path.join(t.backups, dailyName));
	assert.match(result.stderr, /^server-release: SNAPSHOT_INVALID: /);

	const damaged = t.snapshot();
	fs.appendFileSync(path.join(damaged.dir, "config/server.env"), "X=1\n");
	result = t.preserve(damaged.dir);
	assert.match(result.stderr, /^server-release: SNAPSHOT_INVALID: /);

	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

const read = (file: string) => fs.readFileSync(file, "utf8");

it("lays the release out so Compose can start the retained deployment from it", () => {
	const t = setup();
	const snap = t.snapshot();
	const release = preserved(t, snap);
	const r = release.release;
	const stamp = compact(release.createdAt);
	const short = t.revision.slice(0, 12);
	assert.equal(read(path.join(r, "images.override.yaml")), [
		"services:",
		"  app:", `    image: "learnharness:server-${stamp}-${short}"`,
		"  egress:", `    image: "learnharness:egress-${stamp}-${short}"`,
		"  demo:", `    image: "learnharness:demo-${stamp}-${short}"`, "",
	].join("\n"));
	assert.equal(read(path.join(r, "volumes.override.yaml")), "volumes: {}\n");
	assert.equal(read(path.join(r, "scripts/demo/seccomp.json")), seccompText);
	for (const file of ["compose.yaml", "compose.server.yaml", "server.env", "egress.json"]) assert.equal(read(path.join(r, file)), read(path.join(snap.dir, "config", file)), file);
	const listed = spawnSync("tar", ["-tf", path.join(r, "source.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
	assert.deepEqual(listed, ["README.md", "compose.server.yaml", "compose.yaml", "scripts/", "scripts/demo/", "scripts/demo/seccomp.json"]);
	const backupVerify = spawnSync(process.execPath, [path.resolve("scripts/server-backup.mjs"), "verify", path.join(r, "snapshot", snap.name)], { encoding: "utf8" });
	assert.equal(backupVerify.status, 0, backupVerify.stderr);
	const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((name) => {
		const entry = path.join(dir, name);
		return fs.lstatSync(entry).isDirectory() ? [entry, ...walk(entry)] : [entry];
	});
	for (const entry of [r, ...walk(r)]) assert.equal(fs.lstatSync(entry).mode & 0o7777, fs.lstatSync(entry).isDirectory() ? 0o700 : 0o600, entry);
	const meta = JSON.parse(read(path.join(r, "release.json")));
	assert.equal(meta.revisionProvenance, "operator-declared");
	assert.deepEqual(meta.volumes, { data: { name: "learnharness_app-data", external: false }, auth: { name: "learnharness_app-auth", external: false } });
	assert.deepEqual(meta.configHashes, releaseHashes);
	assert.deepEqual(meta.images.app, { id: ids.app, tag: release.images.app.tag, running: "learnharness:server" });
});

it("checks the running deployment with the same arrangement a rollback uses, and nothing from the caller's environment", () => {
	const t = setup();
	const release = preserved(t);
	const composeCalls = t.calls().filter((call) => call.args[0] === "compose" && call.args.includes("--hash"));
	assert.equal(composeCalls.length, 2);
	for (const [index, call] of composeCalls.entries()) {
		const at = call.args.indexOf("--project-directory");
		const projectDir = call.args[at + 1]!;
		assert.match(path.basename(projectDir), /^\.partial-/);
		const images = index === 0 ? ".running.override.yaml" : "images.override.yaml";
		assert.deepEqual(call.args, [
			"compose", "-p", "learnharness", "--project-directory", projectDir, "--env-file", path.join(projectDir, "server.env"),
			"-f", path.join(projectDir, "compose.yaml"), "-f", path.join(projectDir, "compose.server.yaml"),
			"-f", path.join(projectDir, images), "-f", path.join(projectDir, "volumes.override.yaml"),
			"config", "--hash", "*",
		]);
		assert.ok(!call.env.some((name) => name.startsWith("SYNTHETIC") || name.startsWith("LH_") || name.startsWith("COMPOSE_")), call.env.join(","));
	}
	assert.equal(composeCalls[0]!.files![2], 'services:\n  app:\n    image: "learnharness:server"\n  egress:\n    image: "learnharness:egress"\n  demo:\n    image: "learnharness:demo"\n');
	assert.ok(!fs.existsSync(path.join(release.release, ".running.override.yaml")));
});

const restored = { data: "lh-restore-0b6f3c1e-8d2a-4c47-9a51-3e2f7d9c0a11-data", auth: "lh-restore-0b6f3c1e-8d2a-4c47-9a51-3e2f7d9c0a11-auth" };

it("preserves a deployment recovered onto restored volumes and maps them as external in the rollback recipe", () => {
	const t = setup();
	const plan = healthyPlan(t.policy);
	plan[`container inspect ${containers.app}`] = inspect("app", t.policy, { image: "learnharness:server-20261101T000000Z-aaaaaaaaaaaa", mounts: appMounts(t.policy, restored) });
	plan.compose = [
		{ json: effectiveConfig({ "app-data": { name: restored.data, external: true }, "app-auth": { name: restored.auth, external: true } }), match: "--format json" },
		...(plan.compose as Answer[]).slice(1),
	];
	t.writePlan(plan);
	const release = preserved(t, t.snapshot({ volumes: restored }));
	assert.equal(read(path.join(release.release, "volumes.override.yaml")), [
		"volumes:",
		"  app-data:", "    external: true", `    name: "${restored.data}"`,
		"  app-auth:", "    external: true", `    name: "${restored.auth}"`, "",
	].join("\n"));
	const meta = JSON.parse(read(path.join(release.release, "release.json")));
	assert.deepEqual(meta.volumes, { data: { name: restored.data, external: true }, auth: { name: restored.auth, external: true } });
	const running = t.calls().find((call) => call.args.includes(path.join(call.args[call.args.indexOf("--project-directory") + 1]!, ".running.override.yaml")))!;
	assert.match(running.files![2]!, /image: "learnharness:server-20261101T000000Z-aaaaaaaaaaaa"/);
	assert.equal(running.files![3], read(path.join(release.release, "volumes.override.yaml")));
	assert.equal(t.run(["verify", release.release]).status, 0);
});

for (const [label, mounts, snapshotVolumes] of [
	["/data is an anonymous volume", (p: string) => appMounts(p, { ...defaultVolumes, data: hex("anonymous") }), { ...defaultVolumes, data: hex("anonymous") }],
	["/auth is a bind mount", (p: string) => [...appMounts(p).filter((m) => m.Destination !== "/auth"), { Type: "bind", Source: "/srv/auth", Destination: "/auth", RW: true }], defaultVolumes],
	["/data is mounted twice", (p: string) => [...appMounts(p), appMounts(p)[0]!], defaultVolumes],
	["the live volume differs from the snapshot's", (p: string) => appMounts(p, restored), defaultVolumes],
	["a volume has some other name", (p: string) => appMounts(p, { ...defaultVolumes, auth: "someone-else_app-auth" }), { ...defaultVolumes, auth: "someone-else_app-auth" }],
] as const) {
	it(`preserve refuses when ${label}`, () => {
		const t = setup();
		t.writePlan({ ...healthyPlan(t.policy), [`container inspect ${containers.app}`]: inspect("app", t.policy, { mounts: mounts(t.policy) }) });
		const result = t.preserve(t.snapshot({ volumes: snapshotVolumes }).dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^server-release: SNAPSHOT_MISMATCH: /);
		assert.deepEqual(t.tags(), {});
		assert.deepEqual(fs.readdirSync(t.releases), []);
	});
}

it("preserve refuses when Compose would not mount the recorded volumes from the release", () => {
	const t = setup();
	const plan = healthyPlan(t.policy);
	plan.compose = [{ json: effectiveConfig({ "app-data": { name: "learnharness_app-data" }, "app-auth": { name: "other_app-auth" } }), match: "--format json" }, ...(plan.compose as Answer[]).slice(1)];
	t.writePlan(plan);
	const result = t.preserve(t.snapshot().dir);
	assert.match(result.stderr, /^server-release: CONFIG_MISMATCH: /);
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

function refuses(t: ReturnType<typeof setup>, code: string, snap = t.snapshot()) {
	const result = t.preserve(snap.dir);
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, new RegExp(`^server-release: ${code}: `));
	assert.equal(result.stdout, "");
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
	assert.ok(!t.calls().some((call) => call.args[0] === "image" && call.args[1] === "tag"));
}

for (const [label, change, code] of [
	["the app container is not the one the snapshot recorded", (p: string) => ({ "ps app": { stdout: hex("other") + "\n" }, [`container inspect ${hex("other")}`]: { json: [{ ...inspect("app", p).json[0], Id: hex("other") }] } }), "SNAPSHOT_MISMATCH"],
	["the app runs another image than the snapshot's", (p: string) => ({ [`container inspect ${containers.app}`]: inspect("app", p, { imageId: ids.egress }) }), "SNAPSHOT_MISMATCH"],
	["the app belongs to another project", (p: string) => ({ [`container inspect ${containers.app}`]: inspect("app", p, { labels: { "com.docker.compose.project": "other" } }) }), "SNAPSHOT_MISMATCH"],
	["a sidecar belongs to another project", (p: string) => ({ [`container inspect ${containers.demo}`]: inspect("demo", p, { labels: { "com.docker.compose.project": "other" } }) }), "CONFIG_MISMATCH"],
	["a container reports another service", (p: string) => ({ [`container inspect ${containers.egress}`]: inspect("egress", p, { labels: { "com.docker.compose.service": "app" } }) }), "CONFIG_MISMATCH"],
	["a container has no config hash", (p: string) => ({ [`container inspect ${containers.egress}`]: inspect("egress", p, { labels: { "com.docker.compose.config-hash": "" } }) }), "CONFIG_MISMATCH"],
	["a service was changed by an override beyond its image", (p: string) => ({ [`container inspect ${containers.demo}`]: inspect("demo", p, { labels: { "com.docker.compose.config-hash": hex("widened") } }) }), "CONFIG_MISMATCH"],
	["the running image reference cannot be written back safely", (p: string) => ({ [`container inspect ${containers.app}`]: inspect("app", p, { image: 'learnharness:server"\n  privileged: true' }) }), "CONFIG_MISMATCH"],
	["Compose cannot read the recipes", () => ({ compose: { status: 1, stderr: "synthetic compose detail" } }), "CONFIG_MISMATCH"],
	["the demo worker runs another seccomp profile", (p: string) => ({ [`container inspect ${containers.demo}`]: inspect("demo", p, { securityOpt: ["no-new-privileges:true", 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] }) }), "SECCOMP_MISMATCH"],
	["the demo worker runs unconfined", (p: string) => ({ [`container inspect ${containers.demo}`]: inspect("demo", p, { securityOpt: ["no-new-privileges:true", "seccomp=unconfined"] }) }), "SECCOMP_MISMATCH"],
	["the demo worker runs Docker's default profile", (p: string) => ({ [`container inspect ${containers.demo}`]: inspect("demo", p, { securityOpt: ["no-new-privileges:true"] }) }), "SECCOMP_MISMATCH"],
	["the egress guard mounts another policy", (p: string) => ({ [`container inspect ${containers.egress}`]: inspect("egress", p, { mounts: [{ Type: "bind", Source: p + ".other", Destination: "/etc/learnharness/egress.json", RW: false }] }) }), "CONFIG_MISMATCH"],
	["a service is not running", () => ({ "ps demo": { stdout: "" } }), "SERVICE_NOT_RUNNING"],
	["two egress guards run", () => ({ "ps egress": { stdout: `${containers.egress}\n${hex("second")}\n` } }), "SERVICE_NOT_RUNNING"],
	["Docker answers with something unexpected", () => ({ [`container inspect ${containers.egress}`]: { stdout: "[{}]" } }), "DOCKER_FAILED"],
] as const) {
	it(`preserve refuses when ${label}`, () => {
		const t = setup();
		t.writePlan({ ...healthyPlan(t.policy), ...change(t.policy) });
		refuses(t, code);
	});
}

it("preserve refuses when the policy file changed since the snapshot", () => {
	const t = setup();
	const snap = t.snapshot();
	fs.writeFileSync(t.policy, '{"synthetic":"changed"}\n');
	refuses(t, "CONFIG_MISMATCH", snap);
});

it("accepts the live seccomp profile in any key order or spacing", () => {
	const t = setup();
	const reordered = JSON.stringify({ syscalls: [{ action: "SCMP_ACT_ALLOW", names: ["read", "write"] }], defaultAction: "SCMP_ACT_ERRNO" });
	t.writePlan({ ...healthyPlan(t.policy), [`container inspect ${containers.demo}`]: inspect("demo", t.policy, { securityOpt: ["no-new-privileges:true", `seccomp=${reordered}`] }) });
	preserved(t);
});

it("archives the declared commit from --source, not the working tree and not whatever GIT_* names", () => {
	const t = setup();
	fs.writeFileSync(path.join(t.source, "README.md"), "uncommitted edit\n");
	const elsewhere = path.join(t.dir, "elsewhere");
	fs.mkdirSync(elsewhere);
	const other = path.join(t.dir, "other-repo");
	makeSource(other, { "README.md": "other repository\n" });
	const snap = t.snapshot();
	const result = t.preserve(snap.dir, ["--source", t.source], { cwd: elsewhere, env: { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other, GIT_CONFIG_PARAMETERS: "'tar.umask=0'" } });
	assert.equal(result.status, 0, result.stderr);
	const { release } = JSON.parse(result.stdout) as Release;
	const readme = spawnSync("tar", ["-xOf", path.join(release, "source.tar"), "README.md"], { encoding: "utf8" });
	assert.equal(readme.stdout, "synthetic source\n");
});

it("preserve refuses a revision that is abbreviated, unknown or not a commit", () => {
	const t = setup();
	const tree = git(t.source, "rev-parse", "HEAD^{tree}");
	for (const revision of [t.revision.slice(0, 12), "f".repeat(40), tree, "HEAD", t.revision.toUpperCase()]) {
		const result = t.run(["preserve", "--snapshot", t.snapshot().dir, "--revision", revision, "--directory", t.releases]);
		assert.equal(result.status, 1, revision);
		assert.match(result.stderr, /^server-release: REVISION_INVALID: /, revision);
	}
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("preserve refuses a source that is not the top of a Git checkout", () => {
	const t = setup();
	const plain = path.join(t.dir, "plain");
	fs.mkdirSync(plain);
	for (const source of [plain, path.join(t.source, "scripts"), "relative/source"]) {
		const result = t.preserve(t.snapshot().dir, ["--source", source]);
		assert.equal(result.status, 1, source);
		assert.match(result.stderr, /^server-release: SOURCE_INVALID: /, source);
	}
	assert.deepEqual(t.tags(), {});
});

it("preserve refuses a revision without the deployment recipes", () => {
	const t = setup();
	git(t.source, "rm", "-q", "scripts/demo/seccomp.json");
	git(t.source, "commit", "-q", "-m", "drop seccomp");
	const revision = git(t.source, "rev-parse", "HEAD");
	const result = t.run(["preserve", "--snapshot", t.snapshot().dir, "--revision", revision, "--directory", t.releases]);
	assert.match(result.stderr, /^server-release: SOURCE_UNSUPPORTED: /);
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("preserve refuses a snapshot whose recipes differ from the revision's", () => {
	for (const change of [{ compose: composeBase + "# edited\n" }, { server: composeServer.replace("learnharness:demo", "learnharness:demo-other") }]) {
		const t = setup();
		refuses(t, "SOURCE_MISMATCH", t.snapshot(change));
	}
});

it("preserve refuses release directories that are shared, linked, missing, relative or overlap the source, helper, backups or a mount", () => {
	const t = setup();
	const shared = path.join(t.dir, "shared");
	fs.mkdirSync(shared, { mode: 0o755 });
	fs.chmodSync(shared, 0o755);
	const link = path.join(t.dir, "link");
	fs.symlinkSync(t.releases, link);
	const inSource = path.join(t.source, "releases");
	fs.mkdirSync(inSource, { mode: 0o700 });
	const inBackups = path.join(t.backups, "releases");
	fs.mkdirSync(inBackups, { mode: 0o700 });
	const inHelper = fs.mkdtempSync(path.resolve(".lh-release-test-"));
	try {
		for (const directory of [shared, link, path.join(t.dir, "missing"), "relative/releases", inSource, t.backups, inBackups, inHelper]) {
			const result = t.run(["preserve", "--snapshot", t.snapshot().dir, "--revision", t.revision, "--directory", directory]);
			assert.equal(result.status, 1, directory);
			assert.match(result.stderr, /^server-release: RELEASE_ROOT_INVALID: /, directory);
		}
		assert.deepEqual(fs.readdirSync(inHelper), []);
	} finally {
		fs.rmSync(inHelper, { recursive: true, force: true });
	}
	for (const source of [t.releases, path.dirname(t.releases), path.join(t.releases, "volumes/x/_data")]) {
		const mounts = [...appMounts(t.policy), { Type: "bind", Source: source, Destination: "/materials", RW: false }];
		t.writePlan({ ...healthyPlan(t.policy), [`container inspect ${containers.demo}`]: inspect("demo", t.policy, { mounts }) });
		const result = t.preserve(t.snapshot().dir);
		assert.match(result.stderr, /^server-release: RELEASE_ROOT_INVALID: /, source);
	}
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(fs.readdirSync(t.releases), []);
	assert.deepEqual(fs.readdirSync(inSource), []);
});

it("preserve refuses to run while another command holds the release directory", () => {
	const t = setup();
	fs.writeFileSync(path.join(t.releases, ".lock"), "12345\n");
	const result = t.preserve(t.snapshot().dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: RELEASE_LOCKED: .*no server-release\.mjs process is running.*\.lock/);
	assert.deepEqual(fs.readdirSync(t.releases), [".lock"]);
	assert.deepEqual(t.tags(), {});
});

const tagCalls = (t: ReturnType<typeof setup>, verb: "tag" | "rm") => t.calls().filter((call) => call.args[0] === "image" && call.args[1] === verb).map((call) => call.args.at(-1));

it("preserve never moves an existing tag and tags nothing when any retention tag is taken", () => {
	const t = setup();
	const short = t.revision.slice(0, 12);
	const foreign = "sha256:" + hex("foreign");
	const taken: Record<string, string> = { "learnharness:server": ids.app };
	for (let second = -1; second < 10; second++) taken[`learnharness:egress-${compact(new Date(Math.floor(Date.now() / 1000) * 1000 + second * 1000).toISOString())}-${short}`] = foreign;
	fs.writeFileSync(t.planFile + ".state", JSON.stringify({ tags: taken }));
	const result = t.preserve(t.snapshot().dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: TAG_EXISTS: /);
	assert.deepEqual(t.tags(), taken);
	assert.deepEqual(tagCalls(t, "tag"), []);
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("preserve removes the tags it created when a later tag fails, and publishes nothing", () => {
	const t = setup();
	t.writePlan({ ...healthyPlan(t.policy), "image tag": { status: 1, stderr: "synthetic tag detail", match: "learnharness:demo-" } });
	fs.writeFileSync(t.planFile + ".state", JSON.stringify({ tags: { "learnharness:server": ids.app } }));
	const result = t.preserve(t.snapshot().dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: TAG_FAILED: /);
	assert.ok(!result.stderr.includes("synthetic tag detail"));
	assert.deepEqual(t.tags(), { "learnharness:server": ids.app });
	const created = tagCalls(t, "tag").slice(0, 2);
	assert.deepEqual(tagCalls(t, "rm").sort(), [...created].sort());
	for (const call of t.calls().filter((c) => c.args[1] === "rm")) assert.deepEqual(call.args.slice(0, 3), ["image", "rm", "--no-prune"]);
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("preserve treats a tag that does not name the image afterwards as failed, and leaves it alone", () => {
	const t = setup();
	// Docker reports success, but something else holds the tag.
	t.writePlan({ ...healthyPlan(t.policy), "image tag": { status: 0, match: "learnharness:egress-" } });
	const result = t.preserve(t.snapshot().dir);
	assert.match(result.stderr, /^server-release: TAG_FAILED: /);
	assert.deepEqual(t.tags(), {});
	assert.deepEqual(tagCalls(t, "rm").length, 1);
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("preserve says so when removing its own tags fails too", () => {
	const t = setup();
	t.writePlan({ ...healthyPlan(t.policy), "image tag": { status: 1, match: "learnharness:demo-" }, "image rm": { status: 1, stderr: "synthetic rm detail" } });
	const result = t.preserve(t.snapshot().dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: RELEASE_CLEANUP_FAILED: /);
	assert.ok(!result.stderr.includes("synthetic rm detail"));
	assert.equal(Object.keys(t.tags()).length, 2);
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

// Only what Compose needs to find its plugin. NODE_ENV only satisfies the ProcessEnv type.
const bareEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", NODE_ENV: process.env.NODE_ENV });

// Real Compose, where installed: `config` only reads files, so no container,
// volume or network is touched. Proves the hashes the release relies on.
const realDocker = ["/usr/bin/docker", "/usr/local/bin/docker"].find((file) => fs.existsSync(file)
	&& spawnSync(file, ["compose", "version"], { env: bareEnv() }).status === 0);

it("with real Compose, accepts a deployment changed only by image and restored-volume overrides and refuses any other change", { skip: !realDocker && "needs docker compose" }, () => {
	const deployed = (t: ReturnType<typeof setup>, extra = "") => {
		// The deployment as an operator would start it: from the source checkout, with its own override file.
		const envFile = path.join(t.dir, "private/server.env");
		fs.writeFileSync(envFile, `LH_SERVER_ORIGIN=https://synthetic.example\nLH_EGRESS_POLICY_FILE=${t.policy}\n`, { mode: 0o600 });
		const images = { app: "learnharness:server-20261101T000000Z-aaaaaaaaaaaa", egress: "learnharness:egress-20261101T000000Z-aaaaaaaaaaaa", demo: "learnharness:demo" };
		const overrideFile = path.join(t.dir, "deploy.override.yaml");
		fs.writeFileSync(overrideFile, [
			"services:", "  app:", `    image: ${images.app}`, extra, "  egress:", `    image: ${images.egress}`,
			"volumes:", "  app-data:", "    external: true", `    name: ${restored.data}`, "  app-auth:", "    external: true", `    name: ${restored.auth}`, "",
		].join("\n"));
		const hashOf = (override: string) => {
			const result = spawnSync(realDocker!, ["compose", "-p", "learnharness", "--project-directory", t.source, "--env-file", envFile, "-f", "compose.yaml", "-f", "compose.server.yaml", "-f", override, "config", "--hash", "*"],
				{ cwd: t.source, env: bareEnv(), encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split(" "))) as Record<Service, string>;
		};
		const live = hashOf(overrideFile);
		const plan = healthyPlan(t.policy);
		for (const service of ["app", "egress", "demo"] as const) {
			plan[`container inspect ${containers[service]}`] = inspect(service, t.policy, {
				image: images[service], labels: { "com.docker.compose.config-hash": live[service] }, ...(service === "app" ? { mounts: appMounts(t.policy, restored) } : {}),
			});
		}
		t.writePlan({ ...plan, compose: [], realDocker: realDocker! });
		return { hashOf };
	};

	const t = setup();
	const { hashOf } = deployed(t);
	const release = preserved(t, t.snapshot({ volumes: restored }));
	// The retained tags, applied the operator's way from the source checkout, give the hashes the release recorded.
	const retainedFile = path.join(t.dir, "retained.override.yaml");
	fs.writeFileSync(retainedFile, "services:\n" + (["app", "egress", "demo"] as const).map((s) => `  ${s}:\n    image: ${release.images[s].tag}\n`).join(""));
	assert.deepEqual(JSON.parse(read(path.join(release.release, "release.json"))).configHashes, hashOf(retainedFile));
	assert.equal(t.run(["verify", release.release]).status, 0);

	const widened = setup();
	deployed(widened, "    privileged: true");
	refuses(widened, "CONFIG_MISMATCH", widened.snapshot({ volumes: restored }));
});

it("preserve only reads Docker apart from its own tags, and prints no secrets or Docker output", () => {
	const t = setup();
	const plan = healthyPlan(t.policy);
	plan["ps app"] = { stdout: containers.app + "\n", stderr: "synthetic-docker-stderr" };
	t.writePlan(plan);
	const ok = t.preserve(t.snapshot().dir);
	assert.equal(ok.status, 0, ok.stderr);
	const verbs = new Set(t.calls().map((call) => call.args[0] === "compose" ? `compose ${call.args.at(-3)}` : call.args.slice(0, 2).join(" ")));
	assert.deepEqual([...verbs].sort(), ["compose config", "container inspect", "image inspect", "image ls", "image tag", "info --format", "ps --no-trunc"]);
	const failing = setup();
	failing.writePlan({ ...healthyPlan(failing.policy), compose: { status: 1, stdout: "SYNTHETIC_SECRET=do-not-print", stderr: "synthetic-docker-stderr" } });
	const bad = failing.preserve(failing.snapshot().dir);
	for (const output of [ok.stdout, ok.stderr, bad.stdout, bad.stderr]) {
		for (const secret of ["synthetic.example", "do-not-print", "synthetic-docker-stderr", "synthetic profile", "host-secret", "policy\""]) assert.ok(!output.includes(secret), secret);
	}
});

it("preserve refuses Compose hashes it cannot read", () => {
	const t = setup();
	const plan = healthyPlan(t.policy);
	plan.compose = [...(plan.compose as Answer[]).slice(0, 2), { stdout: "app not-a-hash\n", match: "images.override.yaml" }];
	t.writePlan(plan);
	assert.match(t.preserve(t.snapshot().dir).stderr, /^server-release: CONFIG_MISMATCH: /);
	assert.deepEqual(fs.readdirSync(t.releases), []);
});

it("rejects incomplete or unknown arguments with a usage error", () => {
	const t = setup();
	const snap = t.snapshot().dir;
	for (const args of [[], ["status"], ["preserve", "--snapshot", snap, "--directory", t.releases], ["preserve", "--snapshot", snap, "--revision", t.revision, "--directory", t.releases, "--force"], ["verify"], ["verify", "a", "b"], ["preserve", "--snapshot", snap, "--revision", t.revision, "--directory", t.releases, "--project", "Bad Name"]]) {
		const result = t.run(args);
		assert.equal(result.status, 2, args.join(" "));
		assert.match(result.stderr, /^server-release: USAGE: /);
	}
	assert.deepEqual(t.calls(), []);
});

it("verify refuses a release whose directory has been loosened or whose volume mapping disagrees with its metadata", () => {
	const t = setup();
	const release = preserved(t);
	try {
		fs.chmodSync(t.releases, 0o755);
		assert.match(t.run(["verify", release.release]).stderr, /^server-release: RELEASE_ROOT_INVALID: /);
	} finally { fs.chmodSync(t.releases, 0o700); }
	const metaFile = path.join(release.release, "release.json");
	const meta = JSON.parse(read(metaFile));
	meta.volumes.data = { name: restored.data, external: true };
	fs.writeFileSync(metaFile, JSON.stringify(meta));
	assert.match(t.run(["verify", release.release]).stderr, /^server-release: RELEASE_INVALID: /);
});

it("preserve and verify refuse a release directory inside or around the daemon's actual Docker root", () => {
	const t = setup();
	const release = preserved(t);
	const before = t.tags();
	for (const dockerRoot of [t.dir, t.releases, path.join(t.releases, "docker")]) {
		t.writePlan({ ...healthyPlan(t.policy), info: { stdout: dockerRoot + "\n" } });
		const preservedAgain = t.preserve(t.snapshot().dir);
		assert.equal(preservedAgain.status, 1, dockerRoot);
		assert.match(preservedAgain.stderr, /^server-release: RELEASE_ROOT_INVALID: /, dockerRoot);
		const verified = t.run(["verify", release.release]);
		assert.equal(verified.status, 1, dockerRoot);
		assert.match(verified.stderr, /^server-release: RELEASE_ROOT_INVALID: /, dockerRoot);
		assert.equal(verified.stdout, "");
	}
	// The same check through a symlink to the release directory's parent.
	const link = path.join(t.dir, "docker-link");
	fs.symlinkSync(t.dir, link);
	t.writePlan({ ...healthyPlan(t.policy), info: { stdout: link + "\n" } });
	assert.match(t.preserve(t.snapshot().dir).stderr, /^server-release: RELEASE_ROOT_INVALID: /);
	assert.match(t.run(["verify", release.release]).stderr, /^server-release: RELEASE_ROOT_INVALID: /);
	assert.deepEqual(t.tags(), before);
	assert.deepEqual(fs.readdirSync(t.releases), [path.basename(release.release)]);
});

for (const [label, answer] of [
	["docker info fails", { status: 1, stdout: "/srv/docker-root\n", stderr: "synthetic-info-detail" }],
	["docker info prints nothing", { stdout: "" }],
	["docker info prints a relative root", { stdout: "docker-root\n" }],
	["docker info prints more than one line", { stdout: "/srv/docker-root\n/other\n" }],
	["docker info prints an unnormalized root", { stdout: "/srv/../srv/docker-root\n" }],
] as const) {
	it(`preserve and verify fail closed when ${label}`, () => {
		const t = setup();
		const release = preserved(t);
		t.writePlan({ ...healthyPlan(t.policy), info: answer });
		for (const result of [t.preserve(t.snapshot().dir), t.run(["verify", release.release])]) {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /^server-release: DOCKER_FAILED: /);
			assert.ok(!result.stderr.includes("synthetic-info-detail"));
			assert.equal(result.stdout, "");
		}
		assert.equal(Object.keys(t.tags()).length, 3);
		assert.deepEqual(fs.readdirSync(t.releases), [path.basename(release.release)]);
	});
}

// Test-only preload for the CLI process: once a release has been renamed into
// LH_TEST_FAIL_ROOT, opening that directory (to sync it) fails as a disk would.
const failRootSync = path.join(root, "fail-root-sync.mjs");
fs.writeFileSync(failRootSync, `
import fs from "node:fs";
const target = process.env.LH_TEST_FAIL_ROOT;
const open = fs.promises.open;
fs.promises.open = async function (file, flags, ...rest) {
	if (file === target && flags === "r" && fs.readdirSync(target).some((name) => name.startsWith("release-"))) {
		throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
	}
	return open.call(this, file, flags, ...rest);
};
// With LH_TEST_FAIL_WITHDRAW, moving a published release-* directory away fails too.
// The first rename, from .partial-*, still works.
const rename = fs.promises.rename;
fs.promises.rename = async function (from, to) {
	if (process.env.LH_TEST_FAIL_WITHDRAW && String(from).split("/").at(-1).startsWith("release-")) {
		throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
	}
	return rename.call(this, from, to);
};
`);
const syncFails = (t: ReturnType<typeof setup>) => ({ env: { NODE_OPTIONS: `--import ${failRootSync}`, LH_TEST_FAIL_ROOT: t.releases } });

it("preserve withdraws a release it already renamed into place when syncing the directory fails, then removes its tags", () => {
	const t = setup();
	fs.writeFileSync(t.planFile + ".state", JSON.stringify({ tags: { "learnharness:server": ids.app } }));
	const result = t.preserve(t.snapshot().dir, [], syncFails(t));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: INTERNAL: /);
	assert.equal(result.stdout, "");
	assert.deepEqual(fs.readdirSync(t.releases), []);
	assert.deepEqual(t.tags(), { "learnharness:server": ids.app });
	assert.equal(tagCalls(t, "rm").length, 3);
});

it("preserve reports a cleanup failure when withdrawing a renamed release cannot remove its tags", () => {
	const t = setup();
	t.writePlan({ ...healthyPlan(t.policy), "image rm": { status: 1 } });
	const result = t.preserve(t.snapshot().dir, [], syncFails(t));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: RELEASE_CLEANUP_FAILED: /);
	assert.deepEqual(fs.readdirSync(t.releases).filter((name) => name.startsWith("release-")), []);
});

it("preserve keeps every new tag when it cannot withdraw a release it already published", () => {
	const t = setup();
	fs.writeFileSync(t.planFile + ".state", JSON.stringify({ tags: { "learnharness:server": ids.app } }));
	const failing = syncFails(t);
	const result = t.preserve(t.snapshot().dir, [], { env: { ...failing.env, LH_TEST_FAIL_WITHDRAW: "1" } });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^server-release: RELEASE_CLEANUP_FAILED: /);
	assert.equal(result.stdout, "");
	const left = fs.readdirSync(t.releases);
	assert.equal(left.length, 1);
	assert.match(left[0]!, /^release-/);
	assert.deepEqual(tagCalls(t, "rm"), []);
	const tags = t.tags();
	assert.equal(tags["learnharness:server"], ids.app);
	assert.equal(Object.keys(tags).length, 4);
	// The owner reviews it; the retained material itself is intact.
	const verified = t.run(["verify", path.join(t.releases, left[0]!)]);
	assert.equal(verified.status, 0, verified.stderr);
	const release = JSON.parse(verified.stdout) as Release;
	for (const service of ["app", "egress", "demo"] as const) assert.equal(tags[release.images[service].tag], ids[service]);
});
