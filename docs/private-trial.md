# Private server trial

This is the reduced first-use deployment, not the original full server-hardening milestone. It keeps upstream teaching, practice, confidence input, mathematics, the knowledge graph, and uploaded-note imports. The desktop profile is unchanged.

## Restrictions

`LH_SERVER_TRIAL=1` disables agent filesystem tools, web research, PDF-reader jobs, generated demos, and visual workers. Registry, execution, dispatch, recovery, and worker checks enforce this even if Settings still shows an optional tool as enabled. Uploaded PDF notes can still be transcribed page by page with the configured PDF-reader model and extracted into graph material; that is not a retained-PDF teaching library. Page images go to the configured model provider and can incur usage charges. Server-path attachments and image reads through the disabled `read` and `show_image` tools are unavailable. Browser session uploads are a separate path: explicit file bytes become session-owned text or normalized images without those tools. Session PDFs use the session's selected model and existing connection for page transcription, not a new service or the graph-import pipeline.

The existing Docker isolation remains: non-root, read-only application files, dropped capabilities, dedicated data/auth volumes, and no host-home or Docker-socket mounts. Only host loopback publishes port 3000. Do not change that to a wildcard, LAN, or Tailscale address.

Tailscale Serve terminates HTTPS and supplies the authenticated owner's identity. The app requires that exact login, its configured HTTPS host, and matching Origin on writes. All application pages, data APIs and streams are guarded; public build assets are not private learner storage. Funnel must remain off. Local processes and host administrators are trusted. They can forge local proxy headers and already control the deployment or its credentials. This is not a multi-user server or protection against a compromised host.

There is no container-wide egress firewall in this trial. Instead, model-selected network/file capabilities are disabled. The fixed provider connection remains available. Do not restore optional tools without reviewing the restrictions they need.

## Start and stop

Use an explicit owner-only environment file **outside the checkout**, containing:

```dotenv
LH_SERVER_TRIAL_OWNER=owner@example.com
LH_SERVER_TRIAL_ORIGIN=https://your-server.your-tailnet.ts.net
```

Use the owner's actual Tailscale login and the exact Serve origin. No provider credential belongs in this file or in a build argument. The configured trial uses a fresh profile and the existing custom-provider API to save its separately protected endpoint binding and credential.

From the checkout:

```bash
# Point this at your private file; do not create it in the repository.
export TRIAL_ENV=/absolute/private/path/trial.env

docker build -t learnharness:trial .
docker compose --env-file "$TRIAL_ENV" -p learnharness-trial \
  -f compose.yaml -f compose.trial.yaml up -d --no-build --wait

# Stop only this app. Named data/auth volumes remain.
docker compose --env-file "$TRIAL_ENV" -p learnharness-trial \
  -f compose.yaml -f compose.trial.yaml stop
```

Keep this Compose project name stable and run one writer only. Never use `down --volumes` on records you want to keep. Container replacement retains the named volumes. `restart: unless-stopped` uses Docker's existing restart behavior; this trial does not change host startup configuration.

After owner approval, a host with no conflicting Serve route can use:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Do not run that blindly on a host with existing routes. Inspect the route and Funnel configuration first, preserve unrelated services, and verify the actual backend headers. Serve strips client-supplied Tailscale identity headers, but the app's authority depends on keeping the backend loopback-only. See [Tailscale Serve identity headers](https://tailscale.com/kb/1312/serve#identity-headers).

Configure models under Settings using the upstream custom endpoint editor. The trial's main model feeds teaching/practice; the Cheap slot feeds extraction/audit. The Vision slot is used for PDF note transcription; visual workers and PDF-reader jobs remain disabled. Model-list discovery does not prove context size, reasoning support or image understanding. Without supplied metadata or explicit pins, upstream's 8192-context and 4096-output fallbacks remain in effect. Change budgets only to values supported by the actual backend.

## Manual snapshot before updates

Wait for turns and background work to finish, then stop the app. Back up **both** named volumes while stopped. Store snapshots outside Git/build contexts with restrictive permissions; auth snapshots contain credentials.

```bash
umask 077
# BACKUP_DIR must be a private directory outside the checkout.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,src=learnharness-trial_app-data,dst=/data,readonly \
  --mount type=volume,src=learnharness-trial_app-auth,dst=/auth,readonly \
  node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853 \
  tar -czf - -C / data auth > "$BACKUP_DIR/trial-$(date +%Y%m%d-%H%M%S).tar.gz"
```

Check the command succeeded before restarting. Retain the previous image before building a replacement. There are no automatic upstream updates, scheduled backups, automatic data expiry, guaranteed downgrade compatibility, or protection against server/disk loss. Do not overwrite live volumes to test a restore.

## Trial evidence

The final trial suite passed all 3,222 tests, production build, typecheck and lint. Lint retains one upstream warning. Compatible targeted updates address DOMPurify, npm Undici and the active Zod 4 dependency. The separate Zod 3 dependency remains under Chromium BiDi; trial demo/visual workers are disabled. This is not a claim that all dependency advisories are fixed.

