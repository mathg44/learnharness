# Container outbound enforcement

The private server uses a dedicated `egress` container to own its network namespace. The unprivileged app shares that namespace. Only the guard has `NET_ADMIN`, and only in that namespace. It installs an nftables `inet lh_egress` table, not host firewall rules. This is a Linux Docker Engine installation, not Docker Desktop, rootless Docker, host networking, or an application proxy configuration.

This change is code and disposable-test work. Deployment, live provider calls, service restarts and cutover still require separate owner authorization. The existing Tailscale Serve route and model proxy do not need changes.

## Connections

| Traffic | Permission |
| --- | --- |
| Teaching, probing, practice, researcher, extraction, audit and PDF/vision models | Public TCP 80/443, or the one approved inference IP and TCP port in the private policy. Every role currently uses the same custom backend. Per-chat choices remain subject to the same network policy. |
| Custom provider discovery | The same model-service permission. Changing settings cannot grant a new private destination. |
| Search | Public HTTPS to Tavily, Brave, Exa, Firecrawl or hosted Ollama. The app additionally pins the exact API endpoint, method and credential for the selected engine. A key is still required. |
| Model-selected page/PDF URLs | Public TCP 80/443 only. `publicFetch` validates every DNS answer, redirect and connected peer. The inference exception is never an exception for these tools. Jina remains off in server mode. |
| Server dictation token | `POST https://api.deepgram.com/v1/auth/grant`, TCP 443. |
| Browser dictation audio | The learner's laptop or phone connects directly to `wss://api.deepgram.com/v1/listen`. Server-container filtering does not govern that browser connection. |
| DNS | Docker's embedded resolver, `127.0.0.11`, TCP/UDP 53 only, with host-inherited upstreams. A different nameserver fails readiness. Explicit container/daemon DNS overrides are unsupported; their sandbox-originated forwarding is blocked. |
| Local app health | App profile only, `127.0.0.1:3000`. Replies to accepted incoming connections remain permitted. |
| Browser network-test fixtures | Public TCP 80/443 and Docker DNS only. No inference exception, app-loopback exception, published CDP port, app storage or credentials. #27 tests this policy. |
| Production demo worker | No network at all. A private Unix socket carries bounded verification requests. Chromium sandboxing and process limits are described in the [server guide](private-server.md#interactive-demos-25). |

The network policy allows public provider APIs, not every provider's product flow. No subscription is enabled or live-tested by this work. Installed flows include OpenAI authentication at `auth.openai.com` and inference at `api.openai.com`, GitHub device authentication at `github.com` and Copilot APIs, and xAI authentication at `auth.x.ai` with inference at `api.x.ai`. Public HTTPS destinations fit the network policy. Private enterprise endpoints need a separate approved exception. Extra OAuth callback listeners are not published; in particular, ChatGPT's `127.0.0.1:1455` callback is not made remotely usable here. Claude Code is not installed or enabled. Desktop subscription, updater and browser behavior is unchanged. See the [source inventory](container-egress-research.md) and [architecture](architecture.md#host-and-providers).

## Rules and failure behavior

The guard starts with outbound default-deny rules and no timed grants. Before recording its network baseline, it waits up to five seconds for IPv6 duplicate-address detection and local address routes to settle. A failed or unsettled address refuses startup. Later address or route loss still invalidates enforcement. Public traffic excludes the conservative IANA special-use ranges used by `publicFetch`; IPv6 must be ordinary global unicast in `2000::/3`, excluding special ranges. Mapped IPv6, NAT64 and transition ranges do not bypass the rules. Private, loopback, gateway, tailnet, link-local and metadata access is denied except for the exact connections above. Minimal IPv6 neighbor discovery supports the network itself; arbitrary UDP and ICMP are not web permissions.

Outbound grants expire in five seconds and are renewed every second. Original-direction packets, including packets on established connections, must match current grants. There is no general established-connection bypass. If the guard crashes or stalls, the kernel stops outbound traffic when the grants expire. A socket may remain open but cannot continue transmitting. Local health and responses to incoming app requests can remain available.

The app starts only after the guard writes a new heartbeat following the startup check. Guard health checks require the same fresh confirmation. A still-unexpired file from a dead guard is not enough, even if Linux reuses its namespace inode on the same boot. Research and downloaded-PDF admission checks then read the current five-second lease every time. The status must be root-owned, non-writable by the app, fresh on the boot clock, from the current kernel boot, in the same network namespace, and match the policy and network topology. The boot ID prevents persisted state from matching a reused namespace inode and uptime after a reboot. An environment flag or stale file cannot enable a capability. Without a valid check, tools are omitted and stale/direct calls and recovered jobs are refused. Files, local-path PDF jobs, demos and visuals retain their separate mount, sandbox and native-render checks.

Container address, route, routing-rule or resolver changes invalidate the topology. Unexpected topology or firewall changes latch a guard fault, restore the known default-deny table with empty grants, and remove ready status. They do not silently create a new baseline. Resolve the cause and explicitly recreate the pair under the maintenance procedure. Public DNS answers can change without a firewall update because public addresses on ports 80/443 are already allowed. The application still resolves and validates each web/PDF request. The private inference exception is an IP literal and never follows a hostname to a newly permitted private address.

On the verified Docker Engine, host-inherited upstream DNS forwarding runs in Docker's host namespace. Explicit `--dns`, Compose `dns`, or daemon DNS overrides instead forward from the sandbox and are blocked. Do not add an upstream port-53 or UID-wide exception as a workaround. Keep inherited DNS and consult the [tagged Moby source findings](container-egress-research.md#docker-dns-forwarding).

## Private configuration

Keep the policy outside the checkout, Docker build context, artifacts and GitHub. It contains no credentials. The guard needs to read it without gaining filesystem-bypass capabilities: use a private parent directory with mode `0700` and a readable policy file with mode `0444`. The app and guard mount that file read-only.

Example only, not the installation's address:

```json
{
  "version": 1,
  "profile": "app",
  "inference": { "address": "100.64.0.42", "port": 11434 },
  "denyCidrs": []
}
```

Omit `inference` if no private backend is approved. The exception accepts one RFC1918/CGNAT IPv4 address or ULA IPv6 address and one TCP port. It does not accept hostnames, networks, loopback, metadata or link-local addresses. An exact inference tuple takes precedence over a general deny CIDR; other ports at that address remain denied.

Populate `denyCidrs` with any known publicly numbered host addresses and local network prefixes that must not be treated as public websites. Review host addresses and routes locally with `ip address show` and `ip route show table all`; do not publish the output. `0.0.0.0/0` and `::/0` deliberately deny all public egress, useful for an ingress-only synthetic check.

The private server environment file now needs both values:

```dotenv
LH_SERVER_ORIGIN=https://your-server.your-tailnet.ts.net
LH_EGRESS_POLICY_FILE=/absolute/private/path/egress.json
```

A new private backend address or port requires approval, a policy update and pair recreation. Do not copy the real exception into this repository. File bind mounts can retain an old inode after an atomic host-file replacement, so editing the host file is not a supported live-reload procedure.

## Installation and replacement

These commands are maintenance recipes, not authorization to run them on the live profile. Stop admissions and wait for background work before any approved replacement. Back up both app volumes as described in the [private server guide](private-server.md#snapshot-before-updates).

```bash
# SERVER_ENV points outside the checkout to the private environment file.
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml build egress demo app

# Stop the dependent before its namespace owner.
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml stop app demo egress

# Replace BOTH containers. Never recreate just the namespace owner.
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml up -d --no-build --force-recreate --wait egress demo app
```

The app keeps `app-data` and `app-auth`; the separate `egress-state` volume holds no learner data or keys. Port `127.0.0.1:3000:3000` is published by the guard because Docker does not let a namespace-sharing dependent publish ports. The Next server still handles the connection and Tailscale identity checks. Do not publish any other port or attach another container to this namespace.

`depends_on` waits for guard health at Compose startup. It does not supervise every later daemon restart. The entrypoint's independent status check handles that case. If the guard is recreated alone, the old app namespace cannot use the new guard's status, and the old namespace's grants expire. Recreate both to restore service. Never start an unrestricted app as a workaround.

## Inspection and diagnosis

Run locally, keeping configuration and logs private:

```bash
docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml ps

docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml logs --tail=100 egress

docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml exec -T egress nft list table inet lh_egress

docker compose --env-file "$SERVER_ENV" -p learnharness \
  -f compose.yaml -f compose.server.yaml exec -T app node --input-type=module -e \
  'import { enforcementReady } from "/usr/local/lib/learnharness/egress/state.mjs"; console.log({ enforced: enforcementReady() });'
```

Expect guard health, an outbound drop policy, expiring public/DNS/inference grants, and `enforced: true`. `false` can mean missing/invalid policy, unreadable or untrusted status, expired grants, a namespace mismatch or a topology fault. Check guard logs first. Do not print auth files or change the host firewall to diagnose an app failure. A healthy local HTTP response alone does not establish outbound enforcement.

## Removal

Removal needs the same live-service authorization as installation. Stop the app before the guard. Remove only this Compose project's containers and network with `down`, without `--volumes`. Keep both app volumes and their backups. Once the containers no longer reference the guard namespace, its nftables rules disappear with that namespace. No host rules or Tailscale routes need undoing. The private policy and unused state volume may be removed separately after confirming the exact project and volume names. Never use global Docker prune or flush nftables.

Removing the guard is not permission to run this server unrestricted. Research and PDF protections require it. Rolling back to an older image or network recipe is a separate security decision.

## Limits and verification

The host, Docker administrator, guard and configured inference backend are trusted. Container output filtering sees destination addresses before subsequent host/router NAT. It cannot prove that every public address will never be rewritten to a local service later. Explicit known-local CIDRs reduce that risk but do not make this protection against a compromised host or router. The inference backend itself may make further requests outside this container's control.

The owner's browser is outside the container policy too. Browser dictation connects directly to its configured service. Displayed demos use an opaque iframe and block HTTP resources, fetch and navigation, but DNS/preconnect and WebRTC UDP remain possible. The owner accepted those client-side channels; the browser is not fully offline. Production verification instead uses a networkless worker with its own Chromium sandbox proof. No claim of that sandbox's readiness follows from the older disposable Chromium network test.

See the [verification checklist](verification/27-container-egress.md). Disposable checks use controlled endpoints, not the real proxy, subscriptions, searches or learner records. Passing them does not approve live deployment.
