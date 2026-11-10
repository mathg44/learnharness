# Private Tailscale server

This is the permanent personal installation: one LearnHarness profile on a home server, reached through Tailscale Serve by the people on your tailnet. It replaces the reduced private trial, whose guide is kept in the [archive](archive/private-trial.md). Everyone who gets in shares the same chats, graph, settings and provider connection. There are no accounts and no per-person data. The desktop app and local development are unaffected.

## Access

Two environment variables turn on server mode:

| Variable | Value |
| --- | --- |
| `LH_SERVER_MODE` | `tailscale`. [compose.server.yaml](../compose.server.yaml) sets it. |
| `LH_SERVER_ORIGIN` | The exact Serve origin, for example `https://your-server.your-tailnet.ts.net`. HTTPS, no path, query or credentials. |

With `LH_SERVER_MODE` unset, the app behaves as it always has. With any value set, [proxy.ts](../proxy.ts) applies [server-access.ts](../src/server/server-access.ts) to every page, API route and stream:

- A request needs a non-empty `Tailscale-User-Login` header. Any login is accepted.
- `Host` must equal the origin's host. `X-Forwarded-Host`, when present, must match too, and `X-Forwarded-Proto` must be `https`.
- Writes (anything other than GET, HEAD, OPTIONS) need `Origin` equal to `LH_SERVER_ORIGIN`. Reads that send an `Origin` are held to it as well.
- If `LH_SERVER_MODE` is anything other than `tailscale` (including empty), or the origin is missing or invalid, every request gets 403. Compose refuses to start when `LH_SERVER_ORIGIN` is unset.

Refusals are `403 {"error":"Access denied."}` with `Cache-Control: no-store`. Built assets under `/_next/static/` stay public; they hold no learner data.

### What the identity check relies on

