# Private server trial

This is the reduced first-use deployment, not the original full server-hardening milestone. It keeps upstream teaching, practice, confidence input, mathematics, the knowledge graph, and uploaded-note imports. The desktop profile is unchanged.

## Restrictions

`LH_SERVER_TRIAL=1` disables agent filesystem tools, web research, PDF-reader jobs, generated demos, and visual workers. Registry, execution, dispatch, recovery, and worker checks enforce this even if Settings still shows an optional tool as enabled. Uploaded PDF notes can still be converted into graph material; that is not a retained-PDF teaching library. Server-path attachments and image reads through the disabled `read` tool are unavailable.

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

Configure models under Settings using the upstream custom endpoint editor. The trial's main model feeds teaching/practice; the Cheap slot feeds extraction/audit. The Vision slot is dormant while its workers are disabled. Model-list discovery does not prove context size, reasoning support or image understanding. Without supplied metadata or explicit pins, upstream's 8192-context and 4096-output fallbacks remain in effect. Change budgets only to values supported by the actual backend.

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

## Next session

The private trial is accepted and the deployment tickets are closed. Earlier full-milestone tickets were superseded or deferred, not implemented in full. Future work starts with the owner's next request, not by reopening that backlog.

Keep the running trial unchanged while the owner uses it. Obtain fresh approval before a restart, update, ingress change, or additional real-provider testing. Take a consistent stopped-app data/auth snapshot before replacing a version with learning records. No scheduled backup or restore exercise has been completed.

Source changes are on `server-deployment`. Host-local handoff details are in `.git/pi-issue/private-trial-handoff.md`; that file and the private deployment configuration are excluded from source publication. Read that handoff before operating this host's trial, and inspect current runtime state rather than assuming it still matches this session.
