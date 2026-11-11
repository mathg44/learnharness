/**
 * Keeps what a rollback of the private server needs (#30): a copy of the
 * verified pre-update snapshot, the exact app, egress and demo images under
 * new retention tags, the recipes and private config they ran with, and a Git
 * archive of the declared source revision. Docker is only read, apart from
 * adding (and on failure removing) those tags.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySnapshot } from "../backup/operator.mjs";

export const DEFAULT_PROJECT = "learnharness";
export const SERVICES = ["app", "egress", "demo"];
const REPOSITORY = { app: "learnharness:server", egress: "learnharness:egress", demo: "learnharness:demo" };
const METADATA = "release.json";
const RUNNING_OVERRIDE = ".running.override.yaml";
export const IMAGES_OVERRIDE = "images.override.yaml";
export const VOLUMES_OVERRIDE = "volumes.override.yaml";
const RECIPES = ["compose.yaml", "compose.server.yaml", "server.env", "egress.json"];
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RELEASE_NAME = /^release-(\d{8}T\d{6}Z)-([0-9a-f]{12})-([0-9a-f]{8})$/;

export class ReleaseError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new ReleaseError(code);
};

const checkout = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Docker's default data root, refused even when the daemon reports another one.
// A release inside it could be pruned with images and volumes.
const DOCKER_ROOT = "/var/lib/docker";
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const realOrSame = (file) => fsp.realpath(file).catch(() => path.resolve(file));

/** A private, real directory owned by this user, clear of every tree named in `avoid`. */
async function validateRoot(directory, avoid) {
	if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("RELEASE_ROOT_INVALID");
	const resolved = path.resolve(directory);
	const stat = await fsp.lstat(resolved).catch(() => fail("RELEASE_ROOT_INVALID"));
	if (!stat.isDirectory() || (await fsp.realpath(resolved)) !== resolved) fail("RELEASE_ROOT_INVALID");
	if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) fail("RELEASE_ROOT_INVALID");
	await checkClear(resolved, [checkout, DOCKER_ROOT, ...avoid]);
	return resolved;
}

/**
 * Where the daemon actually keeps images and volumes. It may be relocated, so
 * the default above is not enough. Any doubt about the answer fails closed.
 */
async function dockerRoot(bin) {
	const result = await exec(bin, ["info", "--format", "{{.DockerRootDir}}"]);
	if (result.status !== 0) fail("DOCKER_FAILED");
	const root = result.text.endsWith("\n") ? result.text.slice(0, -1) : result.text;
	if (!root || /[\n\r\0]/.test(root) || !path.isAbsolute(root) || path.normalize(root) !== root) fail("DOCKER_FAILED");
	return root;
}

async function checkClear(root, trees) {
	for (const tree of trees) {
		if (overlaps(root, path.resolve(tree)) || overlaps(root, await realOrSame(tree))) fail("RELEASE_ROOT_INVALID");
	}
}

async function withLock(root, work) {
	const lock = path.join(root, ".lock");
	const handle = await fsp.open(lock, "wx", 0o600).catch((error) => fail(error.code === "EEXIST" ? "RELEASE_LOCKED" : "RELEASE_ROOT_INVALID"));
	try {
		await handle.writeFile(`${process.pid}\n`);
		await handle.close();
		return await work();
	} finally {
		await fsp.rm(lock, { force: true });
	}
}

const compact = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Runs a command without a shell. Its output is never printed; stdout is collected or handed to `sink`. */
function exec(bin, args, { sink, cwd, env, unavailable = "DOCKER_UNAVAILABLE" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env });
		const out = [];
		child.stderr.resume();
		const consumed = sink ? sink(child.stdout) : (async () => {
			for await (const chunk of child.stdout) out.push(chunk);
		})();
		consumed.catch(() => child.kill());
		child.on("error", () => reject(new ReleaseError(unavailable)));
		child.on("close", (status) => {
			consumed.then((value) => resolve({ status, stdout: Buffer.concat(out), text: Buffer.concat(out).toString("utf8"), value }), reject);
		});
	});
}

