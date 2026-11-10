# Consistent backups verification

No user-facing verification is required. The learner's interface does not change. Everything below is operator work on the host, against [the backup guide](../backups.md).

Running this checklist authorizes nothing on the live server. No real provider requests, reads of the live profile or its backups, live scheduling, stops, restarts or other changes are authorized by it. Each of those needs the owner's approval at the time. Do not paste real profile data, env values, policy contents, image IDs or private paths into a PR or issue.

The commands below are the procedure. They are not claims that anything has run. Record actual results in [Recorded results](#recorded-results) only after running them.

## Prerequisites

- [ ] Use this branch with its locked dependencies. Application checks run on Node 26. The host command needs Linux, Node 22 or newer and the Docker CLI. GNU tar runs inside the recorded app image.
- [ ] Use only synthetic profiles, env files, policies and credentials in disposable directories and Docker resources. Never mount the live `learnharness_app-data` or `learnharness_app-auth` volumes or the live private env file.
- [ ] Read [the backup guide](../backups.md) and [the private server guide](../private-server.md).

## Checks

### Automated

- [ ] Run `npm run typecheck` and `npm run lint`. Expect no errors. The inherited `tests/source-name-ui.test.tsx` warning is unrelated.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/server-backup-capture.test.ts tests/server-backup-command.test.ts tests/server-backup-runtime.test.ts`. Expect the capture tests to show a consistent export through the local socket while a synthetic server keeps running, originals unchanged, and refusal of incomplete, corrupt and symlinked copies. Expect the command tests, with a fake `docker` on `PATH`, to show that `create` publishes only verified snapshots, the profile check runs in the recorded image with `--network none` and no mounts, failures leave no partial snapshot and print no private data, and `verify` refuses missing, partial and altered snapshots.
- [ ] Expect the capture tests to cover synchronous web credential writes, and the command tests to cover `status`, `restore` and rotation. `status` counts only daily snapshots toward freshness and exits nonzero when the newest is over a day old, absent, or recognized snapshots are invalid. `restore` creates only new unique `lh-restore-*` volumes, refuses non-empty or live targets, never starts the app, and prints `volumes.data`, `volumes.auth`, `imageId` and the absolute `runtimeFile`. Rotation runs only after a successful `create`. It removes daily snapshots at 14 days, and pre-update snapshots only once `protectedUntil` has passed.
- [ ] Build a disposable image with `docker build -t lh-backup-check-29-source .`. Never use a deployment or production tag. Then run `node scripts/check-server-backups.mjs lh-backup-check-29-source`. Expect it to create a snapshot from a running synthetic server and restore it into fresh volumes. It should start the restored copy with `--network none`, the recorded `LH_SERVER_MODE=tailscale` and origin, and `--entrypoint node /app/server.js`. Expect application reads to match for chats, attachments, image snapshots, the graph, settings, prompts, jobs and the provider binding, with no network capable of reaching a real provider. Expect only its uniquely named resources to be removed afterward. Before removing the image, run `LH_BACKUP_HELPER_IMAGE=lh-backup-check-29-source NODE_ENV=test node --import tsx --test tests/server-backup-command.test.ts` to exercise the real restore helper and its non-empty-volume refusal. This optional check also needs GNU tar on the checking host. Remove the disposable image when finished.
- [ ] Run `npm test` once after implementation and fixes. Expect the full suite to pass without real credentials.

### Operator, disposable

Entry point: a host shell in the checkout, against a uniquely named synthetic Compose project with its own synthetic env file, policy and backup directory.

- [ ] Create the backup directory with mode `0700`. Run `create` against a directory with mode `0755`, a symlinked directory and one inside the checkout. Expect `BACKUP_ROOT_INVALID` each time and nothing written.
- [ ] Run `node scripts/server-backup.mjs create --env-file <synthetic env> --directory <dir> --project <synthetic project>` with the synthetic app running. Expect JSON naming a `daily-*` snapshot, directory mode `0700`, file modes `0600`, and the app still running with the same container ID and start time.
- [ ] While a synthetic lesson writes records, run `create` again. Expect success and an archive whose manifest matches its contents.
- [ ] Run `verify` on the snapshot. Expect success. Alter one byte of `profile.tar.gz`, then delete `config/egress.json`, and run `verify` after each. Expect `SNAPSHOT_INVALID`.
- [ ] Place a symlink in the synthetic `/data` volume and run `create`. Expect `CAPTURE_FAILED`, no new snapshot, no `.partial-*` left behind and no temporary capture directories beside `control.sock` in the container.
- [ ] Fill the synthetic container's `/tmp` until the profile no longer fits, and run `create`. Expect `CAPTURE_FAILED` and no snapshot.
- [ ] Hold `.lock` and run `create`. Expect `BACKUP_LOCKED`.
- [ ] Run `status`. Expect exit 0 after a fresh daily backup. Expect a nonzero exit when the newest daily snapshot is over a day old, even if a newer pre-update snapshot exists.
- [ ] Run `restore <snapshot>`. Expect JSON with two new `lh-restore-*` volume names, the recorded `imageId` and the absolute `runtimeFile`, with no container started and the source volumes unchanged. The smoke command covers the app reads. A manual check follows [Checking a restored copy](../backups.md#checking-a-restored-copy), with `--network none` and the recorded server mode. Then remove the check container and volumes.
- [ ] Run `create --kind pre-update`. Expect `protectedUntil` exactly 14 days after `createdAt` in `snapshot.json`.
- [ ] Check failure output in each failing case above. Expect a single `server-backup: CODE: message` line on stderr, a nonzero exit, and no paths, env values, credentials or learner content.
- [ ] Inspect `scripts/backup/learnharness-backup.service` and `scripts/backup/learnharness-backup.timer`. Expect `OnCalendar` at 03:00 local time, `Persistent=true`, `create --kind daily`, and no install or enable step run.
- [ ] Remove only the uniquely named synthetic resources. No live container, volume, timer or Tailscale route may change. Never use global Docker prune.

### Live operator checks requiring approval

- [ ] Before installing the timer, run one approved manual `create` against the live project, then `verify` and `status`. Expect success with the app still serving.
- [ ] Install and enable `learnharness-backup.timer` only with approval. The next morning, expect a new `daily-*` snapshot, a clean `status` and a successful run in `journalctl -u learnharness-backup.service`.
- [ ] Before relying on the backups, restore one approved live snapshot into `lh-restore-*` volumes and check it with `--network none` as in the guide. Remove the copy afterward.

## Recorded results

Verified with synthetic profiles on Linux on 2026-11-10. No live profile, provider account, service or schedule was used.

- `docker build -t lh-backup-check-29-source .` passed with the pinned Node 26 image. Existing dynamic-filesystem tracing warnings remain.
- `LH_BACKUP_HELPER_IMAGE=lh-backup-check-29-source NODE_ENV=test node --import tsx --test tests/server-backup-capture.test.ts tests/server-backup-command.test.ts tests/server-backup-runtime.test.ts` passed all 55 tests, including the actual network-disabled restore helper.
- `node scripts/check-server-backups.mjs lh-backup-check-29-source` passed all 13 checks. The source kept its PID and restart count. Fifteen writer rounds completed during daily backup; its restored files had a coherent prefix and matching provider binding. The pre-update restore matched application reads exactly. Restored writes did not change the source.
- The smoke filled the disposable container's tmpfs to ENOSPC, verified capture failure without publication or source changes, freed the fixture file and verified a successful retry. Corrupt and missing archives were refused before creating restore volumes. Cleanup removed the run's containers and volumes.
- The first real restore exposed Node's refusal to copy onto existing volume-root directories with no-overwrite options. Copying each verified child into the empty roots fixed it. The real helper regression passes and still refuses non-empty targets.
- Independent full-suite verification at `df90c08`, using Node 26.13.0, npm 11.20.0, writable exported source, read-only installed dependencies, `--init` and no network, passed 3,869 of 3,879 tests with zero failures. Ten skips cover five opt-in firewall checks, four platform-specific cases and the Docker helper, which passed separately above. This was not a clean dependency install. The first checker setup used a read-only scratch workspace and lacked an init process; those setup failures were corrected without changing application tests.
- Review fixes enforce exactly `0700` on the backup root and protect the synchronous credential writer's `.tmp-<UUID>` leftovers. After those fixes, the feature and source-access checks passed 104 tests with three platform skips and no failures. The updated Docker production build, typecheck, lint and whitespace checks passed. Lint retains one inherited warning.
