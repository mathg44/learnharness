#!/usr/bin/env node
/**
 * Docker check for the private server's explicit update and rollback (#30).
 * It replaces a previous image with a candidate on a restored copy of a
 * synthetic profile, then rolls back by restoring the same pre-update
 * snapshot again under the previous image. It drives the real backup CLI
 * (scripts/server-backup.mjs) and reuses the synthetic profile and helpers in
 * scripts/backup/check-fixture.mjs.
 *
 *   node scripts/check-server-updates.mjs PREVIOUS_IMAGE CANDIDATE_IMAGE
 *
 * Both arguments are explicit local disposable tags. The check resolves each
 * to its image ID once, runs only those IDs, and never pulls, builds, tags or
 * pushes. It refuses production tags (any repository named learnharness) and
 * two tags that resolve to the same image.
 *
 * What it does, in order:
 * 1. Seeds the synthetic profile into two new empty volumes with a helper
 *    from PREVIOUS, then boots PREVIOUS in server mode with no network.
 * 2. Takes a pre-update snapshot of the quiet app with the backup CLI,
 *    verifies it and confirms the app's reads did not change.
 * 3. Stops PREVIOUS. Its volumes stay as the retained source copy and are
 *    never mounted writable again; a read-only helper hashes them.
 * 4. Restores the snapshot into new volumes and boots CANDIDATE there with the
 *    snapshot's recorded env. Every application read (chats, chat,
 *    attachment image bytes, image snapshot, jobs, graph, sources, settings,
 *    prompts, custom provider binding) must equal the pre-update read
 *    exactly, etags aside. A candidate that does not become ready or reads
 *    back differently is refused. A legitimate response-shape change is
 *    refused too, until someone reviews it and updates this check; reads are
 *    never normalized to make them match.
 * 5. Writes a candidate-only folder through the app's route, restarts the
 *    candidate and expects the write to survive while the source copy stays
 *    byte-identical.
 * 6. Stops the candidate, restores the same snapshot again into a third pair
 *    of volumes, and boots PREVIOUS by its image ID there. Its reads must
 *    equal the pre-update reads, the candidate-only folder must be absent,
 *    its mounts must be exactly the restored volumes plus the read-only
 *    policy, and it must be the only running container using them.
 *
 * Rollback here means restoring the pre-update snapshot under the previous
 * image. Nothing the candidate wrote comes back, and the check never runs the
 * previous image on data the candidate touched. It does not test or claim an
 * automatic downgrade. If the candidate is refused, the rollback phase still
 * runs, and the check still exits nonzero.
 *
 * Isolation: every container runs --network none, --read-only, as 1000:1000,
 * with all capabilities dropped, no-new-privileges, tmpfs /tmp and no
 * published ports. Apps get the synthetic egress policy as a read-only bind
 * and nothing else from the host. They start with
 * `--entrypoint node /app/server.js`, which skips the production egress-guard
 * check. That is safe here only because nothing has a network. Never start a
 * real or recovered server that way.
 *
 * Cleanup removes only what this run created: containers and volumes named
 * `lh-update-check-<uuid>-*` that carry this run's label, and restore volumes
 * the CLI returned (prefix lh-restore-, label learnharness.restore). It runs
 * on success, failure, SIGINT and SIGTERM. Output and evidence hold check
 * names, statuses and counts only, never record contents, credentials or
 * Docker output. Evidence goes to a private (0700) directory,
 * LH_UPDATE_CHECK_EVIDENCE_DIR or ~/lh-update-check-evidence, as <run>.json
 * (0600).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	CONTAINER_SCRIPT, CUSTOM_BASE, LOGIN, MODEL, ORIGIN, SEED_SCRIPT, projection, readRequests, syntheticProfile,
} from "./backup/check-fixture.mjs";
import { APP_CACHE, CHILD_ENV, HARDENED, isolated, serverCheckEnv } from "./backup/check-runtime.mjs";

const USAGE = "Usage: node scripts/check-server-updates.mjs PREVIOUS_IMAGE CANDIDATE_IMAGE   (explicit local disposable image tags)";
const args = process.argv.slice(2);
if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) {
	console.error(USAGE);
	process.exit(2);
}
/** The repository's last path part, without registry, tag or digest. */
function repositoryName(reference) {
	const name = reference.split("@")[0];
	const slash = name.lastIndexOf("/");
	const colon = name.lastIndexOf(":");
	return (colon > slash ? name.slice(0, colon) : name).slice(slash + 1);
}
if (args.some((arg) => repositoryName(arg).toLowerCase() === "learnharness")) {
	console.error("Refusing a production learnharness image. Tag disposable images for this check.");
	process.exit(2);
}
if (Number(process.versions.node.split(".")[0]) < 22) {
	console.error("Node 22 or newer is required.");
	process.exit(2);
}
const [previousArg, candidateArg] = args;