Tailscale Serve strips client-supplied identity headers and adds `Tailscale-User-Login` for tailnet users. It adds none for Funnel traffic or tagged devices, so those are refused. It does add them for users of other tailnets you have shared this machine with, so sharing the node gives that person full access. Who can reach the app is therefore set by tailnet membership, node sharing and your Tailscale ACLs. See [Tailscale Serve identity headers](https://tailscale.com/kb/1312/serve#identity-headers).

Keep these in place:

- The backend is published only on host loopback, `127.0.0.1:3000`. Anything that can reach the port directly can forge the headers. Never change it to a wildcard, LAN or tailnet address.
- Funnel stays off for this port.
- Local processes and host administrators are trusted. They can forge headers on loopback and can already read the app's credentials or control Docker. This is not protection against a compromised host.

The image's health check sends the origin's Host, a fixed `container-healthcheck` login and `X-Forwarded-Proto: https` to `GET /api/settings`. A misconfigured server reports unhealthy.

## Capabilities

Some tools can reach host files, the LAN or other services, so on a server they stay off until their protections exist. [server-capabilities.ts](../src/core/server-capabilities.ts) lists each capability with a `ready()` check:

| Capability | Tools and jobs | Restored by |
| --- | --- | --- |
| `files` | `read`, `ls`, `find`, `grep`, `show_image` | #22 |
| `research` | `research` job, `web_search`, `web_fetch` | #23 public transport plus fresh #27 container enforcement |
| `pdf` | `pdf` job, `web_fetch_pdf`, `pdf_info`, `pdf_extract`, `pdf_search`, `pdf_render` | #24 downloads plus fresh #27 enforcement; local-path jobs also require file access |
| `demo` | `demo` job | #25 |
| `visual` | `visual` job | #26 |

Research and downloaded PDFs require a fresh, namespace-bound check from the [container firewall guard](container-egress.md). Without verified enforcement they stay unavailable. Files, demo and visual checks still return false. There is no environment switch that marks enforcement ready.

While a capability is unavailable, the tool registries leave its tools out of what the model sees. Tool execution, job dispatch, the job runner (including jobs recovered after a restart) and the worker entrypoints each refuse it as well. The model gets `The "research" tool is not available on this server.` and jobs fail with a matching message. These checks apply whenever `LH_SERVER_MODE` is set at all.

Settings → Agent still shows switches for research, demo, visual and PDF. On the server they have no effect while the capability is unavailable. Turning one on does not bypass the check.

### Research network rules (#23)

Research requires both these application-level rules and #27's [verified container enforcement](container-egress.md). Missing or stale guard state keeps it unavailable; a Settings toggle cannot bypass that check.

In server mode, page fetches and search requests go through `publicFetch` in [public-fetch.ts](../src/agent/public-fetch.ts). It always enforces these rules. Inference providers get no exception.

- Only `http` on port 80 and `https` on port 443. URLs with embedded credentials are refused.
- Every DNS answer for the host must be a public address, and each redirect hop is resolved and checked again. Public means public IPv4 or ordinary global IPv6 in `2000::/3`, minus conservative IANA special-use ranges. IPv4-mapped, NAT64, Teredo and 6to4 addresses are refused.
- The connection goes to the vetted IP literal while keeping the original Host header and TLS SNI, so certificate checks still use the hostname. The socket's actual peer address is checked again before any HTTP is sent.
- Responses may use gzip, deflate or br. Any other content encoding is refused. Each response's headers are capped at 16 KiB. The transferred-byte budget counts received HTTP bytes before parsing, including headers, informational responses, chunk framing and every redirect hop. Decompressed content has its own counter under the same limit.
- Cancelling the tool call aborts the request in flight.

The two kinds of traffic get different limits:

| | `web_fetch` page | `web_search` |
| --- | --- | --- |
| Destinations | Any public URL | Five fixed endpoints, listed below |
| Redirects | Up to 5 | None, same host included |
| Time | 30 s for the whole chain: DNS, connect, headers, body | 30 s |
| Bytes | 5 MiB of received HTTP bytes across the chain, and 5 MiB after decompression | 1 MiB of received HTTP bytes, and 1 MiB after decompression |

The search endpoints in [server/search.ts](../src/server/search.ts) are the only ones a search key is sent to:

| Engine | Endpoint |
| --- | --- |
| Tavily | `POST https://api.tavily.com/search` |
| Brave | `GET https://api.search.brave.com/res/v1/web/search` |
| Exa | `POST https://api.exa.ai/search` |
| Firecrawl | `POST https://api.firecrawl.dev/v2/search` |
| Ollama | `POST https://ollama.com/api/web_search` |

The transport enforces each endpoint's listed method. POST endpoints accept no query string; Brave accepts only one `q` and one `count` parameter. Each engine sends only its own key. Engine selection is unchanged and read fresh on each call. A pinned engine without a key is reported as unavailable; the app does not quietly try another. On the server, search errors report the provider and HTTP status only, never response bodies or transport details.

Server page-fetch output is capped at 40,000 characters for the complete result, including the title, source metadata, errors and truncation marker. The Jina Reader fallback for JavaScript-rendered pages is off in server mode, since that service fetches the target itself and the local checks can't constrain it. Such pages fail with an honest extraction error. Desktop and local development keep plain `fetch` and the Jina fallback.

These rules apply inside the app, independently of #27's container firewall. Research PDF downloads reuse `publicFetch` under the rules below. Research and downloaded-PDF runtime readiness depends on the live guard. File tools remain disabled. Upload local material through the browser instead.

### Research PDFs (#24)

The researcher can download a PDF it finds online, inspect its page count, search its text and extract selected pages. Its brief keeps the source URL and page citations. It does not keep the original PDF as a document library. This requires #27's verified outbound enforcement.

| Path | Enforcement |
| --- | --- |
| `web_fetch` → PDF notice | Server page requests use #23's public transport and 5 MiB ceiling. A recognized PDF response points to `web_fetch_pdf`. |
| Researcher's `web_fetch_pdf` | Uses `publicFetch`, with the same URL, DNS, connected-peer, redirect and header rules as page fetching. No private service or configured inference proxy is an exception. |
| `pdf_info`, `pdf_extract`, `pdf_search` | Reopen only files downloaded by that research job. Canonical containment and the mandatory sensitive-path guard still apply. Pre-existing files, symlink escapes and paths from another job are refused. |
| Native inspection, text extraction, search and page rendering | Use pdfjs and Skia, not Chrome or a remote reader. No embedded PDF link is fetched. Open documents and pages are released on success, failure and cancellation. |
| Teacher's local-path `pdf` job | Remains unavailable without file capability readiness, even if research PDF readiness is restored. Direct worker invocation and recovered jobs obey the same check. No learner filesystem roots are added here. |
| Browser session uploads and graph PDF imports | Separate uploaded-byte transcription flows. Their models, role selection, usage accounting and stored transcriptions are unchanged. |

Server research PDF limits are fixed by the app, not model-selected arguments:

- 25 MiB of received HTTP bytes across all redirect hops and, independently, 25 MiB of decompressed body. HTTP headers and framing count toward the transfer budget.
- Five redirects and a 60-second download deadline across DNS, connection and body consumption. The enclosing download tool also has a 60-second guard including validation and triage. Other PDF text tools keep the shared 30-second guard.
- 1,000 pages, checked before inspecting or extracting pages. At most four successful downloads per research job, with pending downloads reserving a slot. Failed attempts release their slot.
- 40,000 characters per tool result, including JSON metadata and the truncation marker. Oversized structured results become a truncated text result; narrow the page selection or search.
- Native page rendering keeps the 16-megapixel and 8192-pixel-side limits. The researcher remains text-only and does not gain a vision model or `pdf_render` tool.

The runner creates a private `lh-research-*` directory under the OS temporary directory for each job. Download files have mode `0600`; directories created with `mkdtemp` have mode `0700`. The model receives a job-relative filename rather than a host path. Files are created exclusively. A failed download or validation removes its copy immediately. If that removal fails, the tool returns a safe cleanup error and the job's final directory removal still runs. Job completion, failure and cancellation remove the entire directory.

An abrupt process death can leave temporary copies until the container's `/tmp` tmpfs is cleared by stop/start or recreation. There is no retained-file index or automatic orphan sweep. Recovery reruns research with a new temporary directory and downloads fresh copies; it never reuses an old path. Keep one server owner per profile as documented above.

Cancellation reaches requests, file writes and PDF operations. PDF parsing and rendering are in-process, not an OS sandbox: a synchronous parser or canvas step must return before cancellation can take effect. The page and canvas limits are not a hard CPU or total-memory limit. Server tool errors omit request credentials, response bodies, parser diagnostics and private filesystem paths. Desktop keeps its existing fetch behavior and diagnostics.

See the [verification checklist](verification/24-research-pdfs.md).

Still available on the server: teaching, probing, practice, mathematics, the knowledge graph, uploaded-note imports (including page-by-page PDF transcription with the PDF-reader model), and browser session attachments. Session attachments are explicit uploads and do not enable file tools. See [session attachments](getting-started.md#attach-material-to-a-session).

## Start and stop

Keep a private environment file **outside the checkout** containing only:

```dotenv
LH_SERVER_ORIGIN=https://your-server.your-tailnet.ts.net
LH_EGRESS_POLICY_FILE=/absolute/private/path/egress.json
```

Prepare the private policy using the [container enforcement guide](container-egress.md#private-configuration). It must contain the separately approved inference exception, not a broad LAN or tailnet permission. No provider credential belongs in either file or in a build argument. Configure models in Settings with the custom endpoint editor, as before.

```bash
export SERVER_ENV=/absolute/private/path/server.env

docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml build egress app
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml up -d --no-build --wait

# Stop only this app. The named volumes remain.
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml stop app egress
```

For updates, stop and recreate both the app and its network guard together. Never recreate only the guard or fall back to the unrestricted base recipe. The [enforcement guide](container-egress.md#installation-and-replacement) covers pair recreation, inspection and removal.

The project name `learnharness` fixes the volume names `learnharness_app-data` and `learnharness_app-auth`. Keep it stable and run one writer. Never use `down --volumes` on records you want to keep. The image is about 2.1 GB; check free disk space before building. Isolation settings (non-root, read-only root, dropped capabilities, tmpfs, loopback port) come from [compose.yaml](../compose.yaml) and are described in the [production container guide](production-container.md).

Serve needs one route to the loopback port. On a host with no conflicting route:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Inspect `tailscale serve status` and `tailscale funnel status` before changing anything on a host with other services.

## Backups

[scripts/server-backup.mjs](../scripts/server-backup.mjs) snapshots both volumes while the app keeps running, with the running image ID, runtime environment and mounts. It also saves the supplied env file and matching egress policy, plus the checkout's Compose recipes. Take a `--kind pre-update` snapshot before every update. A daily systemd timer template is included but not installed. Snapshots stay on this host; they do not protect against disk or server loss. See [Private server backups](backups.md).

### Stopped-volume snapshot

The trial migration below still uses a plain copy of stopped volumes. Wait for lessons and background work to finish, then stop the app. Copy **both** volumes while stopped. Auth snapshots contain credentials; store them privately outside Git and build contexts.

```bash
umask 077
# BACKUP_DIR must be a private directory outside the checkout.
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,src=learnharness_app-data,dst=/data,readonly \
  --mount type=volume,src=learnharness_app-auth,dst=/auth,readonly \
  node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853 \
  tar -czf - -C / data auth > "$BACKUP_DIR/server-$(date +%Y%m%d-%H%M%S).tar.gz"
```

Check that it succeeded before restarting. Keep the previous image tagged before building a replacement. Tested update rollback is #30.

## Migrating from the trial

The trial ran as project `learnharness-trial` with image `learnharness:trial`, volumes `learnharness-trial_app-data` and `learnharness-trial_app-auth`, and an env file with `LH_SERVER_TRIAL_ORIGIN`. The new project gets new volumes, filled by a stopped-app copy. Nothing is deleted, and the trial stays restorable. Each step that stops, starts or changes the live service needs owner approval at the time.

1. **Build both images while the trial runs.** Use the build recipe above from the reviewed checkout after preparing the private environment and egress policy. Check disk space first.
2. **Write the new env file.** Copy the origin value from the trial env file into a new private file as `LH_SERVER_ORIGIN=...`, and add `LH_EGRESS_POLICY_FILE`. Leave the trial file unchanged for rollback.
3. **Check that the new volumes don't exist yet.** `docker volume ls --filter name=learnharness_app` must print no volumes. If it lists any, stop and find out why before going on.
4. **Wait until idle.** No lesson reply streaming in any open tab. Through the Serve URL, `/api/activity` must show `"jobs":[]` and `"extractions":[]`.
5. **Stop the trial.** `docker compose -p learnharness-trial stop`. This works without the removed `compose.trial.yaml`. Confirm with `docker compose -p learnharness-trial ps --all`, which should show the container exited. A manually stopped container stays stopped across Docker restarts.
6. **Snapshot the trial volumes** with the recipe above, using the `learnharness-trial_*` volume names and a `trial-` file prefix.
7. **Create the new project without starting it.**

   ```bash
   docker compose --env-file "$SERVER_ENV" -p learnharness \
     -f compose.yaml -f compose.server.yaml create
   ```

   This creates the Compose-labelled volumes and the container. Nothing runs yet. Docker initializes the new volumes from the image's empty `/data` and `/auth` directories, so they start owned by `1000:1000` with mode `0700`.

8. **Copy the data.** The copy runs as the app user, without network access, and reads the trial volumes read-only.

   ```bash
   docker run --rm --network none --user 1000:1000 \
     --cap-drop ALL --security-opt no-new-privileges --entrypoint /bin/sh \
     --mount type=volume,src=learnharness-trial_app-data,dst=/old/data,readonly \
     --mount type=volume,src=learnharness-trial_app-auth,dst=/old/auth,readonly \
     --mount type=volume,src=learnharness_app-data,dst=/data \
     --mount type=volume,src=learnharness_app-auth,dst=/auth \
     learnharness:server -c 'cp -a /old/data/. /data/ && cp -a /old/auth/. /auth/'
   ```

9. **Compare both sides.** The two inventories must be identical:

   ```bash
   inventory() {
     docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL \
       --mount type=volume,src="$1_app-data",dst=/v/data,readonly \
       --mount type=volume,src="$1_app-auth",dst=/v/auth,readonly \
       --entrypoint /bin/sh learnharness:server -c \
       'cd /v && find . -printf "%y %m %U:%G %P\n" | sort && find . -type f -print0 | sort -z | xargs -0 sha256sum'
   }
   diff <(inventory learnharness-trial) <(inventory learnharness) && echo identical
   ```

   It compares type, mode, owner and path for every entry, plus a SHA-256 for every file. The output shows names and hashes, not contents. Keep it private anyway.

10. **Start the new project.**

    ```bash
    docker compose --env-file "$SERVER_ENV" -p learnharness \
      -f compose.yaml -f compose.server.yaml up -d --no-build --wait
    ```

    It publishes the same `127.0.0.1:3000`, so the Serve route doesn't change.

11. **Verify.** `docker compose -p learnharness ps` shows healthy. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/settings` prints `403`, because there's no identity. In a tailnet browser, the Serve URL shows the existing sessions and graph.

**Rollback.** Stop the new project, then `docker compose -p learnharness-trial start`. The trial container still has its own image, environment and volumes. Anything learned after cutover lives only in the new volumes and would need a separate copy back.

**Never run both projects.** They are separate profiles. Both publish port 3000, so the second would fail to start, but don't rely on that.

**Later cleanup.** Removing the trial container, volumes, image or env file is a separate decision once the new installation has proven itself.

## Verification

- [Backups](backups.md) and their [verification checklist](verification/29-consistent-backups.md) cover online capture, snapshot checks, retention and restore into disposable volumes.
- [Container enforcement](container-egress.md) and its [verification checklist](verification/27-container-egress.md) cover policy, live namespace-bound readiness, disposable IPv4/IPv6 endpoints, browser/subprocess traffic, guard failure and recreation.
- `npm test` includes [server-access.test.ts](../tests/server-access.test.ts), [server-capabilities.test.ts](../tests/server-capabilities.test.ts) and [server-healthcheck.test.ts](../tests/server-healthcheck.test.ts).
- [server-research-pdf.test.ts](../tests/server-research-pdf.test.ts) and [server-pdf-jobs.test.ts](../tests/server-pdf-jobs.test.ts) cover #24 downloads, text reading, native rendering, denial, cancellation, cleanup and research dispatch/recovery with synthetic engines and public HTTP sockets. [pdf-ops.test.ts](../tests/pdf-ops.test.ts) and [pdf-native-render.test.ts](../tests/pdf-native-render.test.ts) cover native page limits and cancellation.
- [public-fetch.test.ts](../tests/public-fetch.test.ts), [server-search-fetch.test.ts](../tests/server-search-fetch.test.ts) and [server-research.test.ts](../tests/server-research.test.ts) cover the #23 rules, actual tool calls, research dispatch/recovery and pending session delivery. They use synthetic engines, controlled DNS and sockets, and real Node HTTP parsing. A disposable loopback listener also verifies rejection of a real mismatched socket peer before any HTTP bytes are sent. No live provider credentials are involved.
- [scripts/smoke-server-access-runtime.mjs](../scripts/smoke-server-access-runtime.mjs) builds the production standalone server in a disposable copy. It then sends accepted and rejected requests to pages, chats, uploads, image routes, provider and settings writes, the chat and events streams, and the health check. It covers server mode, misconfigured server mode and normal mode. Its header explains how to make the copy. It uses a synthetic provider that only answers model discovery.
