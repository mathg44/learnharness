# Explicit updates and rollback checks

No user-facing verification is required. This issue adds operator tooling and server-profile guards, not a new learning workflow. Normal packaged-desktop updating remains supported.

Use the [operator procedure](../server-updates.md). These checks do not authorize a live replacement, rollback, provider request, ingress change or reboot. Never mount live data/auth volumes into a candidate. Use only made-up profiles and credentials for automated verification.

## Prerequisites

- [ ] Use the reviewed branch and locked dependencies. Application checks run on pinned Node 26. The operator commands need Linux, Node 22 or newer, Git and the Docker CLI with Compose. Runtime checks need the prerequisites documented by their own scripts.
- [ ] Prepare two distinct disposable app images from the known previous commit and candidate commit. Use test-only tags, not `learnharness:*` or a registry-qualified production tag. Keep their exact image IDs in private evidence.
- [ ] Prepare disposable source, backup and release directories. Backup/release roots must be real directories owned by the operator, mode `0700`, outside each other, source/build contexts, Docker storage and mounted materials. Do not supply live env files, snapshots or learner data.
- [ ] Read the [backup guide](../backups.md), [private server guide](../private-server.md) and [demo-worker guide](../../scripts/demo/README.md). Make no host security or Tailscale changes.

## Automated checks

- [ ] Run `NODE_ENV=test node --import tsx --test tests/server-release-command.test.ts`. Expect the release CLI to preserve and verify a synthetic pre-update snapshot with matching service/config/image evidence. Expect unsafe roots, wrong source/config, missing/mismatched services/images/tags, partial/altered files, existing retention tags, failed tag cleanup and expired recovery material to be refused without printing contents or Docker stderr. Tests use real temporary files/Git and a fake Docker executable; they do not establish real-daemon image preservation.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/server-updates-runner.test.ts`. Expect bad arguments, production tags, missing images and identical previous/candidate image IDs to fail before runtime resources are created. No pull or unrestricted retry may occur.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/automatic-updates.test.ts`. Expect `LH_SERVER_MODE=tailscale`, an empty value and an invalid value all to prevent updater loading, startup/timer checks, manual checks and install/server shutdown. Existing normal-desktop checks, automatic preferences, staging and restart-order tests must still pass. These are fake-Electron checks, not a downloaded desktop update.
- [ ] Run the focused backup, materials, visual, attachment, provider-routing and server-access regression files applicable to the reviewed change. Run typecheck and lint. Record inherited warnings rather than hiding them.
- [ ] Build the production app, guard and demo worker from reviewed source. Run the existing egress and real-browser worker/display/download checks using their disposable resources. Expect enforced network/file/browser restrictions, fail-closed readiness and no unsandboxed fallback. The accepted client DNS/preconnect and WebRTC channels remain limitations, not a fully offline browser guarantee.
- [ ] Run `node scripts/check-server-backups.mjs <disposable-app-image>`. Expect coherent online capture, quiet/busy restore through app reads, failure refusal and source isolation. Run with synthetic records only.
- [ ] Run `npm test` once after implementation and fixes. Expect the full suite to pass under Node 26 without real provider credentials. Record all optional/platform skips and whether dependencies came from a clean install.

## Two-image replacement and rollback

Entry point:

```bash
node scripts/check-server-updates.mjs <previous-test-image> <candidate-test-image>
```

- [ ] Expect both image references to resolve locally to distinct immutable image IDs. A production tag, unavailable image or identical image pair must fail, not pull or substitute another image.
- [ ] Expect the previous image to start on new synthetic data/auth volumes with networking disabled and no published ports. Verify the runner checks actual app readiness and saved-record reads before taking the snapshot.
- [ ] Expect a verified pre-update snapshot, the previous app stopped, and the candidate started on a separate restored pair. No candidate may write source volumes or become a second writer on any profile.
- [ ] Expect exact matching app reads for conversations, pending questions, processed text/PDF/image attachments, image previews/snapshots, jobs, graph/source metadata, settings, prompts and provider binding. Etags are excluded by the existing projection. An intentional response-shape change must fail until explicitly reviewed, not be reduced to counts.
- [ ] Expect a candidate-only saved mutation to survive candidate restart while the previous source inventory remains unchanged.
- [ ] Expect the candidate stopped, the pre-update snapshot restored again into fresh volumes, and the previous immutable image started there. Its app reads must match the pre-update records; the candidate-only change must be absent.
- [ ] Confirm all check apps/helpers used `--network none`, read-only roots, unprivileged users and dropped capabilities. Direct `node /app/server.js` startup is allowed only in this networkless verifier. This is not a production entrypoint fallback and does not prove full capability readiness.
- [ ] Confirm success, failure and caught interrupt cleanup removes only resources carrying the run's ownership labels. Retain status-only evidence privately. Never use global prune.

