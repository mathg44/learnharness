#!/usr/bin/env node
/**
 * Host backup command for the private server (#29). Needs Node 22+ and the
 * Docker CLI. Prints one JSON object on stdout and, on failure, a fixed error
 * code on stderr. It never prints profile data, credentials or Docker output.
 *
 *   create --env-file FILE [--directory DIR] [--project NAME] [--kind daily|pre-update]
 *       -> {snapshot, kind, createdAt}
 *   verify SNAPSHOT            -> {snapshot, kind, createdAt}
 *   status [--directory DIR]   -> {snapshot, createdAt, ageHours, healthy, invalid}; exit 1 when the newest
 *                                 daily is missing or over 24 h old, or any snapshot fails verification
 *   restore SNAPSHOT           -> {volumes: {data, auth}, imageId, runtimeFile}; does not start the app.
 *                                 The new volumes are the caller's to remove: docker volume rm, or filter by
 *                                 label learnharness.restore=<uuid>.
 */
import { parseArgs } from "node:util";
import {
	BackupError, backupStatus, createSnapshot, DEFAULT_DIRECTORY, DEFAULT_PROJECT, restoreSnapshot, verifySnapshot,
} from "./backup/operator.mjs";

const MESSAGES = {
	USAGE: "Usage: server-backup.mjs create --env-file FILE [--directory DIR] [--project NAME] [--kind daily|pre-update] | verify SNAPSHOT | status [--directory DIR] | restore SNAPSHOT",
	BACKUP_ROOT_INVALID: "The backup directory must be an existing real directory owned by this user, mode 0700, outside the checkout and Docker's data.",
	BACKUP_LOCKED: "Another backup command holds the lock, or one was interrupted. Run pgrep -af server-backup.mjs and confirm no server-backup.mjs process is running. Only then remove .lock in the backup directory.",
	ENV_FILE_INVALID: "The env file must be an absolute path to a regular file outside the checkout.",
	POLICY_FILE_INVALID: "LH_EGRESS_POLICY_FILE in the env file must name an absolute path to a regular file outside the checkout.",
	CHECKOUT_INVALID: "compose.yaml and compose.server.yaml must be regular files in the checkout.",
	DOCKER_UNAVAILABLE: "The docker command could not be started.",
	DOCKER_FAILED: "A Docker query failed or returned something unexpected.",
	APP_NOT_RUNNING: "Exactly one running app container is required for the project.",
	APP_LAYOUT_UNSUPPORTED: "The app must run with LH_DATA_DIR=/data and LH_AUTH_FILE under /auth, both mounted, as in compose.yaml.",
	CONFIG_MISMATCH: "The env file's LH_SERVER_ORIGIN and LH_EGRESS_POLICY_FILE must match the running app's origin and its mounted policy file.",
	CAPTURE_FAILED: "The app did not produce a profile export.",
	PROFILE_INVALID: "The exported profile failed verification inside the recorded image.",
	SNAPSHOT_INVALID: "The snapshot is missing, partial or altered.",
	RETENTION_BLOCKED: "The new snapshot is published, but an older snapshot failed verification and was kept. Run verify on each snapshot to find it.",
	BACKUP_MISSING: "No daily snapshot in the backup directory verifies.",
	BACKUP_STALE: "The newest daily snapshot that verifies is more than 24 hours old.",
	BACKUP_INVALID: "At least one snapshot in the backup directory fails verification. Run verify on each to find it.",
	IMAGE_MISSING: "The image ID recorded in the snapshot is not present locally. It is never pulled.",
	RESTORE_FAILED: "Loading the snapshot into new volumes failed. Any volumes this run created were removed.",
	RESTORE_CLEANUP_FAILED: "Loading the snapshot into new volumes failed, and removing the volumes this run created failed too. List them with docker volume ls --filter label=learnharness.restore and remove them by hand.",
	INTERNAL: "Unexpected failure.",
};

const fail = (code) => {
	throw new BackupError(code);
};

function parse(args, options, positionals) {
	const parsed = parseArgs({ args, options, allowPositionals: true });
	if (parsed.positionals.length !== positionals) fail("USAGE");
	return parsed;
}

/** Returns the JSON to print and the error code to report afterwards, if any. */
async function main([command, ...args]) {
	if (command === "create") {
		const { values } = parse(args, { "env-file": { type: "string" }, directory: { type: "string" }, project: { type: "string" }, kind: { type: "string" } }, 0);
		if (!values["env-file"]) fail("USAGE");
		const { snapshot, kind, createdAt, retention } = await createSnapshot({
			envFile: values["env-file"], directory: values.directory ?? DEFAULT_DIRECTORY,
			project: values.project ?? DEFAULT_PROJECT, kind: values.kind ?? "daily",
		});
		return { output: { snapshot, kind, createdAt }, error: retention.invalid.length ? "RETENTION_BLOCKED" : undefined };
	}
	if (command === "verify") return { output: await verifySnapshot(parse(args, {}, 1).positionals[0]) };
	if (command === "status") {
		const status = await backupStatus({ directory: parse(args, { directory: { type: "string" } }, 0).values.directory ?? DEFAULT_DIRECTORY });
		const error = !status.snapshot ? "BACKUP_MISSING" : status.ageHours > 24 ? "BACKUP_STALE" : status.invalid ? "BACKUP_INVALID" : undefined;
		return { output: status, error };
	}
	if (command === "restore") return { output: await restoreSnapshot(parse(args, {}, 1).positionals[0]) };
	fail("USAGE");
}

process.umask(0o077);
let code;
try {
	const { output, error } = await main(process.argv.slice(2));
	process.stdout.write(JSON.stringify(output, null, "\t") + "\n");
	code = error;
} catch (error) {
	code = error instanceof BackupError ? error.code : String(error?.code).startsWith("ERR_PARSE_ARGS") ? "USAGE" : "INTERNAL";
}
if (code) {
	process.stderr.write(`server-backup: ${code}: ${MESSAGES[code] ?? MESSAGES.INTERNAL}\n`);
	process.exitCode = code === "USAGE" ? 2 : 1;
}
