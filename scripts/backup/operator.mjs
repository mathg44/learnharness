/**
 * Host-side snapshots of the private server's one profile (#29). The running
 * app streams its own consistent export; this side stores it with the image,
 * runtime env and config it ran with, checks every byte before publishing,
 * and ages snapshots out after 14 days. Only Docker is called; nothing here
 * reads the profile's contents, which are checked inside the app's own image.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DIRECTORY = "/var/lib/learnharness-backups";
export const DEFAULT_PROJECT = "learnharness";
export const KINDS = ["daily", "pre-update"];
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 14 * DAY_MS;

const checkout = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Docker keeps the live volumes here; a backup root inside it could be pruned with them.
const DOCKER_ROOT = "/var/lib/docker";
const POLICY_MOUNT = "/etc/learnharness/egress.json";
const EXPORT_CLI = "/usr/local/lib/learnharness/backup/export.mjs";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const isEnv = (env) => Array.isArray(env) && env.every((entry) => typeof entry === "string");
const SNAPSHOT_NAME = /^(daily|pre-update)-(\d{8}T\d{6}Z)-([0-9a-f]{8})$/;
const METADATA = "snapshot.json";
const PAYLOAD = ["config/compose.server.yaml", "config/compose.yaml", "config/egress.json", "config/server.env", "profile.tar.gz", "runtime.json"];

export class BackupError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new BackupError(code);
};

const compact = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** The host root must be a private, real directory owned by this user, away from the checkout and Docker's data. */
async function validateRoot(directory) {
	if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("BACKUP_ROOT_INVALID");
	const resolved = path.resolve(directory);
	const stat = await fsp.lstat(resolved).catch(() => fail("BACKUP_ROOT_INVALID"));
	if (!stat.isDirectory()) fail("BACKUP_ROOT_INVALID");
	if ((await fsp.realpath(resolved)) !== resolved) fail("BACKUP_ROOT_INVALID");
	if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail("BACKUP_ROOT_INVALID");
	const realCheckout = await fsp.realpath(checkout);
	if (overlaps(resolved, realCheckout) || overlaps(resolved, DOCKER_ROOT)) fail("BACKUP_ROOT_INVALID");
	return resolved;
}

async function withLock(root, work) {
	const lock = path.join(root, ".lock");
	const handle = await fsp.open(lock, "wx", 0o600).catch((error) => fail(error.code === "EEXIST" ? "BACKUP_LOCKED" : "BACKUP_ROOT_INVALID"));
	try {
		await handle.writeFile(`${process.pid}\n`);
		await handle.close();
		return await work();
	} finally {
		await fsp.rm(lock, { force: true });
	}
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
async function writeStream(staging, relative, chunks) {
	const handle = await fsp.open(path.join(staging, relative), "wx", 0o600);
	const hash = crypto.createHash("sha256");
	let size = 0;
	try {
		for await (const chunk of chunks) {
			hash.update(chunk);
			size += chunk.length;
			// A write may be short; keep going until the whole chunk is on disk.
			for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset)).bytesWritten;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { path: relative, size, sha256: hash.digest("hex") };
}

async function regularFile(file, code) {
	if (typeof file !== "string" || !path.isAbsolute(file)) fail(code);
	const stat = await fsp.lstat(file).catch(() => fail(code));
	if (!stat.isFile()) fail(code);
}

/** Private config stays out of Git and the build context. */
async function privateFile(file, code) {
	await regularFile(file, code);
	const realCheckout = await fsp.realpath(checkout);
	if (overlaps(path.resolve(file), realCheckout) || overlaps(await fsp.realpath(file), realCheckout)) fail(code);
}

async function copyInto(staging, source, relative, code) {
	await regularFile(source, code);
	return writeStream(staging, relative, fs.createReadStream(source));
}

/** Reads one KEY=value line of a plain env file. Quotes around the value are dropped. */
function envValue(text, key) {
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match?.[1] !== key) continue;
		const value = match[2];
		return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
	}
	return undefined;
}