## Preservation with a disposable Compose deployment

Use a synthetic three-service deployment with the reviewed recipes, fixed production restrictions and no real provider connection. A local Compose config-hash test alone does not prove that Docker tags, mounts or service state match.

- [ ] Take a synthetic `pre-update` snapshot using `scripts/server-backup.mjs create`, then run `verify`. Keep the original manifest and protection deadline.
- [ ] Run `node scripts/server-release.mjs preserve --snapshot <snapshot> --revision <full-source-commit> --source <source-checkout> --directory <release-root> --project <synthetic-project>`. Expect a newly published private release directory and matching app/guard/demo retention tags. No app, guard or worker may stop or restart.
- [ ] Confirm the retained source archive, root Compose/env/policy/seccomp files, image and volume overrides, snapshot copy and release metadata are present with private permissions. Compare the copied snapshot manifest to the original. Its 14-day protection deadline must not be extended.
- [ ] Repeat using verified image-only overrides, then a recovered profile on explicitly mapped data/auth named volumes. Expect preservation to check the reconstructed service configuration against Compose labels and retain the volume mapping. An unrelated mount/env/security override must be refused.
- [ ] Verify the release with `node scripts/server-release.mjs verify <release>`. Expect hashes, exact file set/modes, copied snapshot, image IDs, tag bindings and the original deadline to pass. The recorded source revision remains operator-declared, not proof of image build provenance.
- [ ] Remove one disposable retention tag, substitute a tag, alter a retained file and remove an image in separate disposable cases. Expect nonzero verification with a fixed diagnostic and no raw Docker output. Do not perform these destructive probes on live recovery material.
- [ ] Inspect the rollback recipe with `docker compose config` using the retained files, a private recovery env pointing to the retained policy, and explicit new restored-volume names. Expect retained image tags, correct fixed seccomp, guarded networking and one data/auth writer. Keep rendered configuration private.
- [ ] Remove only synthetic resources and test tags after checking their ownership. Leave live releases, images, backups and volumes untouched.

## Separately approved live operation

- [ ] Before replacement, present the exact candidate, test evidence, recovery release and original protection deadline to the owner. Obtain explicit replacement approval and wait for teaching, compaction and background work to settle. Prevent new work during the short window.
- [ ] Preserve and verify the current release immediately before replacement. A failed capture/preservation stops the operation. A prior synthetic check is not a live pre-update snapshot.
- [ ] Follow the [replacement commands](../server-updates.md#replace-only-with-approval). Stop and recreate app, guard and demo together, preserving the existing URL, connection and data/auth identity. Never omit an isolation layer to obtain startup.
- [ ] Before admitting learner work, verify actual installed image IDs, app reads, access denial, fresh enforcement, worker sandbox, materials restrictions, backups and the owner browser result. Ask separately before live model requests.
- [ ] If rollback is necessary before new learner work, obtain approval, keep candidate volumes intact, restore the preserved snapshot into new volumes, check it offline with the previous image and promote only the verified restored copy using retained configuration.
- [ ] If new learner work has been saved, stop for the owner's recovery decision. Preserve current volumes and take a fresh snapshot when possible. Do not silently discard that work or assume downgrade compatibility.
- [ ] Keep recovery images/configuration until the original 14-day protection deadline. Expiry does not authorize automatic deletion. Host-reboot verification and off-host recovery remain separate work.