async function fsyncDirectory(directory) {
	const handle = await fsp.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Streams chunks into a new private file, hashing as it goes, and syncs it. */
async function writeStream(file, chunks) {
	const handle = await fsp.open(file, "wx", 0o600);
	const hash = crypto.createHash("sha256");
	let size = 0;
	try {
		for await (const chunk of chunks) {
			hash.update(chunk);
			size += chunk.length;
			for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset)).bytesWritten;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { size, sha256: hash.digest("hex") };
}

async function hashFile(file) {
	const hash = crypto.createHash("sha256");
	let size = 0;
	for await (const chunk of fs.createReadStream(file)) {
		hash.update(chunk);
		size += chunk.length;
	}
	return { size, sha256: hash.digest("hex") };
}

async function readJson(file, code) {
	try {
		return JSON.parse(await fsp.readFile(file, "utf8"));
	} catch {
		return fail(code);
	}
}

async function findService(bin, project, service) {
	const listed = await exec(bin, [
		"ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`,
		"--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}",
	]);
	if (listed.status !== 0) fail("DOCKER_FAILED");
	const found = listed.text.split("\n").filter(Boolean);
	if (found.length !== 1 || !/^[0-9a-f]{64}$/.test(found[0])) fail("SERVICE_NOT_RUNNING");
	const inspected = await exec(bin, ["container", "inspect", found[0]]);
	if (inspected.status !== 0) fail("DOCKER_FAILED");
	let container;
	try {
		[container] = JSON.parse(inspected.text);
	} catch {
		fail("DOCKER_FAILED");
	}
	const labels = container?.Config?.Labels;
	const securityOpt = container?.HostConfig?.SecurityOpt ?? [];
	const mounts = container?.Mounts;
	const valid = container?.Id === found[0] && typeof container.Image === "string" && IMAGE_ID.test(container.Image)
		&& typeof container.Config.Image === "string" && labels && typeof labels === "object"
		&& Array.isArray(securityOpt) && securityOpt.every((entry) => typeof entry === "string")
		&& Array.isArray(mounts) && mounts.every((mount) => typeof mount?.Destination === "string");
	if (!valid) fail("DOCKER_FAILED");
	return { id: container.Id, imageId: container.Image, image: container.Config.Image, labels, securityOpt, mounts };
}

// Written into YAML as a JSON string; anything outside a plain image reference is refused rather than escaped.
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[0-9a-f]{64})?$/;
const POLICY_MOUNT = "/etc/learnharness/egress.json";

/** Each container must carry its own project and service labels and a Compose config hash. */
function checkLabels(project, running) {
	for (const service of SERVICES) {
		const { labels, image } = running[service];
		const mismatch = service === "app" ? "SNAPSHOT_MISMATCH" : "CONFIG_MISMATCH";
		if (labels["com.docker.compose.project"] !== project) fail(mismatch);
		if (labels["com.docker.compose.service"] !== service) fail("CONFIG_MISMATCH");
		if (!/^[0-9a-f]{64}$/.test(labels["com.docker.compose.config-hash"] ?? "")) fail("CONFIG_MISMATCH");
		if (!IMAGE_REFERENCE.test(image) || image.length > 255) fail("CONFIG_MISMATCH");
	}
}