/** Runs Docker without a shell. Output is never printed; stdout is either collected or handed to `sink`. */
function docker(bin, args, { input, sink } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
		const out = [];
		child.stderr.resume();
		const consumed = sink ? sink(child.stdout) : (async () => {
			for await (const chunk of child.stdout) out.push(chunk);
		})();
		// A sink that stops reading would leave Docker blocked on a full pipe.
		consumed.catch(() => child.kill());
		if (input) {
			child.stdin.on("error", () => {});
			fs.createReadStream(input).on("error", () => child.stdin.destroy()).pipe(child.stdin);
		}
		child.on("error", () => reject(new BackupError("DOCKER_UNAVAILABLE")));
		child.on("close", (status) => {
			consumed.then((value) => resolve({ status, stdout: Buffer.concat(out), value }), reject);
		});
	});
}

async function findApp(bin, project) {
	const listed = await docker(bin, [
		"ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`,
		"--filter", "label=com.docker.compose.service=app", "--format", "{{.ID}}",
	]);
	if (listed.status !== 0) fail("DOCKER_FAILED");
	const ids = listed.stdout.toString("utf8").split("\n").filter(Boolean);
	if (ids.length !== 1 || !/^[0-9a-f]+$/.test(ids[0])) fail("APP_NOT_RUNNING");
	const inspected = await docker(bin, ["container", "inspect", ids[0]]);
	if (inspected.status !== 0) fail("DOCKER_FAILED");
	let container;
	try {
		[container] = JSON.parse(inspected.stdout.toString("utf8"));
	} catch {
		fail("DOCKER_FAILED");
	}
	const imageId = container?.Image;
	const env = container?.Config?.Env;
	const mounts = container?.Mounts;
	if (typeof imageId !== "string" || !IMAGE_ID.test(imageId) || !isEnv(env)) fail("DOCKER_FAILED");
	if (!Array.isArray(mounts) || !mounts.every((mount) => typeof mount?.Destination === "string")) fail("DOCKER_FAILED");
	// The export copies /data and /auth. An app keeping its records anywhere else would give a partial profile.
	const authFile = setting(env, "LH_AUTH_FILE");
	if (setting(env, "LH_DATA_DIR") !== "/data" || typeof authFile !== "string" || path.posix.normalize(authFile) !== authFile || path.posix.dirname(authFile) !== "/auth") fail("APP_LAYOUT_UNSUPPORTED");
	for (const destination of ["/data", "/auth"]) if (!mounts.some((mount) => mount.Destination === destination)) fail("APP_LAYOUT_UNSUPPORTED");
	return {
		container: ids[0], imageId, env,
		mounts: mounts.map((mount) => ({
			type: typeof mount.Type === "string" ? mount.Type : null,
			name: typeof mount.Name === "string" ? mount.Name : null,
			source: typeof mount.Source === "string" ? mount.Source : null,
			destination: mount.Destination,
			readOnly: mount.RW === false,
		})),
	};
}

