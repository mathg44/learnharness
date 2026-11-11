# Explicit server updates and rollback

The private server never installs upstream changes by itself. The operator reviews source, checks a candidate, preserves a recovery release and obtains approval before replacing the app, egress guard and demo worker together. A successful merge or build is not replacement approval.

This procedure is for the single-profile [private installation](private-server.md). Desktop releases and their updater are separate. No command here authorizes provider calls, ingress changes, a reboot or changes to unrelated services.

## Prerequisites

- Linux Docker Engine and Compose, Git, Bash and Node 22 or newer on the operator host. Application checks use the pinned Node 26 runtime.
- A clean, committed previous-source checkout and candidate-source checkout. Know which source produced the installed images. Do not infer that from the current branch or the app's package version.
- Keep an approved tooling checkout containing `scripts/server-release.mjs` and `scripts/server-backup.mjs` available throughout the rollback window. Set `TOOLING_CHECKOUT` to its absolute path. The preserved `source.tar` is an archive, not an already extracted tooling checkout. Set `PRIVATE_DIR` to an existing operator-owned `0700` maintenance directory outside checkouts, build contexts and mounted materials.
- The existing private env file, egress policy and approved materials folder. Keep them, release records and backup directories outside checkouts and build contexts.
- A private release root owned by the operator, mode `0700`. For example, create `/var/lib/learnharness-releases` with the same ownership discipline as the [backup root](backups.md#prerequisites). It must not overlap backups, Docker storage or any service mount.
- Enough space for both image sets, a consistent profile snapshot and disposable verification volumes. Never use global Docker prune to make room.

The examples use `learnharness` as the existing Compose project. Keep its name unchanged. Run one operator workflow at a time and one app writer per data/auth profile. Paths and revision values below are placeholders, not installed defaults.

## Review and integrate upstream

1. Record the installed source revision and actual app, guard and demo image IDs in private maintenance notes. Preserve the source checkout used to start that release.
2. Fetch upstream without merging it into the deployed checkout:

   ```bash
   git fetch --no-tags upstream
   git log --oneline <installed-revision>..upstream/main
   git diff --stat <installed-revision>..upstream/main
   ```

3. Review the proposed changes and their dependency/format implications. Pay particular attention to chat and graph version guards, settings, credential formats, provider routes, startup, filesystem access and browser/network isolation. A conflict-free merge does not prove compatibility.
4. Integrate only the approved changes through a focused branch and PR to the fork's `main`. Preserve AGPL attribution. Do not include credentials, learner records, private deployment metadata or unrelated upstream proposals.
5. Build and test the resulting fixed commit in a clean checkout or source export, not in the running release directory. Save the full commit ID. Review test expectations if an API shape intentionally changes; do not weaken the compatibility check simply to obtain a pass.

## Check the candidate

Use synthetic records and separate data/auth/home directories. Never mount the installed volumes into a candidate, even read-only, and never connect a restored personal profile to a provider.

Run the applicable checks before requesting replacement:

| Check | Required evidence |
| --- | --- |
| Full Node 26 suite, typecheck and lint | Teaching/probing/practice, provider routing, attachments, graph, format compatibility and updater regressions. Record skips and inherited warnings. |
| Production app build and native/provider smoke checks | Standalone startup, runtime assets and configured transport semantics with synthetic providers. |
| `bash scripts/check-container-egress.sh` | Real controlled public/private transport checks, fresh enforcement, fail-closed startup and access protection. |
| `tests/demo-browser/worker.ts` and `tests/demo-browser/run.ts` | Real sandboxed worker execution and display/download restrictions. Keep the accepted client DNS/WebRTC limitations explicit. |
| Server materials and native visual tests | Restricted file/local-PDF reads, native rendering and no browser fallback. |
| `node scripts/check-server-backups.mjs <disposable-app-image>` | Consistent capture, offline restore, failure diagnostics and app reads. |
| `node scripts/check-server-updates.mjs <previous-test-image> <candidate-test-image>` | Two-image replacement and image-plus-data rollback, described below. |

The [development guide](development.md#checks), [full-tools checklist](verification/full-tools-installation.md) and [demo guide](../scripts/demo/README.md) give prerequisites. Synthetic checks do not establish live entitlements or output quality. Real model-role tests require separate approval, as does testing a personal snapshot.

### Two-image replacement check

Build test-only app images from the known previous source and the committed candidate. Use separate tags such as `lh-update-check-previous:reviewed` and `lh-update-check-candidate:reviewed`, not the installation's `learnharness:*` tags. Then run:

```bash
node scripts/check-server-updates.mjs \
  lh-update-check-previous:reviewed lh-update-check-candidate:reviewed
```

The runner requires two distinct local image IDs. It never builds, pulls or selects a replacement itself. It uses a made-up saved profile and the existing backup CLI. The candidate gets fresh restored volumes, not the source volumes. It checks saved conversations, pending questions, processed text/PDF/image attachments, image snapshots, jobs, graph/source metadata, settings, prompts and provider binding through the app's own HTTP reads. It checks a candidate-only saved change across restart, then restores the pre-update snapshot into another pair of volumes and runs the previous image there.

Compared responses must match exactly after the shared backup projection removes etags. An intentional response-shape change requires review and an explicit test update. Counts alone cannot establish record preservation.

Every app and restore helper is networkless. The runner starts apps directly with `node /app/server.js` only inside these disposable `--network none` containers. This bypasses the production entrypoint's guard-startup check, not the in-app capability gates. Never use this startup recipe with a real network. It proves saved-profile compatibility and rollback, not full tool readiness or a production three-container cutover. The other checks above cover those boundaries.

A failure exits nonzero and removes only the run's owned resources. A refused candidate still runs the rollback check but leaves the overall result failed. Evidence goes to `LH_UPDATE_CHECK_EVIDENCE_DIR`, or `~/lh-update-check-evidence` by default, in a canonical operator-owned `0700` directory with `0600` files. If the home path contains a symlink, set an explicit canonical evidence path. Retain this status-only evidence privately. Exit codes are 0 for success, 1 for failure, 2 for invalid arguments, and 130/143 after interrupt/termination cleanup. Do not interpret a failed or incomplete check as permission to try the candidate on live records.

## Build immutable candidate images

Choose a fresh shared release ID from the candidate commit:

```bash
CANDIDATE_REVISION=$(git -C "$CANDIDATE_SOURCE" rev-parse HEAD)
CANDIDATE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${CANDIDATE_REVISION:0:12}"
```

Before building, require all three target tags to be absent. Do not overwrite an existing tag. Build from the reviewed candidate directory:

```bash
for service in server egress demo; do
  if docker image inspect "learnharness:$service-$CANDIDATE_ID" >/dev/null 2>&1; then
    printf 'Candidate tag already exists. Choose a new release ID.\n' >&2
    exit 1
  fi
done

docker build -t "learnharness:server-$CANDIDATE_ID" "$CANDIDATE_SOURCE"
docker build --target egress -t "learnharness:egress-$CANDIDATE_ID" "$CANDIDATE_SOURCE"
docker build -f "$CANDIDATE_SOURCE/scripts/demo/Dockerfile" \
  -t "learnharness:demo-$CANDIDATE_ID" "$CANDIDATE_SOURCE"
```

Record exact image IDs, source revision and check results. Build downloads need no provider credentials. If the locked Chromium package is no longer available, the demo build must fail until its pin and advisory assessment are deliberately reviewed.

Create a private image-only override for the candidate:

```yaml
services:
  app:
    image: learnharness:server-<candidate-id>
  egress:
    image: learnharness:egress-<candidate-id>
  demo:
    image: learnharness:demo-<candidate-id>
```

Use the actual chosen ID, mode `0600`, and keep the file outside the checkout. Do not add unreviewed service, mount, network or environment overrides.

## Preserve the previous release

Do this immediately before the proposed replacement, after preventing new learner work and checking that existing work has settled. An earlier candidate-test snapshot is not a live pre-update snapshot.

1. Read `/api/chats` and `/api/activity` through the installed app with the existing trusted access. Require no `busy` or `compacting` sessions, jobs or extractions. Saved pending questions can remain. Keep the replacement window free of new learner work.
2. With approval for the live backup, run the backup CLI from the previous-source checkout so its saved Compose recipes match that deployment:

   ```bash
   node "$PREVIOUS_SOURCE/scripts/server-backup.mjs" create \
     --kind pre-update --env-file "$SERVER_ENV" \
     --directory "$BACKUP_ROOT" --project learnharness
   node "$PREVIOUS_SOURCE/scripts/server-backup.mjs" verify "$SNAPSHOT"
   ```

   Set `SNAPSHOT` to the returned snapshot path without publishing its contents. If capture or verification fails, stop. Never copy changing JSON files as a substitute.
3. Run the new preservation helper from this release's tooling checkout, passing the previous source and its full commit ID explicitly:

   ```bash
   node scripts/server-release.mjs preserve \
     --snapshot "$SNAPSHOT" --revision "$PREVIOUS_REVISION" \
     --source "$PREVIOUS_SOURCE" --directory "$RELEASE_ROOT" \
     --project learnharness
   node scripts/server-release.mjs verify "$PREVIOUS_RELEASE"
   ```

   Set `PREVIOUS_RELEASE` to the returned release path. Preservation does not stop the app. It retains the verified snapshot without changing its protection deadline, source archive, configuration, seccomp profile and app/guard/demo image tags. It checks the running containers against the snapshot and the supplied source recipes. Verified image-only overrides and recorded data/auth volume-name overrides are supported; other unexplained overrides are refused.

The source revision is an operator declaration. Matching recipes, seccomp and Compose hashes do not prove that every image byte was built from that commit. The operator must retain trustworthy build/source evidence.

The private release bundle is never build input. Its saved recipes retain their original build entries for comparison, but recovery always uses `--no-build`. Never run `docker compose build` in that bundle or pass it to `docker build`. To rebuild source, extract `source.tar` into a separate clean directory with no private configuration or snapshots, then repeat the reviewed candidate-build procedure.

The helper never replaces a service, pulls images or deletes old releases. A failed preservation must not publish a usable-looking partial release. Resolve its fixed error code before proceeding.

## Replace only with approval

Present the previous recovery release, candidate commit/image IDs, check results, remaining limitations and downtime plan to the owner. Obtain approval for this specific replacement. Keep the existing origin, model connection, data/auth volumes, Tailscale routes and Funnel state unchanged.

Inspect the merged configuration locally. Its output may contain private deployment details; redirect it to a private file rather than a PR or public log:

```bash
cd "$CANDIDATE_SOURCE"
docker compose --project-directory "$CANDIDATE_SOURCE" \
  --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml -f "$CANDIDATE_OVERRIDE" config \
  > "$PRIVATE_DIR/candidate.compose.yaml"
chmod 600 "$PRIVATE_DIR/candidate.compose.yaml"
```

Require the same named data/auth volumes, only loopback port 3000, app namespace sharing with the guard, a read-only materials mount, no worker network and the expected seccomp/resource limits. No Docker socket or new host mount is allowed. Recheck idle state and the preserved release immediately before stopping anything.

Using that same source, env and exact file list:

```bash
docker compose --project-directory "$CANDIDATE_SOURCE" \
  --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml -f "$CANDIDATE_OVERRIDE" \
  stop app demo egress

docker compose --project-directory "$CANDIDATE_SOURCE" \
  --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml -f "$CANDIDATE_OVERRIDE" \
  up -d --no-build --force-recreate --wait egress demo app
```

Stopping all three first avoids leaving an app in an old guard namespace. Never recreate only the guard, run two writers, use `down --volumes`, omit protections or fall back to the base unrestricted recipe when startup fails.

Before admitting learner work, verify actual installed image IDs, Compose health, fresh namespace-bound enforcement, worker sandbox readiness, restricted materials, identity/host/origin denial, normal HTTPS access, preserved app reads and backup operation. Use the [installed-version checklist](verification/full-tools-installation.md#installed-version). A healthy `/api/settings` response alone is insufficient. Ask separately before any live model request. Record the installation time, source directory, exact Compose file list, env path and owner browser result. Ensure the existing backup service uses that installed source and env, rather than the previous checkout. Include any required backup-service path change in the approved maintenance plan; then create, verify and check the freshness of an online daily snapshot.

## Rollback and post-update work

The rollback window ends at the preserved pre-update snapshot's `protectedUntil`, exactly 14 days after capture. It is not 14 days after a later image build, preservation or deployment. `verify` reports expiry and refuses an expired recovery release. Keep every required image and configuration through the deadline. The retained snapshot copy does not extend the supported window.

### Before learner work resumes

A failed replacement can return to the previous images and pre-update data only with approval. Do not assume an older image can read the candidate's modified volumes.

1. Stop the failed app, guard and demo together using the candidate command's exact file list. Keep the candidate data/auth volumes intact for diagnosis.
2. Verify the preserved release, derive its copied snapshot path and restore it with the approved tooling checkout. Run the following in Bash with the variables above set. `set -e` stops on failure, and `noclobber` refuses an existing result file. Restore creates new `lh-restore-*` volumes and never writes the current ones.

   ```bash
   set -euo pipefail
   node "$TOOLING_CHECKOUT/scripts/server-release.mjs" verify "$PREVIOUS_RELEASE"
   PRESERVED_SNAPSHOT=$(node --input-type=module - "$PREVIOUS_RELEASE" <<'NODE'
   import fs from "node:fs";
   import path from "node:path";
   const release = process.argv[2];
   const meta = JSON.parse(fs.readFileSync(path.join(release, "release.json"), "utf8"));
   if (!/^pre-update-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(meta.snapshot.name)) process.exit(1);
   process.stdout.write(path.join(release, "snapshot", meta.snapshot.name));
   NODE
   )
   node "$TOOLING_CHECKOUT/scripts/server-backup.mjs" verify "$PRESERVED_SNAPSHOT"
   RESTORE_RESULT="$PRIVATE_DIR/restore.json"
   (
     umask 077
     set -o noclobber
     node "$TOOLING_CHECKOUT/scripts/server-backup.mjs" restore "$PRESERVED_SNAPSHOT" \
       > "$RESTORE_RESULT"
   )
   ```

3. Check the new volumes named in the private `RESTORE_RESULT` file with its recorded `imageId` and `--network none`, as described in [Checking a restored copy](backups.md#checking-a-restored-copy). Compare real conversations, attachment/image routes, graph, settings, prompts, jobs and provider bindings through app reads. Do not call a model.
4. Generate a private recovery env file from the recorded origin and retained policy, and a volumes override from the restore result. Both outputs refuse overwriting an existing file. Do not reuse a mutable external policy or source an env file as shell code.

   ```bash
   RECOVERY_ENV="$PRIVATE_DIR/recovery.env"
   RECOVERY_VOLUMES_OVERRIDE="$PRIVATE_DIR/recovery-volumes.override.yaml"
   node --input-type=module - "$PREVIOUS_RELEASE" "$PRESERVED_SNAPSHOT" \
     "$RESTORE_RESULT" "$RECOVERY_ENV" "$RECOVERY_VOLUMES_OVERRIDE" <<'NODE'
   import fs from "node:fs";
   import path from "node:path";
   try {
     const [release, snapshot, resultFile, envFile, volumesFile] = process.argv.slice(2);
     const runtime = JSON.parse(fs.readFileSync(path.join(snapshot, "runtime.json"), "utf8"));
     const { volumes } = JSON.parse(fs.readFileSync(resultFile, "utf8"));
     const data = /^lh-restore-([0-9a-f-]{36})-data$/.exec(volumes.data);
     if (!data || volumes.auth !== `lh-restore-${data[1]}-auth`) throw new Error();
     const origin = runtime.env.findLast(value => value.startsWith("LH_SERVER_ORIGIN="))?.slice(17);
     if (!origin || new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin) throw new Error();
     const policy = path.join(release, "egress.json");
     if (/['\r\n$]/.test(policy)) throw new Error();
     const options = { mode: 0o600, flag: "wx" };
     fs.writeFileSync(envFile, `LH_SERVER_ORIGIN=${origin}\nLH_EGRESS_POLICY_FILE='${policy}'\n`, options);
     fs.writeFileSync(volumesFile, JSON.stringify({ volumes: {
       "app-data": { external: true, name: volumes.data },
       "app-auth": { external: true, name: volumes.auth },
     } }, null, 2) + "\n", options);
   } catch {
     console.error("Recovery files could not be prepared. Inspect the private inputs.");
     process.exit(1);
   }
   NODE
   ```

5. Use the preserved recipes, seccomp and image override, plus the recovery env and volumes override. Inspect the merged configuration privately before starting. Keep the original Compose project and URL:

   ```bash
   RECOVERY_COMPOSE=(docker compose --project-directory "$PREVIOUS_RELEASE"
     --env-file "$RECOVERY_ENV" -p learnharness
     -f "$PREVIOUS_RELEASE/compose.yaml"
     -f "$PREVIOUS_RELEASE/compose.server.yaml"
     -f "$PREVIOUS_RELEASE/images.override.yaml"
     -f "$PREVIOUS_RELEASE/volumes.override.yaml"
     -f "$RECOVERY_VOLUMES_OVERRIDE")
   (
     umask 077
     set -o noclobber
     "${RECOVERY_COMPOSE[@]}" config > "$PRIVATE_DIR/recovery.compose.yaml"
   )
   chmod 600 "$PRIVATE_DIR/recovery.compose.yaml"
   ```

   Inspect that private file and obtain approval for this exact recovery. Only then start it with the identical arrangement:

   ```bash
   "${RECOVERY_COMPOSE[@]}" up -d --no-build --force-recreate --wait egress demo app
   ```

   The approved materials folder remains an external read-only dependency; it is not included in profile backups. The guard and demo socket state are recreated, not restored as readiness evidence.
6. Verify the installed old image IDs, app reads, access protections, readiness and backup operation again. Update the private deployment records and backup-service paths to the actual recovery recipes/configuration. Do not delete failed-candidate volumes or recovery material as part of this procedure.

Record the promoted storage layout in the private deployment notes. On the next update, preservation verifies the actual data/auth volume names against the new snapshot and running mounts, retains the mapping and checks the reconstructed Compose hashes. Other unexplained overrides still stop preservation.

### After learner work resumes

Stop and obtain the owner's recovery decision. Preserve the current data/auth volumes and take a fresh consistent snapshot when possible. Restoring the old snapshot discards newer work; an old image may also refuse newer storage formats. There is no automatic downgrade migration, selective data merge or promise of lossless rollback after work resumes. Do not overwrite current records with the pre-update copy without explicit approval of that loss.

## Retention and failures

Run `node scripts/server-release.mjs verify "$PREVIOUS_RELEASE"` before relying on a release. It checks retained files, the copied snapshot, local image IDs, tag bindings and the original deadline. A snapshot manifest is not an authenticity signature. Protect the release directory as carefully as credentials.

The release record stores image IDs and retention tags, not `docker save` archives. It survives ordinary untagged-image cleanup, not disk/server loss or a forced deletion of those images. Never prune globally. No helper ages out successfully retained releases or their image tags, and none deletes current volumes. Failed preservation cleans only its own staging or failed publication and newly created tags. Backup rotation does not visit the copied snapshot inside a release: its credentials and learner records remain there after the deadline until the owner removes the release. Cleanup after the rollback deadline is a separate operator decision.

CLI success prints JSON. Errors are fixed `server-release: CODE: message` diagnostics without Docker output, learner records or env contents. Usage errors exit 2; operational failures exit 1. Missing/mismatched images, changed files, unsafe directories, configuration mismatches, an existing retention tag or an expired snapshot all stop the workflow. A failed cleanup requires inspecting only that run's partial artifacts. Do not retry by disabling validation.

Common refusal codes:

| Code | Operator action |
| --- | --- |
| `RELEASE_ROOT_INVALID`, `RELEASE_LOCKED` | Check canonical path, ownership, mode and overlap. For a stale lock, confirm no preservation process remains before removing it. |
| `SOURCE_MISMATCH`, `CONFIG_MISMATCH`, `SECCOMP_MISMATCH` | Reconcile the actual installed source/configuration. Do not disable comparisons or substitute the candidate's recipes. |
| `SNAPSHOT_MISMATCH`, `SERVICE_NOT_RUNNING` | Confirm project identity and settled service state, then take a new verified pre-update snapshot if the app was recreated. |
| `TAG_EXISTS` | Choose a new preservation time. Never overwrite the existing retention tag. |
| `TAG_FAILED`, `RELEASE_CLEANUP_FAILED` | Stop and inspect this run's failed release directory, any quarantined copy and its new retention tags. Failed withdrawal keeps the tags so remaining recovery material stays complete, but the failed release requires owner review before use. If ownership is uncertain, obtain an operator decision instead of deleting anything. |
| `RELEASE_INVALID`, `IMAGE_MISSING`, `TAG_MISMATCH` | Recovery material is incomplete or changed. Do not begin replacement or assume a tag with the same name is equivalent. |
| `SNAPSHOT_EXPIRED`, `RELEASE_EXPIRED` | The supported rollback deadline has passed. Obtain a new recovery plan; do not edit timestamps to extend it. |

See the [manual checklist](verification/30-explicit-updates.md). Off-host recovery, final live model-role sign-off and host reboot verification remain outside this change.
