#!/usr/bin/env node
/**
 * Docker smoke for the private server's online backups (#29). It drives the
 * real host CLI (scripts/server-backup.mjs) against disposable containers
 * built from an owner-built image, then boots each restored profile and
 * compares what the app serves.
 *
 *   node scripts/check-server-backups.mjs IMAGE
 *
 * IMAGE is a disposable image built from the current source. The check runs
 * it by image ID and never tags, pulls or pushes anything.
 *
 * What it does, in order:
 * 1. Seeds a synthetic profile into two new volumes with a helper from the
 *    same image, then boots the app in server mode with no network.
 * 2. Refuses a capture from an app without a capture socket and from an
 *    absent project; neither may publish anything.
 * 3. Fills the source app's /tmp until ENOSPC through one check-owned file,
 *    expects the capture to fail with nothing published while the app keeps
 *    answering, removes only that file and expects the retry to succeed.
 * 4. Takes a daily snapshot while a writer loop mutates source organization,
 *    appearance and the custom endpoint binding through the app's routes.
 * 5. Takes a pre-update snapshot from the quiet app.
 * 6. Restores each into new volumes, boots each restored profile and checks
 *    chats, attachments, image snapshots, jobs, graph, organization,
 *    settings, prompts and the custom endpoint binding. The quiet snapshot
 *    must read back exactly; the busy one must read back coherently.
 * 7. Writes to a restored profile and confirms the source files are untouched.
 * 8. Refuses a corrupted archive and a missing archive.
 *
 * Isolation: every container runs --network none, --read-only, as 1000:1000,
 * with all capabilities dropped, no-new-privileges, tmpfs /tmp and no
 * published ports. The source app gets the synthetic egress policy as a
 * read-only bind and nothing else from the host. The apps start with
 * `--entrypoint node /app/server.js`, which skips the production egress-guard
 * check. That is safe here only because nothing has a network. Never start a
 * real or recovered server that way.
 *
 * Cleanup removes only what this run created: containers and volumes named
 * `lh-backup-check-<uuid>-*` that carry this run's label, and restore volumes
 * the CLI returned (prefix lh-restore-, label learnharness.restore). It runs
 * on success, failure, SIGINT and SIGTERM. Evidence holds check names and
 * statuses only. It goes to LH_BACKUP_CHECK_EVIDENCE or
 * ~/lh-backup-check-evidence-<time>.json.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
	CONTAINER_SCRIPT, CUSTOM_BASE, FILL_NAME, LOGIN, MODEL, ORIGIN, SEEDED_READS, SEED_SCRIPT, WRITER_FOLDER,
	projection, readRequests, syntheticProfile,
} from "./backup/check-fixture.mjs";

const checkout = path.resolve(import.meta.dirname, "..");
const CLI = path.join(checkout, "scripts/server-backup.mjs");
const [imageArg, ...extra] = process.argv.slice(2);
if (!imageArg || extra.length || imageArg.startsWith("-")) {
	console.error("Usage: node scripts/check-server-backups.mjs IMAGE   (a disposable image built from the current source)");
	process.exit(2);
}
if (/^learnharness:/.test(imageArg)) {
	console.error("Refusing a production tag. Build a disposable image for this check.");
	process.exit(2);
}
if (Number(process.versions.node.split(".")[0]) < 22) {
	console.error("Node 22 or newer is required.");
	process.exit(2);
}

const run = `lh-backup-check-${crypto.randomUUID()}`;
const RUN_LABEL = "com.learnharness.backup-check.run";
const LABEL = `${RUN_LABEL}=${run}`;
const RESTORE_LABEL = "learnharness.restore";
const SOURCE_ENV = ["LH_SERVER_MODE=tailscale", `LH_SERVER_ORIGIN=${ORIGIN}`, "LH_DATA_DIR=/data", "LH_AUTH_FILE=/auth/auth.json", "LH_IGNORE_ENV_KEYS=1"];
const HARDENED = [
	"--pull", "never", "--network", "none", "--read-only", "--user", "1000:1000",
	"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
	"--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
];
const APP_CACHE = ["--tmpfs", "/app/.next/cache:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700"];
const CONFIG = JSON.stringify({ origin: ORIGIN, login: LOGIN, port: 3000, customBase: CUSTOM_BASE, model: MODEL });
// Docker and the CLI see only what they need to reach the daemon, never provider variables.
const CHILD_ENV = Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]
	.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));

const owned = { containers: [], volumes: [], restoreVolumes: [], children: new Set() };
const evidence = { run, startedAt: new Date().toISOString(), checks: [] };
const evidenceFile = process.env.LH_BACKUP_CHECK_EVIDENCE
	?? path.join(os.homedir(), `lh-backup-check-evidence-${evidence.startedAt.replace(/[:.]/g, "-")}.json`);
let scratch;

function pass(label) {
	evidence.checks.push(label);
	console.log(`ok - ${label}`);
}
function expect(condition, label) {
	if (!condition) throw new Error(`check failed: ${label}`);
}

/** Runs a command without a shell. Output is collected, never echoed. */
function exec(command, args, { input } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] });
		owned.children.add(child);
		const out = [], err = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
		child.on("error", reject);
		child.on("close", (status) => {
			owned.children.delete(child);
			resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		});
	});
}
const docker = (args, options) => exec("docker", args, options);
async function must(args, options) {
	const result = await docker(args, options);
	if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed with ${result.status}: ${result.stderr.trim().split("\n")[0]?.slice(0, 200)}`);
	return result;
}
const cli = (...args) => exec(process.execPath, [CLI, ...args]);
async function cliJson(...args) {
	const result = await cli(...args);
	if (result.status !== 0) throw new Error(`server-backup ${args[0]} failed: ${result.stderr.trim()}`);
	return JSON.parse(result.stdout);
}

async function inspect(kind, name) {
	return JSON.parse((await must([kind, "inspect", name])).stdout)[0];
}
async function newVolume(suffix) {
	const name = `${run}-${suffix}`;
	owned.volumes.push(name);
	await must(["volume", "create", "--label", LABEL, name]);
	return name;
}

async function inContainer(container, mode, input, ...args) {
	const result = await docker(["exec", "-i", container, "node", "-e", CONTAINER_SCRIPT, mode, CONFIG, ...args], { input });
	if (result.status !== 0) throw new Error(`container helper ${mode} failed in ${container}`);
	return JSON.parse(result.stdout);
}
const inventory = (container) => inContainer(container, "inventory");
const batch = (container, steps) => inContainer(container, "batch", JSON.stringify(steps));

async function readApp(container, requests) {
	return projection(await batch(container, requests), requests);
}

async function waitReady(container) {
	const deadline = Date.now() + 120_000;
	for (;;) {
		const info = await inspect("container", container);
		if (!info.State.Running) throw new Error(`${container} exited with ${info.State.ExitCode}`);
		const probe = await docker(["exec", "-i", container, "node", "-e", CONTAINER_SCRIPT, "batch", CONFIG], {
			input: JSON.stringify([{ name: "ready", method: "GET", path: "/api/settings" }]),
		});
		if (probe.status === 0 && JSON.parse(probe.stdout)[0]?.status === 200) return;
		if (Date.now() > deadline) throw new Error(`${container} did not become ready`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

async function startApp({ name, imageId, data, auth, env, labels = [], mounts = [] }) {
	owned.containers.push(name);
	await must([
		"run", "-d", "--name", name, "--label", LABEL, ...labels.flatMap((label) => ["--label", label]),
		...HARDENED, ...APP_CACHE, "-v", `${data}:/data`, "-v", `${auth}:/auth`, ...mounts,
		...env.flatMap((entry) => ["-e", entry]), "--entrypoint", "node", imageId, "/app/server.js",
	]);
	await waitReady(name);
	return inspect("container", name);
}

/** The container really has no network, no host ports, no extra privileges and no Docker socket. */
function isolated(info) {
	const host = info.HostConfig;
	return host.NetworkMode === "none"
		&& Object.keys(info.NetworkSettings?.Networks ?? {}).every((network) => network === "none")
		&& Object.keys(host.PortBindings ?? {}).length === 0 && !host.PublishAllPorts
		&& host.ReadonlyRootfs === true && host.CapDrop?.includes("ALL") && !(host.CapAdd?.length)
		&& host.SecurityOpt?.includes("no-new-privileges") && info.Config.User === "1000:1000" && !host.Privileged
		&& info.Mounts.every((mount) => !String(mount.Source).includes("docker.sock"));
}
const mountOf = (info, target) => info.Mounts.find((mount) => mount.Destination === target);
const lifetime = (info) => ({ pid: info.State.Pid, startedAt: info.State.StartedAt, restarts: info.RestartCount, running: info.State.Running });

function startWriter(container) {
	const child = spawn("docker", ["exec", "-i", container, "node", "-e", CONTAINER_SCRIPT, "writer", CONFIG], { env: CHILD_ENV, stdio: ["pipe", "pipe", "ignore"] });
	owned.children.add(child);
	child.stdin.on("error", () => {});
	let ticks = 0, summary, firstTick;
	const ticked = new Promise((resolve) => { firstTick = resolve; });
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		const message = JSON.parse(line);
		if (message.tick) { ticks = message.tick; firstTick(); } else summary = message;
	});
	const closed = new Promise((resolve) => child.on("close", (status) => { owned.children.delete(child); firstTick(); resolve(status); }));
	return {
		ticked, ticks: () => ticks,
		async stop() {
			child.stdin.end();
			const status = await closed;
			if (status !== 0 || !summary) throw new Error("writer loop failed");
			return summary;
		},
	};
}

async function restoreVolumesNow() {
	return (await must(["volume", "ls", "-q", "--filter", `label=${RESTORE_LABEL}`])).stdout.split("\n").filter(Boolean).sort();
}

/** Restores a snapshot through the CLI and boots it with the recorded image and env. */
async function restoreAndBoot(snapshot, tag, source) {
	const restored = await cliJson("restore", snapshot);
	const volumes = [restored.volumes?.data, restored.volumes?.auth];
	for (const name of volumes) if (typeof name === "string") owned.restoreVolumes.push(name);
	expect(volumes.every((name) => typeof name === "string" && name.startsWith("lh-restore-")) && volumes[0] !== volumes[1], `${tag}: restore returns two new lh-restore- volumes`);
	expect(!volumes.includes(source.data) && !volumes.includes(source.auth), `${tag}: restore volumes differ from the source volumes`);
	const labels = await Promise.all(volumes.map(async (name) => (await inspect("volume", name)).Labels?.[RESTORE_LABEL]));
	expect(labels[0] && labels[0] === labels[1], `${tag}: restore volumes carry one ${RESTORE_LABEL} label`);
	expect(restored.runtimeFile === path.join(snapshot, "runtime.json"), `${tag}: runtime metadata is the snapshot's runtime.json`);
	const runtime = JSON.parse(fs.readFileSync(restored.runtimeFile, "utf8"));
	expect(restored.imageId === source.imageId && runtime.imageId === source.imageId, `${tag}: restore names the source's image`);
	expect(isDeepStrictEqual(runtime.env, source.env), `${tag}: recorded env is the source container's env`);
	const name = `${run}-restored-${tag}`;
	const info = await startApp({ name, imageId: restored.imageId, data: volumes[0], auth: volumes[1], env: runtime.env });
	expect(isolated(info), `${tag}: restored app is isolated`);
	expect(mountOf(info, "/data")?.Name === volumes[0] && mountOf(info, "/auth")?.Name === volumes[1], `${tag}: restored app mounts the restored volumes`);
	pass(`${tag}: restored into new labeled volumes and booted in server mode with the recorded image and env, no network`);
	return { name, volumes };
}