const checkout = path.resolve(import.meta.dirname, "..");
const CLI = path.join(checkout, "scripts/server-backup.mjs");
const run = `lh-update-check-${crypto.randomUUID()}`;
const RUN_LABEL = "com.learnharness.update-check.run";
const LABEL = `${RUN_LABEL}=${run}`;
const RESTORE_LABEL = "learnharness.restore";
const POLICY_TARGET = "/etc/learnharness/egress.json";
const CANDIDATE_FOLDER = "candidate-only";
const SOURCE_ENV = serverCheckEnv(ORIGIN);
const CONFIG = JSON.stringify({ origin: ORIGIN, login: LOGIN, port: 3000, customBase: CUSTOM_BASE, model: MODEL });

const owned = { containers: [], volumes: [], restoreVolumes: [], children: new Set() };
const evidence = { run, startedAt: new Date().toISOString(), checks: [], counts: {}, candidate: "not-run", rollback: "not-run" };
const evidenceDir = process.env.LH_UPDATE_CHECK_EVIDENCE_DIR ?? path.join(os.homedir(), "lh-update-check-evidence");
let scratch;
/** Set on SIGINT or SIGTERM. From then on only cleanup may start commands. */
let stopping = false;

/** A failure whose message is safe to print: written here, never taken from Docker or app output. */
class CheckError extends Error {}
function pass(label) {
	evidence.checks.push(label);
	console.log(`ok - ${label}`);
}
function expect(condition, label) {
	if (!condition) throw new CheckError(`check failed: ${label}`);
}

/**
 * Runs a command without a shell. Output is collected, never echoed.
 * `finish` children (the backup CLI) run in their own process group so a
 * terminal Ctrl-C does not kill them halfway; cleanup waits for them instead.
 */
function exec(command, argv, { input, cleanup = false, finish = false } = {}) {
	if (stopping && !cleanup) return Promise.reject(new CheckError("interrupted"));
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, { env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"], detached: finish });
		child.finish = finish;
		child.closed = new Promise((done) => child.on("close", done));
		owned.children.add(child);
		const out = [], err = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
		child.on("error", () => { owned.children.delete(child); reject(new CheckError(`${path.basename(command)} could not be started`)); });
		child.on("close", (status) => {
			owned.children.delete(child);
			resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		});
	});
}
const docker = (argv, options) => exec("docker", argv, options);
async function must(argv, options) {
	const result = await docker(argv, options);
	if (result.status !== 0) throw new CheckError(`docker ${argv.slice(0, 2).join(" ")} failed with exit status ${result.status}`);
	return result;
}
function parsed(text, what) {
	try { return JSON.parse(text); } catch { throw new CheckError(`${what} returned unreadable output`); }
}
/** Restore volumes are recorded as soon as the CLI reports them, so cleanup finds them even if the run stops right after. */
async function cli(...argv) {
	const result = await exec(process.execPath, [CLI, ...argv], { finish: true });
	if (argv[0] === "restore" && result.status === 0) {
		try {
			const { volumes } = JSON.parse(result.stdout);
			for (const name of [volumes?.data, volumes?.auth]) if (typeof name === "string") owned.restoreVolumes.push(name);
		} catch { /* reported by cliJson */ }
	}
	return result;
}
/** The CLI's stderr is one fixed code and message by contract, so it is safe to repeat. */
async function cliJson(...argv) {
	const result = await cli(...argv);
	if (result.status !== 0) throw new CheckError(`server-backup ${argv[0]} failed: ${/server-backup: [A-Z_]+/.exec(result.stderr)?.[0] ?? `exit status ${result.status}`}`);
	return parsed(result.stdout, `server-backup ${argv[0]}`);
}

