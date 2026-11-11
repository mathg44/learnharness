#!/usr/bin/env node
/**
 * Release preservation for private server updates (#30). Needs Node 22+, Git
 * and the Docker CLI. Prints one JSON object on stdout and, on failure, a
 * fixed error code on stderr. It never prints secrets or Docker/Git output.
 *
 *   preserve --snapshot PATH --revision COMMIT --directory DIR [--project NAME] [--source DIR]
 *       -> {release, revision, createdAt, protectedUntil, images: {app, egress, demo: {id, tag}}}
 *   verify RELEASE
 *       -> the same plus {expired}; exit 1 with RELEASE_EXPIRED once the snapshot's protection has ended
 *
 * --source is the Git checkout holding COMMIT; it defaults to the current
 * directory. The revision is declared by the operator: the release records it
 * and checks the recipes against it, but nothing proves the images were built
 * from it.
 */
import { parseArgs } from "node:util";
import { BackupError } from "./backup/operator.mjs";
import { DEFAULT_PROJECT, preserveRelease, ReleaseError, verifyRelease } from "./release/preserve.mjs";

const MESSAGES = {
	USAGE: "Usage: server-release.mjs preserve --snapshot PATH --revision COMMIT --directory DIR [--project NAME] [--source DIR] | verify RELEASE",
	RELEASE_ROOT_INVALID: "The release directory must be an existing real directory owned by this user, mode 0700, outside the source checkout, this helper's checkout, Docker's data, the snapshot's backup directory and every app, egress and demo mount.",
	RELEASE_LOCKED: "Another release command holds the lock, or one was interrupted. Run pgrep -af server-release.mjs and confirm no server-release.mjs process is running. Only then remove .lock in the release directory.",
	REVISION_INVALID: "The revision must be a full 40-character commit ID present in the source checkout.",
	GIT_UNAVAILABLE: "The git command could not be started.",
	SOURCE_INVALID: "The source must be the top-level directory of a Git checkout.",
	SOURCE_UNSUPPORTED: "The revision lacks compose.yaml, compose.server.yaml or scripts/demo/seccomp.json, or could not be archived.",
	SOURCE_MISMATCH: "The snapshot's compose.yaml or compose.server.yaml differs from the revision's.",
	SNAPSHOT_INVALID: "The snapshot must be a verified pre-update snapshot.",
	SNAPSHOT_EXPIRED: "The snapshot's protectedUntil has passed. Take a new pre-update snapshot.",
	DOCKER_UNAVAILABLE: "The docker command could not be started.",
	DOCKER_FAILED: "A Docker query failed or returned something unexpected.",
	SERVICE_NOT_RUNNING: "Exactly one running app, egress and demo container is required for the project.",
	SNAPSHOT_MISMATCH: "The running app is not the container, image or project the snapshot recorded.",
	CONFIG_MISMATCH: "The running containers were not created from the snapshot's recipes, env file and policy, changed only by their image references and the recorded data/auth volume names, or Compose could not read that arrangement.",
	SECCOMP_MISMATCH: "The running demo worker's seccomp profile differs from the revision's scripts/demo/seccomp.json.",
	TAG_EXISTS: "A retention tag for this release already exists. Tags are never overwritten.",
	TAG_FAILED: "Tagging an image failed. Tags this run created were removed.",
	RELEASE_CLEANUP_FAILED: "Preserving failed, and removing the retention tags this run created failed too. Only tags ending in this run's -<UTC time>-<12-character commit> can be its own. Do not remove any other tag, including installed and older release tags, and do not prune. If you cannot tell which tags this run created, stop and ask the owner.",
	RELEASE_INVALID: "The release is missing, partial or altered.",
	IMAGE_MISSING: "An image ID recorded in the release is not present locally. It is never pulled.",
	TAG_MISMATCH: "A retention tag is missing or no longer names the recorded image.",
	RELEASE_EXPIRED: "The release verifies, but its snapshot's protectedUntil has passed, so the rollback window is closed.",
	INTERNAL: "Unexpected failure.",
};

function parse(args, options, positionals) {
	const parsed = parseArgs({ args, options, allowPositionals: true });
	if (parsed.positionals.length !== positionals) throw new ReleaseError("USAGE");
	return parsed;
}

async function main([command, ...args]) {
	if (command === "preserve") {
		const { values } = parse(args, Object.fromEntries(["snapshot", "revision", "directory", "project", "source"].map((name) => [name, { type: "string" }])), 0);
		if (!values.snapshot || !values.revision || !values.directory) throw new ReleaseError("USAGE");
		return { output: await preserveRelease({ ...values, project: values.project ?? DEFAULT_PROJECT, source: values.source ?? process.cwd() }) };
	}
	if (command === "verify") {
		const output = await verifyRelease(parse(args, {}, 1).positionals[0]);
		return { output, error: output.expired ? "RELEASE_EXPIRED" : undefined };
	}
	throw new ReleaseError("USAGE");
}

process.umask(0o077);
let code;
try {
	const { output, error } = await main(process.argv.slice(2));
	process.stdout.write(JSON.stringify(output, null, "\t") + "\n");
	code = error;
} catch (error) {
	if (error instanceof ReleaseError) code = error.code;
	else if (error instanceof BackupError) code = "SNAPSHOT_INVALID";
	else code = String(error?.code).startsWith("ERR_PARSE_ARGS") ? "USAGE" : "INTERNAL";
}
if (code) {
	process.stderr.write(`server-release: ${code}: ${MESSAGES[code] ?? MESSAGES.INTERNAL}\n`);
	process.exitCode = code === "USAGE" ? 2 : 1;
}
