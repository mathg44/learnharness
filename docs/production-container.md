# Production container with persistent sessions

This packages the existing browser app for local testing. It does **not** approve live installation or remote access. Security/advisory, filesystem/network authority, real demo-browser, and ingress gates from [the baseline](server-baseline.md#blockers-and-next-ticket-boundaries) remain open. Web mode has no user login or per-browser learner isolation. Loopback publication is not protection against hostile local software or DNS rebinding.

## Build

Use Linux Docker Engine and Docker Compose 2.24.4 or newer. The isolated runner also needs Bash, Git, curl, and coreutils. No host Node, npm, Pi, Electron, browser, or personal profile is required. Linux x86_64 is the verified architecture; other architectures need their own native smoke results.

```bash
docker build -t learnharness:local .
```

The multi-stage [Dockerfile](../Dockerfile) uses the official Node 26.13.0 Bookworm image pinned to the digest verified in issue #1. Both build and runtime use that digest. It runs `npm ci` against the unchanged upstream lockfile, then `npm run build`. The final command is `node server.js`, Next's standalone **production** entry, with `public/` and `.next/static/` assembled. It does not start `next dev` or an Electron desktop process.

Builds need public download access for npm dependencies and the Google fonts already declared in `app/layout.tsx`. The lockfile and base image are fixed, but this is not an offline, byte-identical build guarantee. No credentials, build secrets, provider environment, or personal records are needed. Do not pass them as build arguments. The deny-by-default [.dockerignore](../.dockerignore) admits app source and the three container assembly/startup files, not Git history, `.pi/`, local dependencies, environment files, data, uploads, backups, or tests. Keep private files outside the source tree regardless of ignore rules.

Desktop payload curation is deliberately not used. The traced Electron package is not removed, but this image does not install or validate its browser binary/libraries. Demo dependency imports pass; real interactive-demo execution remains a separate gate. The locked Electron package attempts its installer when its binary is absent; the traced image lacks that installer's dependency and availability checking fails. This is not a usable browser fallback. Do not disable mandatory demo verification or treat this image as full demo readiness.

## Run only with approval

Use the supplied Compose recipe; plain `docker run` does not apply its read-only root, tmpfs, dedicated volumes, or loopback-only publication. The following is a generic recipe, not an instruction to install a live service. A persistent service, startup changes, provider configuration/calls, and remote ingress each need owner approval. For disposable automated checks, use the next section instead.

```bash
# Run from the checkout. Do not load an ambient .env file.
docker compose --env-file /dev/null -p learnharness-local up -d --build --wait
# Open only on the host: http://127.0.0.1:3000

docker compose --env-file /dev/null -p learnharness-local ps
docker compose --env-file /dev/null -p learnharness-local stop
# Removing containers/networks preserves the two named volumes.
docker compose --env-file /dev/null -p learnharness-local down
```

The project name is part of storage identity. Reusing it retains records; changing it starts another profile. Never run two app processes against the same data/auth volumes. Do not scale this service. Do not use `down --volumes` with records you want to keep. Make private backups of **both** volumes while the app is stopped before upgrades; container replacement is not a backup and these files are not a transactional database.

The server listens on `0.0.0.0:3000` **inside** the container so Docker can forward traffic. [compose.yaml](../compose.yaml) publishes only `127.0.0.1:3000:3000`, not a LAN/Tailscale/wildcard host address. Do not replace it with `3000:3000`, host networking, or a remote proxy before the separate access gate passes. No proxy or firewall configuration is included. While the port is published, trust only local access. Existing web APIs have no browser-user authentication; the separate access/host gate must address DNS rebinding and cross-site writes. Use a current Docker Engine; older Docker versions have known localhost-publication caveats.

The default bridge permits outbound traffic. This is not the final network security policy. Fresh profiles contain no models or credentials, so model-driven teaching requires explicit configuration. `localhost` in a custom endpoint means the **container**, not the host. Host provider access and real endpoint configuration belong to the later approved deployment setup, not this recipe.

## Writable locations and identity

The app runs as numeric UID/GID `1000:1000`, including startup. Root owns runtime code, and Compose makes the root filesystem read-only. Capabilities are dropped, privilege escalation is disabled, and Docker init forwards signals/reaps children. There is no privileged mode, host network, Docker socket, host home, SSH, Obsidian, or general Pi mount.

| Location | Storage and purpose |
| --- | --- |
| `/data` | Dedicated `app-data` named volume, `LH_DATA_DIR`. Conversations including plans/practice/usage, jobs/delivery records, graph ledgers/metadata/positions/rendering, settings, prompt overrides, and optional debug output. |
| `/auth` | Dedicated `app-auth` named volume. `LH_AUTH_FILE=/auth/auth.json`; web ChatGPT/Copilot/Grok credential sidecars and atomic-write temporary files live beside it. Mount the directory, not a single auth file, because saves use rename. |
| `/tmp` | 256 MiB tmpfs with `noexec,nosuid,nodev`. Temporary files, empty container home, XDG configuration/cache/data directories. Cleared on restart/replacement. |
| `/app/.next/cache` | Separate 256 MiB tmpfs for Next/image cache, owned by UID 1000. Rebuildable, never learner storage. |
| `/app` and `/usr/local/lib/learnharness` | Read-only application, assets, startup and health code. |

Fresh named volumes inherit owner `1000:1000` and mode `0700` from the image. Startup uses umask `077`; the auth store writes mode `0600`. It never escalates or recursively chowns a host path. A wrongly owned replacement mount fails startup. Do not mount existing Pi/Obsidian records or import an old learner profile. Auth is plaintext private storage, not an encrypted vault. The app process and its file-reading tools can read what is mounted, including auth; container isolation does not solve that separate authority review.

Browser file paths refer to the container's filesystem. This change adds no host-file mounts or upload sandbox. Claude Code authentication is not imported, and its external CLI is not installed. Subscription connections are shared server state. In particular, ChatGPT's extra loopback OAuth listener is not published by this recipe, so its callback is not validated here. Do not assume Docker makes that sign-in flow work.

## Health, failure and shutdown

The image checks `GET http://127.0.0.1:3000/api/settings` every 30 seconds, with a 4-second request timeout, 5-second Docker timeout, 30-second startup allowance and three failures before unhealthy. This checks local HTTP/JSON handling, not provider availability, disk durability, or correctness of every record. It performs no provider calls or persistent writes.

`restart: unless-stopped` restarts an exited app and is suitable for restart after Docker daemon/host startup when the daemon already starts normally. It does **not** restart a live but unhealthy/hung process. Inspect health and intervene only under an approved operating procedure; no watchdog or daemon/startup policy is installed here. A manual stop remains stopped. Host reboot/daemon restart is not tested or authorized by this issue.

Compose allows 30 seconds after SIGTERM. Startup uses `exec`, not an npm/shell process holding the signal. Verified idle standalone shutdown took about one second and reported exit **143**, SIGTERM, without OOM or SIGKILL. This is not proof that in-flight server-owned turns drain: admission persists inputs first, but active output/steering can still be lost or left incomplete on termination. Wait for work to settle before planned replacement. Existing job-recovery behavior is unchanged.

## Isolated verification

```bash
bash scripts/check-production-container.sh
```

This checks the current working-tree build inputs, including uncommitted changes, unlike the committed-snapshot baseline runner. It builds a unique temporary image and creates uniquely named Compose projects/volumes. It never uses the generic run recipe's project or data. Avoid running it against a checkout containing private source files.

The app, synthetic OpenAI-compatible provider, and route driver share a Docker **internal-only** network. No real endpoints/accounts or host environment keys are supplied. Through application routes the runner:

1. Checks `/`, `/chat/new`, static assets, and an empty `/api/chats` and `/api/settings`. It checks that `/settings` redirects to `/chat/new`; Settings itself opens from the sidebar as a dialog.
2. Connects a synthetic custom provider via `/api/custom-provider`; saves Strong/Cheap/Vision slots, reading size, dormant prompt text and graph rendering settings.
3. Creates a teaching chat at `/api/chats`, submits input at `/api/chat`, and waits for a pending `probe` through `/api/chats/[id]/stream` and `/api/chats/[id]`.
4. Restarts the container, compares the public conversation/settings/graph/prompt records, and answers the restored Probe. Imports synthetic notes at `/api/graph/import` through the real extractor/auditor, then verifies the proposition at `/api/graph`.
5. Removes/recreates the app container while keeping its volumes, then compares the same route records. Freezes/thaws the app to check health, and kills its Node process to prove restart-policy recovery and retained records.
6. Checks effective Docker permissions/mounts/bindings, private modes, rejected code writes, writable data/auth/tmp/cache, cleared tmpfs, and idle SIGTERM shutdown.
7. With `--network none`, exercises PDF text/page rendering, native SVG, Photon in-process/worker resizing, all ten native Pi implementations, offline Google/Bedrock/subscription initialization, and Puppeteer dependency import from the final image. The source-native probe uses a test-only TypeScript extension resolver; the production HTTP process has no such hook.

This Docker version suppresses port publication on internal networks. A separately approved second project therefore starts a fresh **unconfigured** app on an ordinary bridge, publishes an ephemeral **host-loopback-only** port, checks its effective binding, performs only `GET /api/settings`, and removes the project/volumes. No provider is configured in that container. This is the only runtime part of the recipe with an external-capable bridge. Test health intervals are shortened to two seconds; production health timings remain as above.

Normal cleanup, including failed checks and caught INT/TERM signals, removes test containers, networks, volumes, the temporary image tag, and scratch records. Evidence stays under `.git/pi-issue/container-checks/run.*/`. A failed cleanup or uncatchable termination needs manual review of the printed project names; never use global Docker prune. Docker's normal build/image caches may remain. No profiles or build artifacts are uploaded.

## Recorded results

Verified on Linux x86_64 with Node v26.13.0, npm 11.20.0, Docker Engine 29.7.2 and Compose v5.5.0. The upstream lockfile is unchanged.

- Production build and asset assembly pass. Four inherited dynamic-filesystem tracing warnings remain. Synthetic canaries verify private paths stay out of the Docker build context, and the base Compose port is checked before test overrides replace it.
- The unmodified application suite passes all 3,187 tests across 529 suites, with no skips. Typecheck passes. Lint passes with the inherited `tests/source-name-ui.test.tsx` warning.
- Fresh-state, pending/answered Probe, graph extraction and public-route persistence checks pass across restart, replacement and process-failure restart.
- UID/GID, capabilities, no-new-privileges, named-volume ownership, auth mode, read-only code, temporary writes and loopback publication checks pass.
- Container diff shows only Docker's injected `/usr/sbin/docker-init` and its parent directory metadata, not app writes outside the listed mounts.
- Unhealthy detection and recovery after thaw pass. An exited process restarts and retains records. Unhealthy alone deliberately does not trigger restart.
- Idle SIGTERM exits 143 without forced kill. No host startup/reboot or in-flight shutdown test was performed.
- Native PDF/SVG/image-worker/provider and demo-dependency import checks pass. Real browser/demo execution, real providers, subscription sign-in, remote access and deployment security remain unverified.

The unchanged application suite and advisory findings are recorded in [the baseline](server-baseline.md). This container does not remediate or accept those advisories. Keep it inaccessible to remote browsers until the independent gates pass.