async function inspect(kind, name) {
	return parsed((await must([kind, "inspect", name])).stdout, `docker ${kind} inspect`)[0];
}
async function resolveImage(reference, which) {
	const result = await docker(["image", "inspect", reference]);
	if (result.status !== 0) throw new CheckError(`${which} is not present locally. This check never pulls or builds images.`);
	const id = parsed(result.stdout, "docker image inspect")[0]?.Id;
	expect(typeof id === "string" && /^sha256:[0-9a-f]{64}$/.test(id), `${which} has a content ID`);
	return id;
}
async function newVolume(suffix) {
	const name = `${run}-${suffix}`;
	owned.volumes.push(name);
	await must(["volume", "create", "--label", LABEL, name]);
	return name;
}

async function inContainer(container, mode, input) {
	const result = await docker(["exec", "-i", container, "node", "-e", CONTAINER_SCRIPT, mode, CONFIG], { input });
	if (result.status !== 0) throw new CheckError(`container helper ${mode} failed in ${container}`);
	return parsed(result.stdout, `container helper ${mode}`);
}
const batch = (container, steps) => inContainer(container, "batch", JSON.stringify(steps));
const readApp = async (container, requests) => projection(await batch(container, requests), requests);
/** The first read whose projection differs, or undefined. Only the read's name is ever reported. */
const firstDifference = (actual, expected, requests) => requests.map((request) => request.name)
	.find((name) => !isDeepStrictEqual(actual[name], expected[name]));
const folderNames = (reads) => (reads.sources.body.organization?.folders ?? []).map((folder) => folder.name);

let helpers = 0;
/** Hashes every file in a pair of volumes from a read-only, networkless helper. */
async function inventoryOf(imageId, volumes) {
	const name = `${run}-inventory-${++helpers}`;
	owned.containers.push(name);
	const result = await docker([
		"run", "--rm", "-i", "--name", name, "--label", LABEL, ...HARDENED,
		"--mount", `type=volume,src=${volumes.data},dst=/data,readonly`, "--mount", `type=volume,src=${volumes.auth},dst=/auth,readonly`,
		"--entrypoint", "node", imageId, "-e", CONTAINER_SCRIPT, "inventory", CONFIG,
	]);
	if (result.status !== 0) throw new CheckError("read-only inventory helper failed");
	return parsed(result.stdout, "inventory helper");
}