Live checks used the owner's authorized proxy with synthetic learning content: streamed GPT 6.1 Sol question/answer turns with saved confidence and reasoning, a practice problem, and uploaded-note extraction/audit through the configured Opus 5.5 background slot. The saved lesson survived container replacement. A real Chromium browser opened the HTTPS lesson and rendered mathematics without page errors. These checks do not prove model quality or every provider capability.

The owner confirmed that the trial works and model communication succeeds. Exhaustive interruption testing, a host reboot, daily backup/restore automation, update rollback exercises, and restoring optional tools are deferred. They are not trial-launch blockers.

## Upstream v0.5.0 merge verification

This is a source update, not a deployment. Upstream `713377f` supplies v0.5.0. The merge retains the trial access gate, container restrictions and dependency fixes. Its new `show_image` file reader is blocked in trial mode at both declaration and execution. Outside trial mode, upstream image and folder features remain available.

### Prerequisites

- [ ] Use the merge branch, Node 26 and the locked dependencies. Leave the running trial, its volumes and private configuration untouched.
- [ ] Use synthetic records, an empty auth file and a free loopback port 3001. Do not load provider credentials, subscription profiles or `.env.local`. Do not submit a teaching question during these checks.

### Browser check

- [ ] Start an isolated browser-mode development server from a clean checkout without `.env.local`:

  ```bash
  scratch=$(mktemp -d /tmp/lh-merge-manual.XXXXXX)
  chmod 700 "$scratch"
  mkdir -p "$scratch/home" "$scratch/data"
  printf '{}\n' > "$scratch/auth.json"
  chmod 600 "$scratch/auth.json"
  env -i PATH="$PATH" HOME="$scratch/home" \
    LH_DATA_DIR="$scratch/data" LH_AUTH_FILE="$scratch/auth.json" \
    NEXT_TELEMETRY_DISABLED=1 \
    npm run dev -- --hostname 127.0.0.1 --port 3001
  ```

- [ ] Open `http://127.0.0.1:3001/`. Expect a fresh learner profile, not the trial's saved lessons.
- [ ] Click the composer paperclip. Expect a browser file picker for session uploads, not local-path insertion or a native folder menu. Without sending, select synthetic text/PDF files, then paste an image into the composer. Expect all files to remain listed with removal controls. Upload and model processing begin only when Send is pressed; do not send during this unconfigured check.
- [ ] Open Settings, then Agent, then Prompts. Expect a Practice prompt group. Open the Graph settings and expect an Extraction switch. Do not enable providers or start extraction.
- [ ] Stop only this development server with Ctrl+C. This check runs without trial mode so the local browser can inspect the upstream interface. It does not verify live ingress.

### Trial checks without a model request

- [ ] Restart that isolated server with the same paths and these additional environment values: `LH_SERVER_TRIAL=1`, `LH_SERVER_TRIAL_OWNER=owner@example.com`, and `LH_SERVER_TRIAL_ORIGIN=https://trial.example.ts.net`.
- [ ] Request `http://127.0.0.1:3001/api/chats/synthetic/images/synthetic` without identity headers. Expect HTTP 403, including for this new upstream image route.
- [ ] Repeat with `Host: trial.example.ts.net`, `Tailscale-User-Login: owner@example.com`, `X-Forwarded-Host: trial.example.ts.net`, and `X-Forwarded-Proto: https`. Expect HTTP 404 for the nonexistent snapshot, not access to another profile.
- [ ] Stop the isolated server before running tests so only one process writes the scratch profile. Run `node --import tsx --test tests/server-trial-tools.test.ts` with `NODE_ENV=test`, the disposable `LH_DATA_DIR`/`LH_AUTH_FILE`, and the clean environment above. Expect `show_image` to be absent from trial teacher tools and direct execution to return a trial refusal. The same suite checks that normal teacher tools remain available outside trial mode. No provider request is needed.
- [ ] Remove only the disposable scratch directory after inspection. Deployment, a trial restart and real-provider verification still need separate owner approval.

## Next session

The reduced installation was accepted, but it is not the final product target. The owner has approved a permanent single-owner installation with all upstream capabilities restored under suitable isolation. [The permanent-installation plan and its linked issues](https://github.com/mathg44/learnharness/issues/31) track that work. The original deployment tickets remain historical; their closure did not implement the full milestone. This guide describes the current restrictions until the permanent installation is implemented and its cutover is approved.

Keep the running trial unchanged while the owner uses it. Obtain fresh approval before a restart, update, ingress change, or additional real-provider testing. Take a consistent stopped-app data/auth snapshot before replacing a version with learning records. No scheduled backup or restore exercise has been completed.

The fork's canonical integration branch is `main`; `server-deployment` is kept synchronized with merged work. Host-local handoff details are in `.git/pi-issue/private-trial-handoff.md`; that file and the private deployment configuration are excluded from source publication. Read that handoff before operating this host's trial, and inspect current runtime state rather than assuming it still matches this session.
