# Container outbound verification

## Prerequisites

- [ ] Use this branch and its locked dependencies. Run normal application checks on Node 26. The disposable runner requires Linux Docker Engine 29.7.2 or newer with Compose and isolated IPv4/IPv6 bridges, Bash, Git, curl, jq, iproute2 and coreutils. Allow enough disk for app, guard and test-only Chromium images. Image builds need public package/font downloads, but runtime probes use only controlled endpoints. The runner reports unsupported kernel/network features as failures, not skips or unrestricted retries.
- [ ] Use only synthetic endpoints, profiles and credentials. Do not mount live app volumes, private policy files, backups or learner records. No live provider or subscription request is required.
- [ ] Read [the policy and operating procedure](../container-egress.md). The approved private exception must remain outside Git. Running this checklist does not authorize deployment, a live restart, provider calls or host-security changes.

## Automated checks

- [ ] Run `npm run typecheck` and `npm run lint`. Expect no errors. The inherited `tests/source-name-ui.test.tsx` warning is unrelated.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/container-egress-policy.test.ts tests/container-egress-state.test.ts tests/server-egress-readiness.test.ts`. Expect invalid configuration, untrusted/missing/stale status, policy/namespace/topology mismatches and adapter failures to deny readiness. Fresh enforcement enables research and downloaded PDFs only, not files, local PDF jobs, demos or visuals. Five optional host user-namespace kernel tests are skipped by default; the mandatory Docker runner must still pass.
- [ ] Where unprivileged user/network/mount namespaces and nft are available, run the same command with `LH_EGRESS_KERNEL_TESTS=1`. Expect the optional real-kernel lifecycle and unsupported-resolver checks to pass. These namespaces are disposable; they do not alter the host firewall.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/public-fetch.test.ts tests/server-search-fetch.test.ts tests/server-research.test.ts tests/server-research-pdf.test.ts tests/server-pdf-jobs.test.ts tests/server-capabilities.test.ts`. Expect real tool admission, redirects, DNS aliases, mixed answers and connected-peer checks to remain enforced independently of the private inference exception.
- [ ] Run `bash scripts/check-container-egress.sh`. Expect a nonzero exit for any unsupported or failed enforcement check. Inspect its synthetic evidence under `.git/pi-issue/egress-checks/run.*`, not a live profile.
- [ ] In the runner results, confirm intended controlled public IPv4/IPv6 requests and the exact synthetic model service succeed. Other model-service ports and unrelated private, loopback, gateway, tailnet, link-local and metadata requests must fail. Redirects and aliases must not let web/PDF downloads use the inference exception.
- [ ] Confirm a real subprocess and a real Chromium browser are checked. The browser gets a separate public-only namespace, no inference exception, no app/auth/learner mounts and no published debugging port. This checks network enforcement, not #25's production browser sandbox.
- [ ] Confirm the guard-stall test blocks new and already-established outbound requests after the five-second lease expires. Namespace-owner replacement, pair recreation and topology-fault tests must not yield unrestricted access. Recovered research/PDF admissions must still require fresh guard state.
- [ ] Confirm the separate ingress-only fixture publishes a random `127.0.0.1` port and denies public egress with `denyCidrs` covering both address families. Expected HTTP results are 403 without identity and 200 for the synthetic trusted proxy request. The fixture must be removed afterward.
- [ ] Run `npm test` once after implementation and fixes. Expect the complete suite to pass, without real service credentials.
- [ ] Check cleanup evidence. Only uniquely named test resources may be removed. No live containers, Tailscale routes, host firewall rules or unrelated Docker networks may change. Build cache can remain; never use global prune.

## Manual user verification after authorized enablement

Entry point: the existing Tailscale Serve HTTPS URL, opening `/chat/new` on the learner's laptop or phone. Prerequisites are a separately approved deployment of the app and guard together, a valid private policy with the approved model proxy, configured models and a search key if testing discovery. These actions can send content to real providers and need separate authorization.

- [ ] Open the existing Serve URL on the laptop, then the phone. Expect the normal lesson interface and existing saved sessions. No new app port, public URL or login scheme should be needed.
- [ ] Start a synthetic lesson and answer a question. Expect normal streamed model replies through the existing proxy. In Settings, confirm Strong, Cheap and Vision selections have not changed.
- [ ] Open sidebar Settings → Agent, enable research, and ask for a brief about a known public page. Expect research dispatch and a result in the same lesson. If the guard is unavailable, expect research to be unavailable instead of silently using unrestricted networking.
- [ ] Ask research to inspect a small known public PDF. Expect its source URL and page citations. Ask it to fetch `http://127.0.0.1/` and expect a refusal, not local contents or a reader-service fallback. Test the inference exception with the disposable runner, not by giving the model the real private proxy address.
- [ ] Attach a synthetic local PDF through the browser composer and send it. Expect the separate upload/transcription flow to continue working. Server filesystem tools, local-path PDF jobs, demo and visual tools must remain unavailable.
- [ ] If dictation is already configured, start and stop it. Expect the browser to request its short-lived token and connect directly to Deepgram. This is not evidence that server filtering constrains the laptop or phone's own connections.

## Operator checks

- [ ] Before any approved live change, wait for lessons and background work to settle and back up both app volumes. Keep the current images and private configuration available for an approved rollback.
- [ ] Inspect the merged Compose configuration locally. Expect only the guard to have `NET_ADMIN`, the app to share `service:egress`, policy and status mounts read-only in the app, and only `127.0.0.1:3000:3000` published by the guard. No Docker socket, host networking, privileged container or host namespace mount is permitted.
- [ ] Run the inspection commands in [the enforcement guide](../container-egress.md#inspection-and-diagnosis). Expect a healthy guard, outbound default deny, expiring grants and `enforced: true` from the app. Inspect private addresses locally; do not paste them into a PR or issue.
- [ ] Perform fault injection only in the disposable runner. Do not freeze the live guard, alter live routes or probe unrelated home-network services to test denial.
- [ ] For an approved policy or image update, stop and recreate both containers together. Expect the same Tailscale URL, retained app/auth volumes, fresh namespace-bound state and renewed restrictions. An app left in an old namespace must not accept the replacement guard's status.
- [ ] For removal, follow the project-scoped procedure without `--volumes`. Expect app data/auth to remain and the namespace's rules to disappear with its containers. No host firewall or Tailscale cleanup should be needed. Removal does not authorize unrestricted server operation.

## Limits

The host, Docker administrator, guard and approved inference backend remain trusted. Later host/router NAT can rewrite a public destination outside the container's visibility. Known local public addresses belong in `denyCidrs`; this is not protection against a compromised host or router. No live provider, subscription, browser-account entitlement or production demo-isolation claim follows from synthetic tests. Record actual check results in the PR rather than treating this checklist as proof that they ran.