const pick = (reads, names) => Object.fromEntries(names.map((name) => [name, reads[name]]));
const folderNames = (reads) => reads.sources.body.organization.folders.map((folder) => folder.name);
const failureCode = (result, code) => result.status === 1 && result.stdout === "" && result.stderr.includes(`: ${code}:`);

async function main() {
	const image = await inspect("image", imageArg);
	const imageId = image.Id;
	expect(/^sha256:[0-9a-f]{64}$/.test(imageId), "image has a content ID");
	const imageEnv = new Set(image.Config.Env.map((entry) => entry.split("=")[0]));

	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-check-"));
	const backups = path.join(scratch, "backups");
	fs.mkdirSync(backups, { mode: 0o700 });
	const policyFile = path.join(scratch, "egress.json");
	fs.writeFileSync(policyFile, JSON.stringify({ version: 1, profile: "app", denyCidrs: ["0.0.0.0/0", "::/0"] }) + "\n", { mode: 0o600 });
	const envFile = path.join(scratch, "server.env");
	fs.writeFileSync(envFile, `LH_SERVER_ORIGIN=${ORIGIN}\nLH_EGRESS_POLICY_FILE=${policyFile}\n`, { mode: 0o600 });
	const project = run;

	// ── source app ──
	const key = `synthetic-${crypto.randomBytes(12).toString("hex")}`;
	const bindingId = crypto.randomBytes(16).toString("hex");
	const profile = syntheticProfile({ key, bindingId, hostId: `urn:uuid:${crypto.randomUUID()}` });
	const requests = readRequests(profile.snapshotId);
	const data = await newVolume("data");
	const auth = await newVolume("auth");
	const seedName = `${run}-seed`;
	owned.containers.push(seedName);
	await must([
		"run", "--rm", "-i", "--name", seedName, "--label", LABEL, ...HARDENED, "-v", `${data}:/data`, "-v", `${auth}:/auth`,
		"--entrypoint", "node", imageId, "-e", SEED_SCRIPT, "/data", "/auth",
	], { input: JSON.stringify(profile.files) });
	pass("seeded a synthetic profile into new volumes with a helper from the same image");

	const sourceName = `${run}-app`;
	const sourceInfo = await startApp({
		name: sourceName, imageId, data, auth, env: SOURCE_ENV,
		labels: [`com.docker.compose.project=${project}`, "com.docker.compose.service=app"],
		mounts: ["--mount", `type=bind,source=${policyFile},target=/etc/learnharness/egress.json,readonly`],
	});
	expect(isolated(sourceInfo), "source app is isolated");
	const policyMount = mountOf(sourceInfo, "/etc/learnharness/egress.json");
	expect(policyMount?.Type === "bind" && policyMount.Source === policyFile && policyMount.RW === false, "source app mounts the synthetic policy read-only");
	expect(sourceInfo.Mounts.every((mount) => mount.Source !== backups && !String(mount.Source).startsWith(backups + "/") && !backups.startsWith(String(mount.Source) + "/")), "backup root overlaps no source mount");
	expect(SOURCE_ENV.every((entry) => sourceInfo.Config.Env.includes(entry)), "source app runs with the server-mode env");
	expect(sourceInfo.Config.Env.every((entry) => imageEnv.has(entry.split("=")[0]) || SOURCE_ENV.some((own) => own.split("=")[0] === entry.split("=")[0])), "source env has only image and check variables");
	const source = { imageId, env: sourceInfo.Config.Env, data, auth };
	const lifetimeBefore = lifetime(sourceInfo);
	pass("source app is up in tailscale mode with no network, no ports and fresh volumes");

	const initial = await readApp(sourceName, requests);
	expect(Object.values(initial).every((read) => read.status === 200), "every source read answers 200");
	expect(initial.chats.body.chats?.[0]?.pendingQuestion === true, "seeded chat waits on a question");
	expect(initial.jobs.body.jobs?.[0]?.delivery?.status === "pending" && initial.jobs.body.turnInFlight === false, "seeded job keeps its pending delivery and no turn runs");
	const chatAttachments = initial.chat.body.attachments ?? {};
	expect(chatAttachments.att_text?.text && chatAttachments.att_pdf?.text && initial["attachment-image"].contentType === "image/png", "processed text, PDF and image attachments read back");
	expect(initial["snapshot-image"].body.mimeType === "image/png", "image snapshot reads back");
	expect(initial.graph.body.propositions?.length === 2 && initial.graph.body.chains?.length === 1, "graph nodes and chain read back");
	expect(initial.provider.body.keyPresent === true && initial.provider.body.keySource === "file" && initial.provider.body.keyReuseRequired === false, "custom endpoint key is bound to its settings");
	expect(initial.prompts.body.teacher?.some((segment) => segment.enabled && segment.overrideText), "prompt override is enabled");
	pass("source serves the seeded chat, attachments, snapshot, job, graph, organization, settings, prompts and provider binding");

	// ── refusals that must publish nothing ──
	const listing = () => fs.readdirSync(backups).sort();
	const status = await cli("status", "--directory", backups);
	expect(status.status === 1, "status fails with no daily snapshot");
	const deadName = `${run}-nocapture`;
	const deadData = await newVolume("nocapture-data"), deadAuth = await newVolume("nocapture-auth");
	owned.containers.push(deadName);
	await must([
		"run", "-d", "--name", deadName, "--label", LABEL, "--label", `com.docker.compose.project=${project}-nocapture`,
		"--label", "com.docker.compose.service=app", ...HARDENED,
		"-v", `${deadData}:/data`, "-v", `${deadAuth}:/auth`, ...SOURCE_ENV.flatMap((entry) => ["-e", entry]),
		"--mount", `type=bind,source=${policyFile},target=/etc/learnharness/egress.json,readonly`,
		"--entrypoint", "node", imageId, "-e", "setInterval(() => {}, 1 << 30)",
	]);
	expect(isolated(await inspect("container", deadName)), "no-capture container is isolated");
	const sourceFilesBefore = await inventory(sourceName);
	const failed = await cli("create", "--env-file", envFile, "--directory", backups, "--project", `${project}-nocapture`, "--kind", "daily");
	expect(failureCode(failed, "CAPTURE_FAILED"), "create refuses an app without a capture socket");
	const absent = await cli("create", "--env-file", envFile, "--directory", backups, "--project", `${project}-absent`, "--kind", "daily");
	expect(failureCode(absent, "APP_NOT_RUNNING"), "create refuses a project with no app");
	expect(listing().length === 0, "refused captures left nothing in the backup root");
	expect(isDeepStrictEqual(await inventory(sourceName), sourceFilesBefore), "refused captures changed no source file");
	await must(["rm", "-f", deadName]);
	pass("failed and misdirected captures publish nothing and change nothing");

	// ── a real ENOSPC during capture, then a retry ──
	const fillName = `lh-backup-check-fill-${crypto.randomUUID()}`;
	expect(FILL_NAME.test(fillName), "fill name is this check's");
	const filled = await inContainer(sourceName, "fill", "", fillName);
	let unfilled = false;
	try {
		expect(filled.full === true, "source /tmp reached ENOSPC");
		const full = await cli("create", "--env-file", envFile, "--directory", backups, "--project", project, "--kind", "daily");
		expect(failureCode(full, "CAPTURE_FAILED"), "create fails when the app's /tmp is full");
		expect(listing().length === 0, "the ENOSPC failure published nothing");
		const stillUp = await batch(sourceName, [{ name: "settings", method: "GET", path: "/api/settings" }]);
		expect(stillUp[0].status === 200, "source app answers while /tmp is full");
		await inContainer(sourceName, "unfill", "", fillName);
		unfilled = true;
	} finally {
		if (!unfilled) await inContainer(sourceName, "unfill", "", fillName).catch(() => {});
	}
	expect(isDeepStrictEqual(await inContainer(sourceName, "staging"), ["control.sock"]), "the failed capture left no staging copy");
	expect(isDeepStrictEqual(await inventory(sourceName), sourceFilesBefore), "the ENOSPC failure changed no source file");
	const retried = await cliJson("create", "--env-file", envFile, "--directory", backups, "--project", project, "--kind", "daily");
	expect(retried.kind === "daily" && (await cliJson("verify", retried.snapshot)).snapshot === retried.snapshot, "retry after freeing /tmp succeeds and verifies");
	pass(`capture failed on a real ENOSPC (${filled.chunks} chunks), published nothing, the app stayed up, and the retry succeeded`);

	// ── daily snapshot under a writer loop ──
	const writer = startWriter(sourceName);
	await writer.ticked;
	const ticksAtStart = writer.ticks();
	expect(ticksAtStart >= 1, "writer completed a round before the capture");
	const daily = await cliJson("create", "--env-file", envFile, "--directory", backups, "--project", project, "--kind", "daily");
	const ticksAtEnd = writer.ticks();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const written = await writer.stop();
	expect(written.failures.length === 0, "writer routes kept succeeding during the capture");
	expect(ticksAtEnd > ticksAtStart, "writer kept writing while the capture ran");
	pass(`daily snapshot taken while ${ticksAtEnd - ticksAtStart} writer rounds completed during the capture`);

	// ── pre-update snapshot of the quiet app ──
	const quiet = await readApp(sourceName, requests);
	const preUpdate = await cliJson("create", "--env-file", envFile, "--directory", backups, "--project", project, "--kind", "pre-update");
	expect(isDeepStrictEqual(await readApp(sourceName, requests), quiet), "source reads are unchanged by the capture");
	expect(isDeepStrictEqual(pick(quiet, SEEDED_READS), pick(initial, SEEDED_READS)), "seeded records are unchanged by the writer");
	const lifetimeAfter = lifetime(await inspect("container", sourceName));
	expect(isDeepStrictEqual(lifetimeAfter, lifetimeBefore) && lifetimeAfter.running, "source app kept its PID and never restarted");
	pass("both captures ran against the live app: same PID, no restart, reads unchanged");

	// ── CLI results and outer metadata ──
	for (const [snapshot, kind] of [[daily, "daily"], [preUpdate, "pre-update"]]) {
		expect(snapshot.kind === kind && path.dirname(snapshot.snapshot) === backups && typeof snapshot.createdAt === "string", `${kind}: create reports the snapshot`);
		const verified = await cliJson("verify", snapshot.snapshot);
		expect(isDeepStrictEqual(verified, { snapshot: snapshot.snapshot, kind, createdAt: snapshot.createdAt }), `${kind}: verify accepts it`);
		const same = (relative, file) => Buffer.compare(fs.readFileSync(path.join(snapshot.snapshot, relative)), fs.readFileSync(file)) === 0;
		expect(same("config/server.env", envFile) && same("config/egress.json", policyFile), `${kind}: env file and policy are recorded`);
		expect(same("config/compose.yaml", path.join(checkout, "compose.yaml")) && same("config/compose.server.yaml", path.join(checkout, "compose.server.yaml")), `${kind}: compose files are recorded`);
	}
	const health = await cli("status", "--directory", backups);
	const healthJson = health.status === 0 ? JSON.parse(health.stdout) : {};
	expect(healthJson.healthy === true && healthJson.invalid === 0 && healthJson.snapshot === daily.snapshot && healthJson.ageHours < 1, "status reports the fresh daily snapshot");
	pass("verify and status accept both snapshots; env, policy and compose files are recorded");

	// ── restore the quiet snapshot: exact reads, isolated writes ──
	const sourceFiles = await inventory(sourceName);
	const restoredQuiet = await restoreAndBoot(preUpdate.snapshot, "pre-update", source);
	const quietReads = await readApp(restoredQuiet.name, requests);
	expect(isDeepStrictEqual(quietReads, quiet), "pre-update: every restored read equals the source");
	const restoredFiles = await inventory(restoredQuiet.name);
	const write = await batch(restoredQuiet.name, [{ name: "write", method: "POST", path: "/api/graph/sources", json: { action: "create-folder", name: "restored-only", parentId: null } }]);
	expect(write[0].status === 200, "pre-update: restored profile accepts a write");
	expect(!isDeepStrictEqual(await inventory(restoredQuiet.name), restoredFiles), "pre-update: the write landed in the restored files");
	expect(isDeepStrictEqual(await inventory(sourceName), sourceFiles), "source files are unchanged by restored reads and writes");
	expect(!folderNames(await readApp(sourceName, requests)).includes("restored-only"), "source does not see the restored write");
	pass("pre-update restore reads back exactly; its write stays out of the source profile");

	// ── restore the busy snapshot: coherent state ──
	const restoredBusy = await restoreAndBoot(daily.snapshot, "daily", source);
	const busyReads = await readApp(restoredBusy.name, requests);
	expect(isDeepStrictEqual(pick(busyReads, SEEDED_READS), pick(initial, SEEDED_READS)), "daily: seeded records read back exactly");
	const rounds = folderNames(busyReads).map((name) => WRITER_FOLDER.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
	expect(rounds.length >= ticksAtStart && rounds.length <= written.iterations && rounds.every((round, index) => round === index + 1), "daily: writer folders are a complete prefix");
	const provider = busyReads.provider.body;
	expect(provider.keyPresent === true && provider.keySource === "file" && provider.keyReuseRequired === false && provider.baseUrl === CUSTOM_BASE, "daily: auth.json and settings carry the same binding nonce");
	const busyBinding = busyReads.settings.body.settings?.customProvider?.credentialBindingId;
	expect(/^[a-f0-9]{32}$/.test(busyBinding ?? "") && busyBinding !== bindingId, "daily: captured binding is a rotated one");
	expect(provider.models?.some((model) => model.id === MODEL), "daily: custom models survive");
	expect(isDeepStrictEqual(await inventory(sourceName), sourceFiles), "source files are still unchanged");
	pass(`daily restore is coherent: ${rounds.length} complete writer rounds, matching settings/auth nonce`);

	// ── corrupted and missing archives ──
	const restoresBefore = await restoreVolumesNow();
	for (const [label, damage] of [
		["corrupted archive", (copy) => {
			const file = path.join(copy, "profile.tar.gz");
			const bytes = fs.readFileSync(file);
			bytes[Math.floor(bytes.length / 2)] ^= 0xff;
			fs.writeFileSync(file, bytes);
		}],
		["missing archive", (copy) => fs.rmSync(path.join(copy, "profile.tar.gz"))],
	]) {
		let copy;
		do copy = daily.snapshot.replace(/[0-9a-f]{8}$/, crypto.randomBytes(4).toString("hex")); while (fs.existsSync(copy));
		fs.cpSync(daily.snapshot, copy, { recursive: true, errorOnExist: true });
		try {
			damage(copy);
			expect(failureCode(await cli("verify", copy), "SNAPSHOT_INVALID"), `${label}: verify refuses it`);
			const refused = await cli("restore", copy);
			expect(refused.status === 1 && refused.stdout === "", `${label}: restore refuses it`);
		} finally { fs.rmSync(copy, { recursive: true, force: true }); }
	}
	expect(isDeepStrictEqual(await restoreVolumesNow(), restoresBefore), "refused restores created no volumes");
	expect(isDeepStrictEqual(await inventory(sourceName), sourceFiles), "source files are unchanged by refused restores");
	pass("corrupted and missing archives are refused before any volume is created");
}

let cleaning;
function cleanup() {
	cleaning ??= (async () => {
		const problems = [];
		for (const child of owned.children) child.kill("SIGKILL");
		for (const name of owned.containers.reverse()) {
			const info = await docker(["container", "inspect", name]);
			if (info.status !== 0) continue; // never created, or --rm already removed it
			if (JSON.parse(info.stdout)[0]?.Config?.Labels?.[RUN_LABEL] !== run) { problems.push(`not removing unlabeled container ${name}`); continue; }
			if ((await docker(["rm", "-f", name])).status !== 0) problems.push(`could not remove container ${name}`);
		}
		for (const name of owned.volumes) {
			const info = await docker(["volume", "inspect", name]);
			if (info.status !== 0) continue;
			if (JSON.parse(info.stdout)[0]?.Labels?.[RUN_LABEL] !== run) { problems.push(`not removing unlabeled volume ${name}`); continue; }
			if ((await docker(["volume", "rm", name])).status !== 0) problems.push(`could not remove volume ${name}`);
		}
		for (const name of owned.restoreVolumes) {
			const info = await docker(["volume", "inspect", name]);
			if (info.status !== 0) continue;
			if (!name.startsWith("lh-restore-") || !JSON.parse(info.stdout)[0]?.Labels?.[RESTORE_LABEL]) { problems.push(`not removing unexpected volume ${name}`); continue; }
			if ((await docker(["volume", "rm", name])).status !== 0) problems.push(`could not remove volume ${name}`);
		}
		if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		if (scratch && fs.existsSync(scratch)) problems.push("scratch directory survived cleanup");
		return problems;
	})();
	return cleaning;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
	process.once(signal, async () => {
		console.error(`${signal}: removing this run's resources`);
		const problems = await cleanup();
		for (const problem of problems) console.error(problem);
		process.exit(code);
	});
}

try {
	await main();
	evidence.result = "pass";
} catch (error) {
	evidence.result = "fail";
	evidence.failure = String(error?.message ?? error).split("\n")[0];
	console.error(evidence.failure);
	process.exitCode = 1;
} finally {
	const problems = await cleanup();
	if (problems.length) {
		evidence.cleanup = problems;
		for (const problem of problems) console.error(problem);
		process.exitCode = 1;
	}
	evidence.finishedAt = new Date().toISOString();
	fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
	console.log(`${evidence.result}: evidence in ${evidenceFile}`);
}