class NotReady extends CheckError {}
async function waitReady(container) {
	const deadline = Date.now() + 120_000;
	for (;;) {
		const info = await inspect("container", container);
		if (!info.State.Running) throw new NotReady(`${container} exited before it was ready`);
		const probe = await docker(["exec", "-i", container, "node", "-e", CONTAINER_SCRIPT, "batch", CONFIG], {
			input: JSON.stringify([{ name: "ready", method: "GET", path: "/api/settings" }]),
		});
		if (probe.status === 0) {
			try { if (JSON.parse(probe.stdout)[0]?.status === 200) return; } catch { /* not ready yet */ }
		}
		if (Date.now() > deadline) throw new NotReady(`${container} did not become ready`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

function appArgs({ name, imageId, volumes, env, policyFile, labels = [] }) {
	return [
		"run", "-d", "--name", name, "--label", LABEL, ...labels.flatMap((label) => ["--label", label]),
		...HARDENED, ...APP_CACHE,
		"--mount", `type=volume,src=${volumes.data},dst=/data`, "--mount", `type=volume,src=${volumes.auth},dst=/auth`,
		"--mount", `type=bind,source=${policyFile},target=${POLICY_TARGET},readonly`,
		...env.flatMap((entry) => ["-e", entry]), "--entrypoint", "node", imageId, "/app/server.js",
	];
}
async function startApp(options) {
	owned.containers.push(options.name);
	await must(appArgs(options));
	await waitReady(options.name);
	return inspect("container", options.name);
}
async function stopApp(name) {
	await must(["stop", "-t", "30", name]);
	expect(!(await inspect("container", name)).State.Running, `${name} stopped`);
}

/** Exactly the two volumes read-write and the policy read-only, nothing else. */
function exactMounts(info, volumes, policyFile) {
	const actual = info.Mounts.map((mount) => [mount.Destination, mount.Type, mount.Type === "volume" ? mount.Name : mount.Source, mount.RW]).sort();
	const wanted = [["/auth", "volume", volumes.auth, true], ["/data", "volume", volumes.data, true], [POLICY_TARGET, "bind", policyFile, false]];
	return isDeepStrictEqual(actual, wanted);
}
async function runningIds(filter) {
	return (await must(["ps", "-q", "--no-trunc", "--filter", filter])).stdout.split("\n").filter(Boolean).sort();
}
/** The app is the only running container of this run and the only one using its volumes. */
async function soleWriter(info, volumes) {
	const users = await Promise.all([volumes.data, volumes.auth].map((name) => runningIds(`volume=${name}`)));
	const ours = await runningIds(`label=${LABEL}`);
	return users.every((ids) => isDeepStrictEqual(ids, [info.Id])) && isDeepStrictEqual(ours, [info.Id]);
}

/** Restores the snapshot into new labeled volumes through the CLI. */
async function restore(snapshot, earlier) {
	const restored = await cliJson("restore", snapshot);
	const volumes = { data: restored.volumes?.data, auth: restored.volumes?.auth };
	const names = Object.values(volumes);
	expect(names.every((name) => typeof name === "string" && name.startsWith("lh-restore-")) && names[0] !== names[1], "restore returns two new lh-restore- volumes");
	expect(names.every((name) => !earlier.includes(name)), "restore volumes differ from every earlier volume");
	const labels = await Promise.all(names.map(async (name) => (await inspect("volume", name)).Labels?.[RESTORE_LABEL]));
	expect(labels[0] && labels[0] === labels[1], `restore volumes carry one ${RESTORE_LABEL} label`);
	expect(restored.runtimeFile === path.join(snapshot, "runtime.json"), "runtime metadata is the snapshot's runtime.json");
	const runtime = parsed(fs.readFileSync(restored.runtimeFile, "utf8"), "runtime.json");
	return { volumes, imageId: restored.imageId, runtime };
}

function hashTree(directory) {
	const files = [];
	const visit = (relative) => {
		const absolute = path.join(directory, relative);
		const stat = fs.lstatSync(absolute);
		if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
		else files.push([relative, stat.mode & 0o7777, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
	};
	visit(".");
	return files;
}

async function main() {
	const previousId = await resolveImage(previousArg, "PREVIOUS_IMAGE");
	const candidateId = await resolveImage(candidateArg, "CANDIDATE_IMAGE");
	if (previousId === candidateId) throw new CheckError("PREVIOUS_IMAGE and CANDIDATE_IMAGE resolve to the same image. An update check needs two different images.");
	pass("resolved PREVIOUS_IMAGE and CANDIDATE_IMAGE to local image IDs; only those IDs run");

	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-update-check-"));
	const backups = path.join(scratch, "backups");
	fs.mkdirSync(backups, { mode: 0o700 });
	const policyFile = path.join(scratch, "egress.json");
	fs.writeFileSync(policyFile, JSON.stringify({ version: 1, profile: "app", denyCidrs: ["0.0.0.0/0", "::/0"] }) + "\n", { mode: 0o600 });
	const envFile = path.join(scratch, "server.env");
	fs.writeFileSync(envFile, `LH_SERVER_ORIGIN=${ORIGIN}\nLH_EGRESS_POLICY_FILE=${policyFile}\n`, { mode: 0o600 });
	const project = run;

	// ── previous app on the synthetic source profile ──
	const profile = syntheticProfile({
		key: `synthetic-${crypto.randomBytes(12).toString("hex")}`,
		bindingId: crypto.randomBytes(16).toString("hex"),
		hostId: `urn:uuid:${crypto.randomUUID()}`,
	});
	const requests = readRequests(profile.snapshotId);
	const source = { data: await newVolume("source-data"), auth: await newVolume("source-auth") };
	const seedName = `${run}-seed`;
	owned.containers.push(seedName);
	await must([
		"run", "--rm", "-i", "--name", seedName, "--label", LABEL, ...HARDENED,
		"--mount", `type=volume,src=${source.data},dst=/data`, "--mount", `type=volume,src=${source.auth},dst=/auth`,
		"--entrypoint", "node", previousId, "-e", SEED_SCRIPT, "/data", "/auth",
	], { input: JSON.stringify(profile.files) });
	pass("seeded the synthetic profile into new empty volumes with a helper from PREVIOUS_IMAGE");

	const sourceName = `${run}-previous`;
	const sourceInfo = await startApp({
		name: sourceName, imageId: previousId, volumes: source, env: SOURCE_ENV, policyFile,
		labels: [`com.docker.compose.project=${project}`, "com.docker.compose.service=app"],
	});
	expect(sourceInfo.Image === previousId, "previous app runs PREVIOUS_IMAGE's ID");
	expect(isolated(sourceInfo), "previous app is isolated");
	expect(exactMounts(sourceInfo, source, policyFile), "previous app mounts only its volumes and the read-only policy");
	expect(await soleWriter(sourceInfo, source), "previous app is the only writer");
	const initial = await readApp(sourceName, requests);
	expect(Object.values(initial).every((read) => read.status === 200), "every previous read answers 200");
	expect(initial.chats.body.chats?.[0]?.pendingQuestion === true, "seeded chat waits on a question");
	expect(initial.jobs.body.jobs?.[0]?.delivery?.status === "pending" && initial.jobs.body.turnInFlight === false, "seeded job keeps its pending delivery");
	const attachments = initial.chat.body.attachments ?? {};
	expect(attachments.att_text?.text && attachments.att_pdf?.text && initial["attachment-image"].contentType === "image/png", "processed attachments read back");
	expect(initial["snapshot-image"].body.mimeType === "image/png", "image snapshot reads back");
	expect(initial.graph.body.propositions?.length === 2 && initial.graph.body.chains?.length === 1, "graph reads back");
	expect(initial.provider.body.keyPresent === true && initial.provider.body.keySource === "file" && initial.provider.body.keyReuseRequired === false, "custom endpoint key is bound");
	expect(initial.prompts.body.teacher?.some((segment) => segment.enabled && segment.overrideText), "prompt override is enabled");
	expect(!folderNames(initial).includes(CANDIDATE_FOLDER), "no candidate-only folder yet");
	pass("PREVIOUS_IMAGE serves the seeded chat, attachments, snapshot, job, graph, settings, prompts and provider binding, with no network");

	// ── quiet pre-update snapshot ──
	const preUpdate = await cliJson("create", "--env-file", envFile, "--directory", backups, "--project", project, "--kind", "pre-update");
	expect(preUpdate.kind === "pre-update" && path.dirname(preUpdate.snapshot) === backups, "create reports a pre-update snapshot");
	const verified = await cliJson("verify", preUpdate.snapshot);
	expect(isDeepStrictEqual(verified, { snapshot: preUpdate.snapshot, kind: "pre-update", createdAt: preUpdate.createdAt }), "verify accepts the pre-update snapshot");
	const quiet = await readApp(sourceName, requests);
	expect(isDeepStrictEqual(quiet, initial), "previous reads are unchanged by the capture");
	const snapshotFiles = hashTree(preUpdate.snapshot);
	pass("took and verified a pre-update snapshot of the quiet previous app");

	await stopApp(sourceName);
	expect((await runningIds(`volume=${source.data}`)).length === 0 && (await runningIds(`volume=${source.auth}`)).length === 0, "nothing runs on the source volumes");
	const sourceFiles = await inventoryOf(previousId, source);
	evidence.counts.sourceFiles = sourceFiles.length;
	pass(`stopped PREVIOUS_IMAGE; the retained source copy holds ${sourceFiles.length} files and stays unmounted`);

	// ── candidate on restored volumes ──
	const used = [source.data, source.auth];
	const forCandidate = await restore(preUpdate.snapshot, used);
	used.push(forCandidate.volumes.data, forCandidate.volumes.auth);
	expect(forCandidate.imageId === previousId && forCandidate.runtime.imageId === previousId, "snapshot records PREVIOUS_IMAGE's ID");
	expect(isDeepStrictEqual(forCandidate.runtime.env, sourceInfo.Config.Env), "snapshot records the previous app's env");
	const candidateName = `${run}-candidate`;
	let candidateFailure;
	try {
		let candidateInfo;
		try {
			candidateInfo = await startApp({ name: candidateName, imageId: candidateId, volumes: forCandidate.volumes, env: forCandidate.runtime.env, policyFile });
		} catch (error) {
			if (error instanceof NotReady) throw new CheckError("candidate refused: it did not become ready on the restored profile");
			throw error;
		}
		expect(candidateInfo.Image === candidateId, "candidate runs CANDIDATE_IMAGE's ID");
		expect(isolated(candidateInfo), "candidate is isolated");
		expect(exactMounts(candidateInfo, forCandidate.volumes, policyFile), "candidate mounts only the restored volumes and the read-only policy");
		expect(forCandidate.runtime.env.every((entry) => candidateInfo.Config.Env.includes(entry)), "candidate runs with the snapshot's env");
		expect(await soleWriter(candidateInfo, forCandidate.volumes), "candidate is the only writer");
		const candidateReads = await readApp(candidateName, requests);
		const mismatch = firstDifference(candidateReads, quiet, requests);
		if (mismatch) throw new CheckError(`candidate refused: candidate read mismatch: ${mismatch}`);
		evidence.counts.candidateReads = requests.length;
		pass(`CANDIDATE_IMAGE booted on restored volumes with the snapshot's env; all ${requests.length} reads equal the pre-update reads`);

		const write = await batch(candidateName, [{ name: "write", method: "POST", path: "/api/graph/sources", json: { action: "create-folder", name: CANDIDATE_FOLDER, parentId: null } }]);
		expect(write[0]?.status === 200, "candidate accepts a write");
		const written = await readApp(candidateName, requests);
		expect(folderNames(written).includes(CANDIDATE_FOLDER), "candidate reads its write back");
		const startedAt = candidateInfo.State.StartedAt;
		await must(["stop", "-t", "30", candidateName]);
		await must(["start", candidateName]);
		try { await waitReady(candidateName); } catch (error) {
			if (error instanceof NotReady) throw new CheckError("candidate refused: it did not become ready after a restart");
			throw error;
		}
		const restarted = await inspect("container", candidateName);
		expect(restarted.State.StartedAt !== startedAt && restarted.Image === candidateId, "candidate restarted as a new process of the same image");
		const afterRestart = await readApp(candidateName, requests);
		expect(isDeepStrictEqual(afterRestart, written), "candidate write survives the restart; every read is unchanged");
		expect(isDeepStrictEqual(await inventoryOf(previousId, source), sourceFiles), "source copy is unchanged by the candidate");
		pass("candidate-only write survived a candidate restart; the source copy is byte-identical");
		evidence.candidate = "accepted";
	} catch (error) {
		candidateFailure = error;
		evidence.candidate = "refused";
	}
	if ((await docker(["container", "inspect", candidateName])).status === 0) await stopApp(candidateName);

	// ── rollback: the same snapshot again, previous image, new volumes ──
	evidence.rollback = "fail";
	const forRollback = await restore(preUpdate.snapshot, used);
	expect(forRollback.imageId === previousId, "rollback restore names PREVIOUS_IMAGE's ID");
	const rollbackName = `${run}-rollback`;
	const rollbackInfo = await startApp({ name: rollbackName, imageId: forRollback.imageId, volumes: forRollback.volumes, env: forRollback.runtime.env, policyFile });
	expect(rollbackInfo.Image === previousId, "rollback runs PREVIOUS_IMAGE's ID");
	expect(isolated(rollbackInfo), "rollback app is isolated");
	expect(exactMounts(rollbackInfo, forRollback.volumes, policyFile), "rollback app mounts only its restored volumes and the read-only policy");
	expect(isDeepStrictEqual([...rollbackInfo.Config.Env].sort(), [...sourceInfo.Config.Env].sort()), "rollback app runs with the previous app's env");
	expect(await soleWriter(rollbackInfo, forRollback.volumes), "rollback app is the only running writer");
	const rollbackReads = await readApp(rollbackName, requests);
	const rollbackMismatch = firstDifference(rollbackReads, quiet, requests);
	expect(!rollbackMismatch, `rollback read equals the pre-update read: ${rollbackMismatch}`);
	expect(!folderNames(rollbackReads).includes(CANDIDATE_FOLDER), "candidate-only folder is absent after rollback");
	evidence.counts.rollbackReads = requests.length;
	pass(`rollback: PREVIOUS_IMAGE booted on a second restore of the pre-update snapshot; all ${requests.length} reads equal the pre-update reads and the candidate-only write is absent`);

	await stopApp(rollbackName);
	expect(isDeepStrictEqual(await inventoryOf(previousId, source), sourceFiles), "source copy is unchanged after rollback");
	expect(isDeepStrictEqual(hashTree(preUpdate.snapshot), snapshotFiles), "pre-update snapshot files are unchanged");
	expect(isDeepStrictEqual(await cliJson("verify", preUpdate.snapshot), verified), "pre-update snapshot still verifies");
	pass("the source copy and the pre-update snapshot are unchanged by the candidate and the rollback");
	evidence.rollback = "pass";
	if (candidateFailure) throw candidateFailure;
}

let cleaning;
function cleanup() {
	cleaning ??= (async () => {
		const problems = [];
		stopping = true;
		// A backup CLI run finishes, so any restore volumes it makes are reported and recorded.
		const finishing = [...owned.children].filter((child) => child.finish).map((child) => child.closed);
		for (const child of owned.children) if (!child.finish) child.kill("SIGKILL");
		await Promise.race([Promise.all(finishing), new Promise((resolve) => setTimeout(resolve, 120_000).unref())]);
		for (const child of owned.children) child.kill("SIGKILL");
		await new Promise((resolve) => setImmediate(resolve));
		const docker = (argv) => exec("docker", argv, { cleanup: true });
		for (const name of [...owned.containers].reverse()) {
			const info = await docker(["container", "inspect", name]).catch(() => ({ status: 1 }));
			if (info.status !== 0) continue; // never created, or --rm already removed it
			let labels;
			try { labels = JSON.parse(info.stdout)[0]?.Config?.Labels; } catch { /* treated as unlabeled */ }
			if (labels?.[RUN_LABEL] !== run) { problems.push(`not removing unlabeled container ${name}`); continue; }
			if ((await docker(["rm", "-f", name])).status !== 0) problems.push(`could not remove container ${name}`);
		}
		for (const [names, owns] of [
			[owned.volumes, (labels) => labels?.[RUN_LABEL] === run],
			[owned.restoreVolumes, (labels, name) => name.startsWith("lh-restore-") && Boolean(labels?.[RESTORE_LABEL])],
		]) {
			for (const name of names) {
				const info = await docker(["volume", "inspect", name]).catch(() => ({ status: 1 }));
				if (info.status !== 0) continue;
				let labels;
				try { labels = JSON.parse(info.stdout)[0]?.Labels; } catch { /* treated as unlabeled */ }
				if (!owns(labels, name)) { problems.push(`not removing unexpected volume ${name}`); continue; }
				if ((await docker(["volume", "rm", name])).status !== 0) problems.push(`could not remove volume ${name}`);
			}
		}
		if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		if (scratch && fs.existsSync(scratch)) problems.push("scratch directory survived cleanup");
		return problems;
	})();
	return cleaning;
}

/** Writes the evidence into a canonical directory of mode exactly 0700 owned by this user, creating it if needed. */
function writeEvidence() {
	fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(evidenceDir);
	if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(evidenceDir) !== path.resolve(evidenceDir)) {
		console.error("Evidence directory must be a real directory owned by this user with mode 0700. No evidence written.");
		return undefined;
	}
	const file = path.join(evidenceDir, `${run}.json`);
	fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	return file;
}

/** Cleans up once and writes the evidence once, however the run ends. */
let finishing;
function finish() {
	finishing ??= (async () => {
		const problems = await cleanup();
		if (problems.length) {
			evidence.cleanup = problems;
			for (const problem of problems) console.error(problem);
		}
		evidence.finishedAt = new Date().toISOString();
		let file;
		try { file = writeEvidence(); } catch { console.error("Could not write evidence."); }
		console.log(`${evidence.result}${file ? `: evidence in ${file}` : ""}`);
		return problems.length === 0 && Boolean(file);
	})();
	return finishing;
}

let signalled = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
	process.once(signal, async () => {
		signalled = true;
		console.error(`${signal}: removing this run's resources`);
		evidence.result = "interrupted";
		delete evidence.failure;
		await finish();
		process.exit(code);
	});
}

try {
	await main();
	evidence.result = "pass";
} catch (error) {
	if (!signalled) {
		evidence.result = "fail";
		evidence.failure = error instanceof CheckError ? error.message : `unexpected failure (${error?.name ?? "error"})`;
		console.error(evidence.failure);
	}
	process.exitCode = 1;
}
// After a signal the handler finishes and exits with the signal's code.
if (!signalled && !(await finish())) process.exitCode = 1;