const setting = (env, key) => env.findLast((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
const realOrSame = (file) => fsp.realpath(file).catch(() => path.resolve(file));

/**
 * The backup root must not overlap anything mounted into the app, wherever
 * Docker keeps it. The env file and policy being copied must be the ones the
 * running app was started with.
 */
async function checkAgainstApp(root, app, envText, policyFile) {
	for (const { source } of app.mounts) {
		if (!source || !path.isAbsolute(source)) continue;
		if (overlaps(root, path.resolve(source)) || overlaps(root, await realOrSame(source))) fail("BACKUP_ROOT_INVALID");
	}
	const origin = envValue(envText, "LH_SERVER_ORIGIN");
	if (!origin || origin !== setting(app.env, "LH_SERVER_ORIGIN")) fail("CONFIG_MISMATCH");
	const policy = app.mounts.find((mount) => mount.destination === POLICY_MOUNT);
	if (!policy?.source || (await realOrSame(policy.source)) !== (await realOrSame(policyFile))) fail("CONFIG_MISMATCH");
}

/**
 * Runs in a throwaway container from the recorded image: no network, no host
 * mounts, read-only root. Extracts the profile from stdin into /tmp and lets
 * the image's own profile check accept it. "restore" then copies it into the
 * empty volumes mounted at /data and /auth. Prints nothing.
 */
const HELPER = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
(async () => {
	const { verifyProfile } = require("/usr/local/lib/learnharness/backup/profile.cjs");
	const dir = fs.mkdtempSync("/tmp/lh-restore-");
	const tar = spawnSync("tar", ["-xzf", "-", "-C", dir, "--no-same-owner"], { stdio: [0, "ignore", "ignore"] });
	if (tar.status !== 0) process.exit(2);
	if ((await verifyProfile(dir)) === false) process.exit(3);
	if (process.argv[1] === "restore") {
		for (const name of ["data", "auth"]) {
			if (fs.readdirSync("/" + name).length !== 0) process.exit(4);
			// Copy the children: cpSync refuses an existing destination root, and the volume root keeps the image's owner and mode.
			for (const entry of fs.readdirSync(dir + "/" + name)) {
				fs.cpSync(dir + "/" + name + "/" + entry, "/" + name + "/" + entry, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
			}
		}
	}
	process.exit(0);
})().catch(() => process.exit(1));
`;

/** Exported for the Docker-backed helper test; the commands above are its only callers. */
export function helperArgs(imageId, mode, mounts = []) {
	return [
		"run", "-i", "--rm", "--pull", "never", "--network", "none", "--read-only",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
		"--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
		...mounts, "--entrypoint", "node", imageId, "-e", HELPER, mode,
	];
}

async function listTree(directory, prefix = "") {
	const files = [];
	for (const entry of await fsp.readdir(path.join(directory, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory() && relative === "config") files.push(...(await listTree(directory, relative)));
		else if (entry.isFile()) files.push(relative);
		else fail("SNAPSHOT_INVALID");
	}
	return files;
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

const isIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

const nullableString = (value) => value === null || typeof value === "string";
const validMount = (mount) => nullableString(mount?.type) && nullableString(mount.name) && nullableString(mount.source)
	&& typeof mount.destination === "string" && typeof mount.readOnly === "boolean";

/** Checks the metadata, the exact file set and every hash. Returns the metadata. */
async function verifyDirectory(directory, name) {
	const stat = await fsp.lstat(directory).catch(() => fail("SNAPSHOT_INVALID"));
	if (!stat.isDirectory()) fail("SNAPSHOT_INVALID");
	const found = (await listTree(directory).catch((error) => fail(error instanceof BackupError ? error.code : "SNAPSHOT_INVALID"))).sort();
	if (JSON.stringify(found) !== JSON.stringify([...PAYLOAD, METADATA].sort())) fail("SNAPSHOT_INVALID");
	let meta;
	try {
		meta = JSON.parse(await fsp.readFile(path.join(directory, METADATA), "utf8"));
	} catch {
		fail("SNAPSHOT_INVALID");
	}
	if (meta?.version !== 1 || !KINDS.includes(meta.kind) || !isIso(meta.createdAt)) fail("SNAPSHOT_INVALID");
	if (meta.kind === "pre-update" && (!isIso(meta.protectedUntil) || Date.parse(meta.protectedUntil) - Date.parse(meta.createdAt) !== RETENTION_MS)) fail("SNAPSHOT_INVALID");
	if (meta.kind === "daily" && meta.protectedUntil !== undefined) fail("SNAPSHOT_INVALID");
	if (!Array.isArray(meta.files) || JSON.stringify(meta.files.map((file) => file?.path)) !== JSON.stringify(PAYLOAD)) fail("SNAPSHOT_INVALID");
	if (name) {
		const match = SNAPSHOT_NAME.exec(name);
		if (!match || match[1] !== meta.kind || match[2] !== compact(meta.createdAt)) fail("SNAPSHOT_INVALID");
	}
	for (const file of meta.files) {
		const actual = await hashFile(path.join(directory, file.path));
		if (actual.size !== file.size || actual.sha256 !== file.sha256) fail("SNAPSHOT_INVALID");
	}
	let runtime;
	try {
		runtime = JSON.parse(await fsp.readFile(path.join(directory, "runtime.json"), "utf8"));
	} catch {
		fail("SNAPSHOT_INVALID");
	}
	const validRuntime = runtime?.version === 1 && typeof runtime.project === "string" && PROJECT.test(runtime.project)
		&& typeof runtime.container === "string" && /^[0-9a-f]+$/.test(runtime.container)
		&& typeof runtime.imageId === "string" && IMAGE_ID.test(runtime.imageId) && isEnv(runtime.env)
		&& Array.isArray(runtime.mounts) && runtime.mounts.every(validMount);
	if (!validRuntime) fail("SNAPSHOT_INVALID");
	return { ...meta, imageId: runtime.imageId };
}

/** Verifies a published snapshot inside a valid backup root. Partial, foreign or altered folders are refused. */
export async function verifySnapshot(snapshot) {
	const { directory, name } = await snapshotPath(snapshot);
	const meta = await verifyDirectory(directory, name);
	return { snapshot: directory, kind: meta.kind, createdAt: meta.createdAt };
}

async function snapshotPath(snapshot) {
	if (typeof snapshot !== "string") fail("SNAPSHOT_INVALID");
	const directory = path.resolve(snapshot);
	const name = path.basename(directory);
	if (!SNAPSHOT_NAME.test(name)) fail("SNAPSHOT_INVALID");
	return { root: await validateRoot(path.dirname(directory)), directory, name };
}

/**
 * Loads a verified snapshot into two brand-new volumes, lh-restore-<uuid>-data
 * and -auth, using only the image ID it recorded. Never touches existing
 * volumes and never starts the app. On failure the two new volumes are removed.
 */
export async function restoreSnapshot(snapshot, { docker: bin = "docker" } = {}) {
	const { root, directory, name } = await snapshotPath(snapshot);
	return withLock(root, async () => {
		const { imageId } = await verifyDirectory(directory, name);
		const runtimeFile = path.join(directory, "runtime.json");
		const image = await docker(bin, ["image", "inspect", "--format", "{{.Id}}", imageId]);
		if (image.status !== 0 || image.stdout.toString("utf8").trim() !== imageId) fail("IMAGE_MISSING");
		const uuid = crypto.randomUUID();
		const volumes = { data: `lh-restore-${uuid}-data`, auth: `lh-restore-${uuid}-auth` };
		for (const volume of Object.values(volumes)) {
			if ((await docker(bin, ["volume", "inspect", volume])).status === 0) fail("RESTORE_FAILED");
		}
		const created = [];
		try {
			for (const volume of Object.values(volumes)) {
				if ((await docker(bin, ["volume", "create", "--label", `learnharness.restore=${uuid}`, volume])).status !== 0) fail("RESTORE_FAILED");
				created.push(volume);
			}
			const mounts = ["--mount", `type=volume,src=${volumes.data},dst=/data`, "--mount", `type=volume,src=${volumes.auth},dst=/auth`];
			const loaded = await docker(bin, helperArgs(imageId, "restore", mounts), { input: path.join(directory, "profile.tar.gz") });
			if (loaded.status !== 0) fail("RESTORE_FAILED");
		} catch (error) {
			if (created.length) {
				const removed = await docker(bin, ["volume", "rm", ...created]).catch(() => undefined);
				if (removed?.status !== 0) fail("RESTORE_CLEANUP_FAILED");
			}
			throw error;
		}
		return { volumes, imageId, runtimeFile };
	});
}

/**
 * Newest daily snapshot that verifies and its age. Healthy means it is at
 * most 24 hours old and every snapshot in the root verifies; `invalid` counts
 * the ones that don't. Pre-update snapshots never count as the latest.
 */
export async function backupStatus({ directory = DEFAULT_DIRECTORY, now = () => new Date() } = {}) {
	const root = await validateRoot(directory);
	let latest;
	let invalid = 0;
	for (const name of (await fsp.readdir(root)).filter((entry) => SNAPSHOT_NAME.test(entry))) {
		const meta = await verifyDirectory(path.join(root, name), name).catch(() => undefined);
		if (!meta) invalid++;
		else if (meta.kind === "daily" && (!latest || meta.createdAt > latest.createdAt)) latest = { snapshot: path.join(root, name), createdAt: meta.createdAt };
	}
	if (!latest) return { snapshot: null, createdAt: null, ageHours: null, healthy: false, invalid };
	const ageHours = (now().getTime() - Date.parse(latest.createdAt)) / (60 * 60 * 1000);
	return { ...latest, ageHours, healthy: ageHours <= 24 && invalid === 0, invalid };
}

/**
 * Deletes verified snapshots once 14 days have passed since capture (for
 * pre-update ones, once protectedUntil has passed). Snapshots that fail
 * verification stay put and are reported. Other names are not ours and are
 * left alone. Called with the lock held, right after a successful capture.
 */
async function rotate(root, now, keep) {
	const deleted = [];
	const invalid = [];
	for (const name of (await fsp.readdir(root)).sort()) {
		if (name === keep || !SNAPSHOT_NAME.test(name)) continue;
		const directory = path.join(root, name);
		let meta;
		try {
			meta = await verifyDirectory(directory, name);
		} catch {
			invalid.push(name);
			continue;
		}
		const expires = meta.kind === "pre-update" ? Date.parse(meta.protectedUntil) : Date.parse(meta.createdAt) + RETENTION_MS;
		if (now < expires) continue;
		// Out of the recognized namespace first, so an interrupted delete never looks like a damaged snapshot.
		const doomed = path.join(root, `.partial-delete-${crypto.randomUUID()}`);
		await fsp.rename(directory, doomed);
		await fsp.rm(doomed, { recursive: true, force: true });
		deleted.push(name);
	}
	if (deleted.length) await fsyncDirectory(root);
	return { deleted, invalid };
}

/**
 * Captures the running app of `project` into a new snapshot under `directory`.
 * Nothing becomes visible under its final name until every file verifies.
 */
export async function createSnapshot({
	envFile, directory = DEFAULT_DIRECTORY, project = DEFAULT_PROJECT, kind = "daily",
	now = () => new Date(), docker: bin = "docker",
}) {
	if (!KINDS.includes(kind) || !PROJECT.test(project)) fail("USAGE");
	await privateFile(envFile, "ENV_FILE_INVALID");
	const root = await validateRoot(directory);
	return withLock(root, async () => {
		const envText = await fsp.readFile(envFile, "utf8").catch(() => fail("ENV_FILE_INVALID"));
		const policyFile = envValue(envText, "LH_EGRESS_POLICY_FILE");
		await privateFile(policyFile, "POLICY_FILE_INVALID");
		const app = await findApp(bin, project);
		await checkAgainstApp(root, app, envText, policyFile);
		const staging = path.join(root, `.partial-${crypto.randomUUID()}`);
		await fsp.mkdir(staging, { mode: 0o700 });
		let published;
		let meta;
		try {
			await fsp.mkdir(path.join(staging, "config"), { mode: 0o700 });
			const files = [];
			files.push(await copyInto(staging, envFile, "config/server.env", "ENV_FILE_INVALID"));
			files.push(await copyInto(staging, policyFile, "config/egress.json", "POLICY_FILE_INVALID"));
			files.push(await copyInto(staging, path.join(checkout, "compose.yaml"), "config/compose.yaml", "CHECKOUT_INVALID"));
			files.push(await copyInto(staging, path.join(checkout, "compose.server.yaml"), "config/compose.server.yaml", "CHECKOUT_INVALID"));
			const createdAt = now().toISOString();
			const runtime = { version: 1, project, container: app.container, imageId: app.imageId, env: app.env, mounts: app.mounts };
			files.push(await writeStream(staging, "runtime.json", [Buffer.from(JSON.stringify(runtime, null, "\t") + "\n")]));
			const captured = await docker(bin, ["exec", app.container, "node", EXPORT_CLI], {
				sink: (stdout) => writeStream(staging, "profile.tar.gz", stdout),
			});
			if (captured.status !== 0 || captured.value.size === 0) fail("CAPTURE_FAILED");
			files.push(captured.value);
			const checked = await docker(bin, helperArgs(app.imageId, "verify"), { input: path.join(staging, "profile.tar.gz") });
			if (checked.status !== 0) fail("PROFILE_INVALID");
			meta = {
				version: 1, kind, createdAt,
				...(kind === "pre-update" ? { protectedUntil: new Date(Date.parse(createdAt) + RETENTION_MS).toISOString() } : {}),
				files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
			};
			await writeStream(staging, METADATA, [Buffer.from(JSON.stringify(meta, null, "\t") + "\n")]);
			await fsyncDirectory(path.join(staging, "config"));
			await fsyncDirectory(staging);
			await verifyDirectory(staging);
			published = path.join(root, `${kind}-${compact(createdAt)}-${crypto.randomBytes(4).toString("hex")}`);
			await fsp.rename(staging, published);
			await fsyncDirectory(root);
		} catch (error) {
			await fsp.rm(staging, { recursive: true, force: true });
			throw error;
		}
		const retention = await rotate(root, now().getTime(), path.basename(published));
		return { snapshot: published, kind, createdAt: meta.createdAt, retention };
	});
}
