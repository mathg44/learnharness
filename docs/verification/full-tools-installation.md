# Full server tools and installation checks

Use synthetic files and providers for candidate checks. Keep real profiles, deployment configuration, logs and backup archives outside Git and build contexts. This checklist is not permission to stop a service, call a provider, change ingress or reboot a host.

## Candidate

- [ ] Run the full test suite, typecheck and lint on the pinned Node 26 runtime. Run tests without external networking and with disposable data/auth/home directories.
- [ ] Run the server materials tests against both permitted and forbidden synthetic paths. Cover missing policy, writable or wrong-source mounts, missing protected paths behind symlinks, caller-supplied policy overrides, traversal, symlink escapes and direct low-level entry points. Browser Settings must not widen access.
- [ ] Run the server visual and native-readiness tests. File/URL references, active SVG, duplicate IDs, excessive reference expansion and oversized canvases must be refused before native rendering. A native failure must not launch a browser. Verify annotation snapshot ownership, inspection and saved delivery with synthetic engines.
- [ ] Follow the [demo worker checks](../../scripts/demo/README.md). Prove the Chromium sandbox actually works under the intended Compose restrictions. Verify successful execution, script errors, timeouts, cancellation, bounded admission, cleanup and restart. No `--no-sandbox`, privileged container, host network or Docker socket is permitted for generated code.
- [ ] Exercise displayed and downloaded demos in a real browser. Verify interaction, saved replay, app-data isolation and denial of HTTP resources, fetch and frame navigation. Record the owner-accepted DNS/preconnect and WebRTC UDP channels; the client is not fully offline. A server firewall does not protect the learner's browser.
- [ ] Build immutable candidate app, guard and demo-worker images from the checked source. Record their image IDs and source revision/digest. Do not overwrite the running image's only tag.
- [ ] Inspect the merged Compose configuration. Only the guard gets `NET_ADMIN`; the app shares its namespace; the demo worker uses `network_mode: none`. Only loopback port 3000 is published. The worker gets only its control-socket volume and no learner/auth/backup mounts. Check its CPU, memory, PID and temporary-storage limits.
- [ ] Run the container egress checks and the isolated production backup/restore smoke. Use disposable volumes only. Check actual app reads for chats, attachments, snapshots, graph, settings, prompts and provider bindings after restore, with networking disabled.
- [ ] Start the candidate with synthetic settings, separate data/auth volumes and a different project name. Verify all capability checks and real-route access denial, uploads, streams and readiness. Do not let it write live volumes.

## Replacement

- [ ] Obtain owner approval for the specific replacement. Preserve the existing URL and model connection. Do not alter unrelated services, Tailscale routes, Funnel or the host firewall.
- [ ] Preserve the running image ID, matching Compose files, private environment, egress policy and demo seccomp profile. Keep the source/release bundle and every required image for the 14-day rollback window. Record the previous deployment separately if it predates the guard or demo worker.
- [ ] Confirm `/api/chats` has no `busy` or `compacting` sessions and `/api/activity` has no jobs or extractions. Pending learner questions can remain saved. Prevent new learner work during the short replacement window.
- [ ] Take a consistent data/auth snapshot. For an older image without the capture hook, stop the app first and copy both volumes while stopped. Check the archive and checksum before proceeding. Never copy live JSON files as a substitute for a consistent snapshot.
- [ ] Restore the snapshot into new disposable volumes and compare inventories. Open the copy through app reads with `--network none`, using the recorded server mode and matching image. Never connect a recovered profile to a real provider just to inspect it.
- [ ] Replace the app, guard and demo worker as one deployment, preserving one writer and the original data/auth volumes. Require Compose health and fresh namespace-bound egress state. A failed protection must refuse startup or tool admission, not fall back to an unrestricted recipe.

## Installed version

- [ ] Verify actual container image IDs against the checked release. Verify loopback publication, guard namespace sharing, read-only materials, offline demo networking and sandbox health.
- [ ] Compare the preserved chats, attachments, image snapshots, graph and settings through app reads. Print only statuses, counts and comparison results, not learner contents or credentials.
- [ ] Verify unauthenticated requests and wrong host/origin requests are denied. Verify the existing Serve URL still reaches the app and the server page carries its offline-demo frame policy.
- [ ] Verify files, research, PDF, demo and visual readiness in the actual installed process. Local-path PDF and annotation reads must remain restricted to `/materials`.
- [ ] Create and verify an online daily backup. Confirm the 03:00 server-local timer is enabled and observable. A template in the repository is not an installed schedule.
- [ ] Separately authorize real model requests before testing live streamed/tool/subsequent turns or model-role/image capabilities. Synthetic checks and model listings do not prove live provider support or output quality.
- [ ] Have the owner check the normal lesson interface in their browser. Record unverified items and any accepted limitations without calling them complete.

## Rollback

A failed replacement before learner work resumes can return to the preserved image/configuration and consistent snapshot. Verify restored volumes offline before promotion. Never run old and new versions against the same data/auth profile simultaneously.

After learner work resumes, do not silently replace current records with the pre-update snapshot. That would discard post-update work. Stop and obtain the owner's recovery decision first. Keep the old images and configuration until the 14-day rollback window ends; do not use global Docker prune.

Backups remain on the server. Disk/server loss and off-host copies are separate concerns. The [backup guide](../backups.md) covers retention, consistency and failure diagnostics.
