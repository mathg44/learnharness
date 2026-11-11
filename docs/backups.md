# Private server backups

The private server keeps one profile in two Docker volumes, `learnharness_app-data` and `learnharness_app-auth`. [scripts/server-backup.mjs](../scripts/server-backup.mjs) copies both into a private snapshot on the host while the app keeps running. Nothing stops, restarts or changes the live service, and the originals are never modified.

Once the daily timer is installed and succeeding, routine recovery can lose up to about a day of work. Failed or missed backups increase that loss. Losing the disk or the server loses the snapshots too. They stay on the same host, and there is no offsite copy or backup service. Copying snapshots elsewhere is your decision and your responsibility.

## Prerequisites

On the Linux host, outside the container:

- Node 22 or newer and the Docker CLI with access to the daemon. GNU tar runs inside the recorded app image.
- A running image containing the #29 capture hook and export helper. Older images cannot produce an online snapshot with this command. Introducing this image is a separately approved update, not something the backup command performs.
- The checkout the server was started from. The command copies its `compose.yaml` and `compose.server.yaml`.
- The private `server.env` used to start the server, naming `LH_EGRESS_POLICY_FILE`. See [Start and stop](private-server.md#start-and-stop).
- A backup directory that already exists, is a real directory owned by the user running the command, has mode `0700`, and lies outside the checkout, Docker's data root, any build context and any learner mount. The default is `/var/lib/learnharness-backups`. The command refuses anything else rather than fixing permissions.

```bash
sudo install -d -m 0700 -o "$USER" -g "$USER" /var/lib/learnharness-backups
```

Use one app writer per profile. Do not replace the deployment or edit its private configuration while a backup runs. The command runs with umask `077`. Snapshot directories are `0700` and files `0600`.

## Commands

```bash
node scripts/server-backup.mjs create --env-file /private/server.env \
  [--directory /var/lib/learnharness-backups] [--project learnharness] [--kind daily|pre-update]
node scripts/server-backup.mjs verify <snapshot>
node scripts/server-backup.mjs status [--directory /var/lib/learnharness-backups]
node scripts/server-backup.mjs restore <snapshot>
```

`--kind` defaults to `daily` and `--project` to `learnharness`. Success prints JSON on stdout and exits 0. Failure prints one line, `server-backup: CODE: message`, on stderr and exits nonzero. Usage errors exit 2. Messages never contain learner content, credentials, private paths from the profile or Docker's own output, so they are safe to leave in the journal.

### create

1. Takes `.lock` in the backup directory. A second run fails with `BACKUP_LOCKED`. If no run is active, a stale `.lock` left by a killed process has to be removed by hand.
2. Finds exactly one running `app` container for the project. Checks its data/auth layout and confirms the supplied origin and policy match the running container. Refuses a backup directory overlapping any mounted source.
3. Copies the env file, policy and Compose files into a hidden `.partial-*` directory. Records the exact image ID, runtime environment and mount metadata in `runtime.json`.
4. Runs the image's export helper with `docker exec`. The app [captures the profile](#how-capture-works) and streams `profile.tar.gz` back.
5. Opens that archive in a throwaway container from the same image ID, with `--network none`, a read-only root, no capabilities and no host mounts. The image's own check must accept every file against the archive's manifest.
6. Writes `snapshot.json` with a SHA-256 and size for every file, re-checks them all, then renames the directory to its final name, for example `daily-20261110T030001Z-1a2b3c4d`. Names use UTC.
7. After a successful backup, [rotates old snapshots](#retention).

Any failure deletes the partial directory. A snapshot appears under its final name only once every byte has been checked.

### verify

Checks that the snapshot is inside a valid backup directory, holds exactly the expected files, and that every size and hash matches `snapshot.json`. Missing, partial, extra or altered files fail with `SNAPSHOT_INVALID`. Invalid runtime metadata is also refused. It reads no profile contents.

### status

Checks the snapshots and exits nonzero if any recognized snapshot is invalid, if the newest valid daily snapshot is more than one day old, or if there is none. The JSON includes an `invalid` count. Pre-update snapshots don't count toward freshness, so a manual pre-update run can't hide a broken timer. Use it from monitoring or by hand after a missed night.

### restore

Restore never writes the live volumes. It creates two new Docker volumes with generated, unique `lh-restore-*` names, checks that they are empty, and copies the verified profile into them from a `--network none` container of the recorded image. It does not start the app and accepts no live target. It prints:

```json
{
  "volumes": { "data": "lh-restore-...", "auth": "lh-restore-..." },
  "imageId": "sha256:...",
  "runtimeFile": "/var/lib/learnharness-backups/<snapshot>/runtime.json"
}
```

`runtimeFile` is the snapshot's absolute `runtime.json` path. That file holds the recorded `imageId` and the container's `env` array.

Putting a restored copy back into service is a separate, owner-approved step. Before that, check the copy as described in [Checking a restored copy](#checking-a-restored-copy).

## What a snapshot contains

| File | Contents |
| --- | --- |
| `profile.tar.gz` | Every regular file under `/data` and `/auth`, plus the app's `manifest.json` |
| `runtime.json` | Project, container ID, exact image ID and the container's runtime environment |
| `config/server.env` | The private env file |
| `config/egress.json` | The private egress policy |
| `config/compose.yaml`, `config/compose.server.yaml` | The Compose recipes |
| `snapshot.json` | Kind, creation time, pre-update protection time, and the hash and size of every file above |

`/data` holds `chats/*.json` (messages, plans, practice, usage, processed browser attachments, image snapshots), `jobs/*.json` (worker computation and delivery obligations), the graph ledgers (`nodes`, `chains`, `sessions`, `coverage`) and their `sources`, `source-organization`, `positions`, `render-settings` and format files, `settings.json`, `prompts/**`, and debug output if present. `/auth` holds `auth.json`, the ChatGPT, GitHub Copilot and xAI credential files, and any leftover atomic-write temporary files.

No regular file is left out. A symlink, socket, device or other special file anywhere in either tree fails the backup instead of being skipped.

Not included:

- The image itself. A snapshot records the image ID but does not store the image. Keep the original image on the host for as long as you might restore its snapshots. The [update workflow](server-updates.md) preserves matching app, guard and demo image tags, source and configuration. It does not save image archives.
- Temporary files, caches, browser profiles and research downloads under `/tmp` or `/app/.next/cache`.
- Original uploaded PDFs, which the app never keeps.
- Anything held only in memory: a reply still streaming, question drafts, composer steers, a pending OAuth sign-in, running network workers.
- The egress guard's readiness state. It is rebuilt on start.

Credentials are stored in plaintext, exactly as on the volume. If a snapshot or the host may be compromised, revoke or rotate those credentials at the provider. Deleting the snapshot alone is not enough.

Deleting a chat, source or credential in the app does not remove it from existing snapshots. It disappears from backups only when the last snapshot containing it ages out.

## How capture works

In server mode the app listens on a native Unix socket, `/tmp/learnharness-backup/control.sock`. The directory is `0700` and the socket `0600`, both owned by the app user. The socket is not published outside the container. The host operator reaches it through `docker exec`. There is no HTTP route or model tool for it, and the file tools refuse the whole `/tmp/learnharness-backup` directory.

When the export helper connects, the app copies `/data` and `/auth` into a private staging directory on the container's `/tmp` tmpfs. That copy is synchronous, in the app's single event loop. Every persistent profile writer in the web app is synchronous too, including credential saves, which use synchronous atomic writes. So no write can land halfway through the copy. Requests and background work wait for the few moments the copy takes, then carry on. The app then releases the event loop while `tar` and `gzip` stream the staged copy to the host, and deletes the staging directory when the stream ends or fails.

Capture runs between event-loop callbacks. It cannot interrupt a synchronous graph merge or provider-binding commit. It does not wait for entire asynchronous lessons or background runs to finish. Their durable records are included, but output held only in memory is not. Restoring a running job may repeat provider work, so check restored profiles without networking.

The staging copy shares the existing 256 MiB `/tmp` tmpfs with other temporary work such as research PDF downloads. If the profile does not fit, the backup fails. It does not fall back to copying live files. A profile approaching that size needs a deliberate change to the tmpfs, not a workaround.

## Daily schedule

The #29 change ships [scripts/backup/learnharness-backup.service](../scripts/backup/learnharness-backup.service) and [scripts/backup/learnharness-backup.timer](../scripts/backup/learnharness-backup.timer) as templates. They are not installed or enabled. Installing them is a separate host change that needs owner approval.

The timer runs `create --kind daily` at 03:00 server-local time with `Persistent=true`, so a run missed while the host was off happens at the next boot. The service template defaults to root. Before installation, set its `User=` to the backup directory's owner and fill in the absolute paths to the checkout, Node and the private env file. The directory-creation example above assigns the current user, so that `User=` edit is required. A failed run exits nonzero and leaves the generic error line in the journal.

```bash
systemctl list-timers learnharness-backup.timer
journalctl -u learnharness-backup.service --since yesterday
node scripts/server-backup.mjs status
```

## Retention

Daily snapshots are deleted once they are 14 days old. Rotation runs only after a successful backup, so a run of failures never deletes the last good copies.

A `pre-update` snapshot is for [explicit updates](server-updates.md). It carries a `protectedUntil` time exactly 14 days after its capture, and rotation never deletes it before then. Once `protectedUntil` has passed, the next successful `create` of either kind removes it. An update's rollback window must not extend past the `protectedUntil` of its pre-update snapshot. Take the pre-update snapshot just before the update, and keep the old image and config until the window closes.

## Checking a restored copy

Only check restored data in a disposable copy. The restored profile contains durable jobs that the app will try to resume, and resumed jobs can call models. Graph store initialization also rewrites legacy ledgers. So:

- Always run the copy with `--network none`. Never give a restored app a real network.
- Never attach it to the live egress guard, policy or network, and never mount the live volumes.
- Keep the recorded server mode. Run the image recorded in `runtime.json`, with its recorded `LH_SERVER_MODE=tailscale` and `LH_SERVER_ORIGIN`, plus the same read-only root, dropped capabilities, user and tmpfs mounts as the live app.
- Remove the check container and the `lh-restore-*` volumes afterward, unless the owner has approved promoting them.

The container's normal entrypoint refuses server mode without a live egress guard, and a check copy must not have one. The verifier therefore starts the server directly with `--entrypoint node` and `/app/server.js`. Inside the app, the capability gate still finds no fresh enforcement, so research and downloaded PDFs stay unavailable and the app fails closed. This bypass is valid only for a disposable `--network none` verifier. Never use it for production recovery or for any restored app that has a real network.

[scripts/check-server-backups.mjs](../scripts/check-server-backups.mjs) runs this whole procedure against a synthetic profile and shows the exact flags. For a manual check of a real snapshot, which needs owner approval, use the same flags with the volumes from `restore`. Reach the app from inside its own namespace with `docker exec` and `fetch("http://127.0.0.1:3000/...")`. Server-mode access checks still apply, so send what the health check sends: `Host` equal to the recorded origin's host, a `Tailscale-User-Login` header and `X-Forwarded-Proto: https`. Print status codes and counts, not record contents. Confirm through the application's own reads that:

- `/api/chats` lists the expected sessions, and `/api/chats/<id>` opens one with its messages, plan and usage.
- The chat read contains its processed text/PDF attachments. Image attachment previews at `/api/chats/<id>/attachments/<attachmentId>` and image snapshots at `/api/chats/<id>/images/<snapshotId>` load.
- `/api/graph` returns the propositions, chains and sources, with positions and render settings.
- `/api/settings` and `/api/settings/prompts` return the saved preferences and prompt overrides.
- `/api/jobs` shows the expected job records.
- `/api/custom-provider`, `/api/keys` and `/api/subscriptions` show the provider binding and connections as configured. Do not send a model request.

Then remove everything:

```bash
docker rm -f <check container>
docker volume rm <data volume> <auth volume>
```

## Failure codes

| Code | Meaning |
| --- | --- |
| `USAGE` | Bad arguments |
| `BACKUP_ROOT_INVALID` | Backup directory missing, a symlink, wrong owner or mode, or inside the checkout or Docker's data |
| `BACKUP_LOCKED` | Another run holds `.lock` |
| `ENV_FILE_INVALID`, `POLICY_FILE_INVALID` | Env file or the policy it names is not an absolute path to a regular file |
| `CHECKOUT_INVALID` | Compose files missing from the checkout |
| `DOCKER_UNAVAILABLE`, `DOCKER_FAILED` | Docker could not run or returned something unexpected |
| `APP_NOT_RUNNING` | Not exactly one running app container for the project |
| `APP_LAYOUT_UNSUPPORTED` | The app does not use the supported `/data` and `/auth` mounts |
| `CONFIG_MISMATCH` | The supplied origin or policy does not match the running container |
| `CAPTURE_FAILED` | The app produced no export, for example because staging ran out of tmpfs space or the profile contains a symlink or special file |
| `PROFILE_INVALID` | The export failed the image's own check |
| `SNAPSHOT_INVALID` | Snapshot missing, partial, altered or invalid |
| `BACKUP_MISSING`, `BACKUP_STALE`, `BACKUP_INVALID` | Status found no daily backup, an old one, or invalid snapshots |
| `RETENTION_BLOCKED` | New backup published, but invalid older snapshots were kept instead of deleted |
| `IMAGE_MISSING`, `RESTORE_FAILED` | Recorded image unavailable locally, or isolated restore failed |
| `RESTORE_CLEANUP_FAILED` | Restore failed and its new volumes could not be removed. Inspect their restore labels and remove only that run's volumes. |
| `INTERNAL` | Anything else |

See the [verification checklist](verification/29-consistent-backups.md).