/** Key order and spacing don't matter; Docker stores the profile compacted. */
const canonical = (value) => JSON.stringify(value, (key, item) => (item && typeof item === "object" && !Array.isArray(item)
	? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

function checkSeccomp(demo, sourceText) {
	let source;
	try {
		source = JSON.parse(sourceText.toString("utf8"));
	} catch {
		fail("SOURCE_UNSUPPORTED");
	}
	const entries = demo.securityOpt.filter((entry) => entry.startsWith("seccomp="));
	if (entries.length !== 1) fail("SECCOMP_MISMATCH");
	let live;
	try {
		live = JSON.parse(entries[0].slice("seccomp=".length));
	} catch {
		fail("SECCOMP_MISMATCH");
	}
	if (canonical(live) !== canonical(source)) fail("SECCOMP_MISMATCH");
}

/** The app and egress guard must bind the same policy file, still holding the bytes the snapshot copied. */
async function checkPolicy(running, snapshotDir) {
	const sources = ["app", "egress"].map((service) => {
		const mounts = running[service].mounts.filter((mount) => mount.Destination === POLICY_MOUNT);
		return mounts.length === 1 && mounts[0].Type === "bind" && typeof mounts[0].Source === "string" && path.isAbsolute(mounts[0].Source) ? mounts[0].Source : undefined;
	});
	if (!sources[0] || sources[0] !== sources[1]) fail("CONFIG_MISMATCH");
	const live = await fsp.readFile(sources[0]).catch(() => fail("CONFIG_MISMATCH"));
	if (!live.equals(await fsp.readFile(path.join(snapshotDir, "config/egress.json")))) fail("CONFIG_MISMATCH");
}

/** The local image ID `reference` names, or undefined when Docker knows no such image. */
async function imageId(bin, reference) {
	const result = await exec(bin, ["image", "inspect", "--format", "{{.Id}}", reference]);
	return result.status === 0 ? result.text.trim() : undefined;
}

/**
 * Adds one retention tag per image. A tag that already exists is never moved:
 * all are checked first. Each new tag must name its image afterwards. On any
 * failure the tags this call created are removed again.
 */
async function createTags(bin, entries) {
	for (const { tag } of entries) {
		const listed = await exec(bin, ["image", "ls", "-q", "--no-trunc", "--filter", `reference=${tag}`]);
		if (listed.status !== 0) fail("DOCKER_FAILED");
		if (listed.text.trim()) fail("TAG_EXISTS");
	}
	const created = [];
	try {
		for (const entry of entries) {
			const tagged = await exec(bin, ["image", "tag", entry.id, entry.tag]);
			created.push(entry);
			if (tagged.status !== 0 || (await imageId(bin, entry.tag)) !== entry.id) fail("TAG_FAILED");
		}
	} catch (error) {
		await removeTags(bin, created);
		throw error;
	}
	return created;
}

/** Removes only tags that still name the image this run gave them. Never prunes. */
async function removeTags(bin, entries) {
	let failed = false;
	for (const { id, tag } of entries) {
		try {
			if ((await imageId(bin, tag)) !== id) continue;
			if ((await exec(bin, ["image", "rm", "--no-prune", tag])).status !== 0) failed = true;
		} catch {
			failed = true;
		}
	}
	if (failed) fail("RELEASE_CLEANUP_FAILED");
}

const override = (images) => "services:\n" + SERVICES.map((service) => `  ${service}:\n    image: ${JSON.stringify(images[service])}\n`).join("");

/**
 * Runs `docker compose ... config` with the release directory as the project
 * directory, its env file, both recipes, one image override and the volume
 * override. This is the arrangement a rollback starts from. The caller's
 * environment is left out so nothing but these files can interpolate.
 */
async function composeConfig(bin, project, release, imagesFile, args) {
	const result = await exec(bin, [
		"compose", "-p", project, "--project-directory", release, "--env-file", path.join(release, "server.env"),
		"-f", path.join(release, "compose.yaml"), "-f", path.join(release, "compose.server.yaml"),
		"-f", path.join(release, imagesFile), "-f", path.join(release, VOLUMES_OVERRIDE),
		"config", ...args,
	], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/" } });
	if (result.status !== 0) fail("CONFIG_MISMATCH");
	return result.text;
}

async function configHashes(bin, project, release, imagesFile) {
	const text = await composeConfig(bin, project, release, imagesFile, ["--hash", "*"]);
	const hashes = Object.fromEntries(text.split("\n").filter(Boolean).map((line) => line.split(" ")));
	if (!SERVICES.every((service) => /^[0-9a-f]{64}$/.test(hashes[service] ?? ""))) fail("CONFIG_MISMATCH");
	return Object.fromEntries(SERVICES.map((service) => [service, hashes[service]]));
}

/**
 * The live app's /data and /auth must be named volumes, the same ones the
 * snapshot recorded: the project's own or a pair `restore` created. Compose's
 * service hash does not cover a volume's name or external flag, so these
 * mounts are the evidence for the mapping.
 */
function appVolumes(project, app, runtime) {
	const volumes = {};
	for (const [role, destination] of [["data", "/data"], ["auth", "/auth"]]) {
		const live = app.mounts.filter((mount) => mount?.Destination === destination);
		const recorded = runtime.mounts.filter((mount) => mount.destination === destination);
		if (live.length !== 1 || recorded.length !== 1 || live[0].Type !== "volume" || recorded[0].type !== "volume") fail("SNAPSHOT_MISMATCH");
		const name = live[0].Name;
		if (typeof name !== "string" || name !== recorded[0].name) fail("SNAPSHOT_MISMATCH");
		if (name === `${project}_app-${role}`) volumes[role] = { name, external: false };
		else if (new RegExp(`^lh-restore-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-${role}$`).test(name)) volumes[role] = { name, external: true };
		else fail("SNAPSHOT_MISMATCH");
	}
	return volumes;
}

function volumesOverride(volumes) {
	const external = ["data", "auth"].filter((role) => volumes[role].external);
	if (!external.length) return "volumes: {}\n";
	return "volumes:\n" + external.map((role) => `  app-${role}:\n    external: true\n    name: ${JSON.stringify(volumes[role].name)}\n`).join("");
}

/** Compose's own reading of the arrangement must mount exactly those volumes at /data and /auth. */
async function checkVolumeMapping(bin, project, release, volumes) {
	let config;
	try {
		config = JSON.parse(await composeConfig(bin, project, release, IMAGES_OVERRIDE, ["--format", "json"]));
	} catch (error) {
		if (error instanceof ReleaseError) throw error;
		fail("CONFIG_MISMATCH");
	}
	for (const [role, destination] of [["data", "/data"], ["auth", "/auth"]]) {
		const entries = (config?.services?.app?.volumes ?? []).filter((entry) => entry?.target === destination);
		const declared = entries.length === 1 && entries[0].type === "volume" ? config.volumes?.[entries[0].source] : undefined;
		if (declared?.name !== volumes[role].name || (declared.external === true) !== volumes[role].external) fail("CONFIG_MISMATCH");
	}
}

function gitRunner(source) {
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	return (args, options = {}) => exec("git", args, { cwd: source, env, unavailable: "GIT_UNAVAILABLE", ...options });
}

/**
 * The source must be the top of a Git checkout holding `revision` as a full
 * commit ID. Git runs there with every GIT_* variable and the system and
 * global config removed, so only the repository itself decides what it holds.
 */
async function openSource(source, revision) {
	if (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision)) fail("REVISION_INVALID");
	if (typeof source !== "string" || !path.isAbsolute(source)) fail("SOURCE_INVALID");
	const top = await fsp.realpath(source).catch(() => fail("SOURCE_INVALID"));
	if (!(await fsp.stat(top)).isDirectory()) fail("SOURCE_INVALID");
	const git = gitRunner(top);
	if ((await git(["--version"])).status !== 0) fail("GIT_UNAVAILABLE");
	const shown = await git(["rev-parse", "--show-toplevel"]);
	if (shown.status !== 0 || (await fsp.realpath(shown.text.trim()).catch(() => "")) !== top) fail("SOURCE_INVALID");
	const resolved = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
	if (resolved.status !== 0 || resolved.text.trim() !== revision) fail("REVISION_INVALID");
	return { git, top };
}

async function copyTree(from, to) {
	await fsp.mkdir(to, { mode: 0o700 });
	for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
		if (entry.isDirectory()) await copyTree(path.join(from, entry.name), path.join(to, entry.name));
		else if (!entry.isFile()) fail("SNAPSHOT_INVALID");
		else await writeStream(path.join(to, entry.name), fs.createReadStream(path.join(from, entry.name)));
	}
	await fsyncDirectory(to);
}

async function listFiles(directory, prefix = "") {
	const files = [];
	for (const entry of await fsp.readdir(path.join(directory, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await listFiles(directory, relative)));
		else files.push(relative);
	}
	return files.sort();
}

/**
 * Preserves the running deployment of `project` against the pre-update
 * `snapshot` and declared source `revision`, as a new release under `directory`.
 */
export async function preserveRelease({ snapshot, revision, directory, project = DEFAULT_PROJECT, source = process.cwd(), docker: bin = "docker", now = () => new Date() }) {
	if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail("USAGE");
	const verified = await verifySnapshot(snapshot);
	const snapshotDir = verified.snapshot;
	const meta = await readJson(path.join(snapshotDir, "snapshot.json"), "SNAPSHOT_INVALID");
	if (verified.kind !== "pre-update") fail("SNAPSHOT_INVALID");
	if (now().getTime() >= Date.parse(meta.protectedUntil)) fail("SNAPSHOT_EXPIRED");
	const { git, top } = await openSource(source, revision);
	const blob = async (file) => {
		const result = await git(["cat-file", "blob", `${revision}:${file}`]);
		if (result.status !== 0) fail("SOURCE_UNSUPPORTED");
		return result.stdout;
	};
	const seccompSource = await blob("scripts/demo/seccomp.json");
	for (const file of ["compose.yaml", "compose.server.yaml"]) {
		if (!(await blob(file)).equals(await fsp.readFile(path.join(snapshotDir, "config", file)))) fail("SOURCE_MISMATCH");
	}
	const root = await validateRoot(directory, [top, path.dirname(snapshotDir), await dockerRoot(bin)]);
	return withLock(root, () => preserveLocked({ root, bin, project, revision, now, git, snapshotDir, meta, seccompSource }));
}

async function preserveLocked({ root, bin, project, revision, now, git, snapshotDir, meta, seccompSource }) {

	const running = {};
	for (const service of SERVICES) running[service] = await findService(bin, project, service);
	await checkClear(root, SERVICES.flatMap((service) => running[service].mounts.map((mount) => mount.Source).filter((source) => typeof source === "string" && path.isAbsolute(source))));

	const runtime = await readJson(path.join(snapshotDir, "runtime.json"), "SNAPSHOT_INVALID");
	checkLabels(project, running);
	if (runtime.project !== project || running.app.id !== runtime.container || running.app.imageId !== runtime.imageId) fail("SNAPSHOT_MISMATCH");
	checkSeccomp(running.demo, seccompSource);
	await checkPolicy(running, snapshotDir);
	const volumes = appVolumes(project, running.app, runtime);

	const createdAt = now().toISOString();
	const stamp = compact(createdAt);
	const short = revision.slice(0, 12);
	const tags = Object.fromEntries(SERVICES.map((service) => [service, `${REPOSITORY[service]}-${stamp}-${short}`]));

	const staging = path.join(root, `.partial-${crypto.randomUUID()}`);
	const published = path.join(root, `release-${stamp}-${short}-${crypto.randomBytes(4).toString("hex")}`);
	let tagged = [];
	let renamed = false;
	await fsp.mkdir(staging, { mode: 0o700 });
	try {
		for (const file of RECIPES) await writeStream(path.join(staging, file), fs.createReadStream(path.join(snapshotDir, "config", file)));
		await fsp.mkdir(path.join(staging, "scripts/demo"), { recursive: true, mode: 0o700 });
		await writeStream(path.join(staging, "scripts/demo/seccomp.json"), [seccompSource]);
		await writeStream(path.join(staging, VOLUMES_OVERRIDE), [Buffer.from(volumesOverride(volumes))]);
		await writeStream(path.join(staging, RUNNING_OVERRIDE), [Buffer.from(override(Object.fromEntries(SERVICES.map((s) => [s, running[s].image]))))]);
		const live = await configHashes(bin, project, staging, RUNNING_OVERRIDE);
		// A service changed beyond its image, by an override or edited recipe, hashes differently.
		if (!SERVICES.every((service) => live[service] === running[service].labels["com.docker.compose.config-hash"])) fail("CONFIG_MISMATCH");
		await fsp.rm(path.join(staging, RUNNING_OVERRIDE));
		await writeStream(path.join(staging, IMAGES_OVERRIDE), [Buffer.from(override(tags))]);
		const rollbackHashes = await configHashes(bin, project, staging, IMAGES_OVERRIDE);
		await checkVolumeMapping(bin, project, staging, volumes);

		const archived = await git(["archive", "--format=tar", revision], { sink: (stdout) => writeStream(path.join(staging, "source.tar"), stdout) });
		if (archived.status !== 0) fail("SOURCE_UNSUPPORTED");
		await fsp.mkdir(path.join(staging, "snapshot"), { mode: 0o700 });
		await copyTree(snapshotDir, path.join(staging, "snapshot", path.basename(snapshotDir)));

		tagged = await createTags(bin, SERVICES.map((service) => ({ id: running[service].imageId, tag: tags[service] })));

		const files = [];
		for (const file of await listFiles(staging)) files.push({ path: file, ...(await hashFile(path.join(staging, file))) });
		const release = {
			version: 1, createdAt, project, revision, revisionProvenance: "operator-declared",
			snapshot: { name: path.basename(snapshotDir), createdAt: meta.createdAt, protectedUntil: meta.protectedUntil },
			images: Object.fromEntries(SERVICES.map((service) => [service, { id: running[service].imageId, tag: tags[service], running: running[service].image }])),
			volumes,
			configHashes: rollbackHashes,
			files,
		};
		await writeStream(path.join(staging, METADATA), [Buffer.from(JSON.stringify(release, null, "\t") + "\n")]);
		await fsyncDirectory(staging);
		await verifyFiles(staging, path.basename(published));
		// Under the lock no one else publishes here, so an absent name stays absent until the rename.
		if (await fsp.lstat(published).then(() => true, () => false)) fail("INTERNAL");
		await fsp.rename(staging, published);
		renamed = true;
		await fsyncDirectory(root);
		return summary(published, release);
	} catch (error) {
		// Withdraw the directory first, so no release outlives its tags. If that
		// fails the tags stay, keeping whatever is left complete for the owner to review.
		let cleanupFailed = false;
		if (renamed) cleanupFailed = !(await withdraw(root, published));
		else await fsp.rm(staging, { recursive: true, force: true });
		if (tagged.length && !cleanupFailed) {
			try {
				await removeTags(bin, tagged);
			} catch {
				cleanupFailed = true;
			}
		}
		if (cleanupFailed) fail("RELEASE_CLEANUP_FAILED");
		throw error;
	}
}

/** Moves a published release out of the release namespace, then deletes it. Returns whether both worked. */
async function withdraw(root, published) {
	const doomed = path.join(root, `.partial-delete-${crypto.randomUUID()}`);
	try {
		await fsp.rename(published, doomed);
		await fsp.rm(doomed, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

const summary = (release, meta) => ({
	release, revision: meta.revision, createdAt: meta.createdAt, protectedUntil: meta.snapshot.protectedUntil,
	images: Object.fromEntries(SERVICES.map((service) => [service, { id: meta.images[service].id, tag: meta.images[service].tag }])),
});

const isIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const SNAPSHOT_NAME = /^pre-update-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** Every entry must be a real directory (0700) or regular file (0600) owned by this user. Returns the files. */
async function privateTree(directory, prefix = "") {
	const files = [];
	for (const name of await fsp.readdir(path.join(directory, prefix))) {
		const relative = prefix ? `${prefix}/${name}` : name;
		const stat = await fsp.lstat(path.join(directory, relative));
		if (stat.uid !== process.getuid()) fail("RELEASE_INVALID");
		if (stat.isDirectory() && (stat.mode & 0o7777) === 0o700) files.push(...(await privateTree(directory, relative)));
		else if (stat.isFile() && (stat.mode & 0o7777) === 0o600) files.push(relative);
		else fail("RELEASE_INVALID");
	}
	return files;
}

/** Checks the metadata, the exact file set, modes and every hash, and the snapshot copy. Returns the metadata. */
async function verifyFiles(directory, name = path.basename(directory)) {
	const match = RELEASE_NAME.exec(name);
	if (!match) fail("RELEASE_INVALID");
	const stat = await fsp.lstat(directory).catch(() => fail("RELEASE_INVALID"));
	if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid()) fail("RELEASE_INVALID");
	const found = (await privateTree(directory).catch((error) => fail(error instanceof ReleaseError ? error.code : "RELEASE_INVALID"))).sort();
	const meta = await readJson(path.join(directory, METADATA), "RELEASE_INVALID");
	const [, stamp, short] = match;
	const valid = meta?.version === 1 && isIso(meta.createdAt) && compact(meta.createdAt) === stamp
		&& typeof meta.revision === "string" && /^[0-9a-f]{40}$/.test(meta.revision) && meta.revision.startsWith(short)
		&& typeof meta.snapshot?.name === "string" && SNAPSHOT_NAME.test(meta.snapshot.name)
		&& isIso(meta.snapshot.createdAt) && isIso(meta.snapshot.protectedUntil)
		&& SERVICES.every((service) => IMAGE_ID.test(meta.images?.[service]?.id ?? "") && meta.images[service].tag === `${REPOSITORY[service]}-${stamp}-${short}`)
		&& Array.isArray(meta.files) && meta.files.every((file) => typeof file?.path === "string");
	if (!valid) fail("RELEASE_INVALID");
	if (JSON.stringify(found) !== JSON.stringify([...meta.files.map((file) => file.path), METADATA].sort())) fail("RELEASE_INVALID");
	const prefix = `snapshot/${meta.snapshot.name}/`;
	const expected = [...RECIPES, "scripts/demo/seccomp.json", IMAGES_OVERRIDE, VOLUMES_OVERRIDE, "source.tar"];
	if (!expected.every((file) => found.includes(file)) || !found.every((file) => file === METADATA || expected.includes(file) || file.startsWith(prefix))) fail("RELEASE_INVALID");
	for (const file of meta.files) {
		const actual = await hashFile(path.join(directory, file.path));
		if (actual.size !== file.size || actual.sha256 !== file.sha256) fail("RELEASE_INVALID");
	}
	const tags = Object.fromEntries(SERVICES.map((service) => [service, meta.images[service].tag]));
	if ((await fsp.readFile(path.join(directory, IMAGES_OVERRIDE), "utf8")) !== override(tags)) fail("RELEASE_INVALID");
	const volumes = meta.volumes;
	const validVolumes = ["data", "auth"].every((role) => typeof volumes?.[role]?.name === "string" && typeof volumes[role].external === "boolean");
	if (!validVolumes || (await fsp.readFile(path.join(directory, VOLUMES_OVERRIDE), "utf8")) !== volumesOverride(volumes)) fail("RELEASE_INVALID");
	const copy = await verifySnapshot(path.join(directory, "snapshot", meta.snapshot.name)).catch(() => fail("RELEASE_INVALID"));
	const copied = await readJson(path.join(copy.snapshot, "snapshot.json"), "RELEASE_INVALID");
	if (copied.kind !== "pre-update" || copied.createdAt !== meta.snapshot.createdAt || copied.protectedUntil !== meta.snapshot.protectedUntil) fail("RELEASE_INVALID");
	return meta;
}

/** Re-checks a published release. `expired` is true once the snapshot's protection has ended. */
export async function verifyRelease(release, { docker: bin = "docker", now = () => new Date() } = {}) {
	if (typeof release !== "string") fail("RELEASE_INVALID");
	const directory = path.resolve(release);
	if (!RELEASE_NAME.test(path.basename(directory))) fail("RELEASE_INVALID");
	await validateRoot(path.dirname(directory), [await dockerRoot(bin)]);
	const meta = await verifyFiles(directory);
	for (const service of SERVICES) {
		const { id, tag } = meta.images[service];
		if ((await imageId(bin, id)) !== id) fail("IMAGE_MISSING");
		if ((await imageId(bin, tag)) !== id) fail("TAG_MISMATCH");
	}
	return { ...summary(directory, meta), expired: now().getTime() >= Date.parse(meta.snapshot.protectedUntil) };
}
