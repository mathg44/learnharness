# Verified upstream baseline for the fork

The sections through "Blockers and next-ticket boundaries" record the historical 2026-11-04 verification of upstream v0.4.1 for issue #1. Their results and blockers describe that revision, not the current installation. See [the post-v0.5.0 patch notes](#compatible-dependency-patches-after-v050) below for the current dependency update and [the private server guide](private-server.md) for current operating restrictions.

## Scope and provenance

Verified on 2026-11-04 for issue #1. This is a development/checking baseline, not approval to install or deploy the app.

- Upstream `v0.4.1` peels to `e69e85269c064c6c9c49a8b06ae78c06e79c4a63`. The annotated tag object is `e2b642ef84853d95af0286c4b8a4eedd1d694cea`.
- At the start, `main`, `server-deployment`, `origin/server-deployment`, and the issue branch all pointed to that commit. The owner approved replacing the issue's `server-deployment` integration target with normal feature branches into **the fork's `main`**. The old branch remains untouched.
- `origin` is `https://github.com/mathg44/learnharness.git`. `upstream` remains `https://github.com/amosblomqvist/learnharness.git`. Future PRs must explicitly target the fork, not upstream. Nothing was pushed, merged, deployed, or published during verification.
- Upstream history, [AGPL license](../LICENSE), author/homepage metadata in [package.json](../package.json), README attribution, and the custom-provider contributor acknowledgements remain unchanged.
- Read [AGENTS.md](../AGENTS.md), [development](development.md), [architecture](architecture.md), [custom providers](custom-providers.md), [Claude Code](claude-code.md), [desktop release](desktop-release.md), and the [golden fixture rules](../tests/fixtures/golden-data/README.md). There is no `CONTEXT.md` or separate contributor guide in this checkout. The installed Next 16.4.3 deploying, standalone-output, self-hosting, and environment-variable guides were also inspected under `node_modules/next/dist/docs/` in the disposable checkout.

## Reproduce the checks

Prerequisites are Linux, Bash, Git, Docker Engine access, GNU tar/coreutils, disk space for the Node image and temporary dependencies/build, and public HTTPS access for downloads. The runner needs no host Node, global Pi, browser, provider account, CLI authentication, or personal data.

```bash
# Run the exact upstream commit, regardless of current working-tree edits.
bash scripts/check-server-baseline.sh e69e85269c064c6c9c49a8b06ae78c06e79c4a63

# Check a committed fork revision, including its application changes.
bash scripts/check-server-baseline.sh HEAD
```

The argument is a Git commit/ref. **Uncommitted changes, including new files, are not tested.** Commit the revision to be checked first. The runner requires the pinned upstream ancestor and refuses known committed private/runtime paths before copying source.

The runner exports source with `git archive` into a temporary directory outside the checkout. Docker receives only that source, a disposable profile, and a read-only evidence directory. It does not receive the host home, environment files, provider variables, Docker socket, or CLI profiles. Data/auth live at `/profile/data` and `/profile/auth.json`, outside `/workspace`. No host ports are published. Temporary source, dependencies, build output, and profile are removed on normal exit, including failed checks. An uncatchable process/host termination can require manual scratch cleanup.

Evidence stays under Git's administrative directory at `pi-issue/checks/run.*/`: `runtime.txt`, `results.txt`, command logs, `audit.json`, and audit stderr. It is not part of source exports or build inputs. The runner exits nonzero for a failed check or invalid audit response. It continues independent checks after test/typecheck/lint failures; a failed build skips its dependent subscription smoke.

The commands inside the container are:

```bash
node --version
npm --version
npm ci
node node_modules/electron/install.js
npm test
npm run typecheck
npm run lint
npm run build
node scripts/smoke-web-subscriptions.mjs
npm audit --json
```

Installation, the explicit locked Electron download, the build, and audit have network access. The build downloads JetBrains Mono and Source Sans 3 through `next/font/google`, as declared in [app/layout.tsx](../app/layout.tsx). Tests, typecheck, lint, and subscription smoke run with Docker `--network none`, which still permits container loopback. No font mocks or changed package scripts are used.

Do not globally set `LH_IGNORE_ENV_KEYS=1` for this suite. Tests intentionally create synthetic environment keys to exercise precedence and admission. Environment isolation comes from Docker's explicit environment and absent host mounts, not from changing the behavior under test.

## Runtime and results

| Item | Verified value |
| --- | --- |
| Image | Official `node:26.13.0-bookworm`, pinned by digest below |
| Image digest | `node@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853` |
| Container | Debian 12, Linux x86_64, Node v26.13.0, npm 11.20.0 |
| Docker client/server | 29.7.2 / 29.7.2 |
| Lockfile SHA-256 | `c7df72f7f3e2d85e6c1da9d2624eadf34cabd08dbfb093e391ae690cfa99410f` |
| Framework | Locked Next 16.4.3 |
| Host left unchanged | Node v22.23.2, npm 12.0.2; general-purpose Pi untouched |

Both upstream documentation and [CI](../.github/workflows/ci.yml) specify Node 26. The lockfile installs and the exercised Node paths work in this Node 26 runtime. This is not a claim about all Node versions, operating systems, architectures, or Electron's bundled Node.

### Unmodified upstream checks

The completed runner invocation above, against the pinned commit, produced:

| Check | Result |
| --- | --- |
| `npm ci` | Pass, 1,127 packages added; deprecation/install-script warnings retained in log |
| Explicit locked Electron installer | Pass, Electron 44.9.3 binary downloaded; no desktop launch |
| `npm test` | Pass, 3,187 tests, 529 suites; zero failed, cancelled, skipped, or todo |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass with one warning at `tests/source-name-ui.test.tsx:26`, `@next/next/no-head-element` |
| `npm run build` | Pass; standalone server produced; four dynamic-filesystem tracing warnings |
| Web subscription smoke | Pass in production `start` and `dev`, with synthetic credentials and no external network |
| `npm audit --json` | Exit 1, 35 affected packages: 3 critical, 8 high, 24 moderate; see assessment below |

Build warnings point to `src/agent/subagents/headless.ts:183`, `src/agent/tools/pdf-read.ts:131`, and `src/store/graph.ts:333,335`. These warn about tracing the whole project. They were not suppressed. The inspected fresh standalone tree had no root `data/`, `auth.json`, `.env.local`, or `tests/fixtures/golden-data`; it did include broad source/documentation directories. This is not a general payload privacy certification.

### Initial failures and their reproduction

These occurred on untouched upstream source, before any fork application change:

1. **Runner setup error, not an upstream regression.** An initial full suite inherited the checking process's `LH_IGNORE_ENV_KEYS=1`. Focused reproduction with `node --import tsx --test tests/server-keys.test.ts` failed 4 of 17 tests with that variable and passed all 17 without it. Removing this runner variable restored the suite's intended synthetic credential behavior. No test or application code changed.
2. **Minimal-runtime prerequisite.** Fresh `npm ci` alone left the Electron binary absent. The clean full suite passed 3,186 of 3,187 tests. `tests/demos.test.tsx:867` expected `never wrote an SVG` but got `No render engine available`. A focused reproduction is:

   ```bash
   NODE_ENV=test node --import tsx --test \
     --test-name-pattern='runJob still steers on visual failure' tests/demos.test.tsx
   ```

   Run that in a fresh container after `npm ci`, with no installed Chrome and before the explicit Electron installer. [visual-maker.ts](../src/agent/subagents/visual-maker.ts) checks `headless.unavailableReason()` before its synthetic model; [headless.ts](../src/agent/subagents/headless.ts) resolves the Electron package or Chrome. Locked Electron 44.9.3's installed package metadata has no `scripts` lifecycle entry and exposes `install-electron` as a binary. Running `node node_modules/electron/install.js` downloads that exact version and makes all 3,187 tests pass. The owner approved this preparation step. This proves executable resolution for the fixture, **not a working Electron display/browser**.

No tests were removed, skipped, or relaxed. No teaching prompts, default models, provider selection, persistence formats, or app boundaries changed.

### Fork checks

[The fork workflow](../.github/workflows/server-baseline.yml) runs the same script against `HEAD` for pushes/PRs to the fork's `main`, plus manual dispatch. It uses Ubuntu 24.04 with the pinned container, read-only GitHub permissions, a full history checkout for ancestry validation, and no persisted checkout credentials. Its repository guard is `mathg44/learnharness`. Existing upstream workflows are preserved.

The local real-container runner passed against the pinned commit. Ten runner contract probes also verified safe snapshot/environment/network arguments, scratch cleanup, nonzero failure propagation with independent checks continuing, build-dependent smoke skipping, install failure stopping, malformed/transport audit failures, failed scratch allocation stopping before extraction, and rejection of private-path and unrelated-history commits. Bash syntax passed. No fork application regression exists in this change because application files and the lockfile are unchanged. GitHub-hosted execution remains unverified until an authorized push/PR runs it.

Audit findings are explicitly report-only in CI; malformed audit responses/transport failures fail checking. A green workflow does **not** approve those findings for deployment. Full logs, profiles, and build artifacts are not uploaded by the new workflow.

## What actually runs on a server

The production web entry is `npm start`, which runs `next start` after `npm run build`. The alternative is `.next/standalone/server.js`. Standalone needs its static assets copied, which the existing [build-server.mjs](../scripts/build-server.mjs) does along with payload checks and desktop-specific curation. A build alone is not an assembled, deployed server. Do not apply desktop curation blindly to a future web runtime that expects the development Electron helper.

The real pages are `/`, `/settings`, `/chat/new`, and `/chat/[id]`. Chat admission is `POST /api/chat`; saved sessions use `/api/chats`; turn replay/live events use `/api/chats/[id]/stream`; app-wide change events use `/api/events`. Graph and settings/provider operations are server-side APIs. [Architecture](architecture.md) and the generated build route table confirm these routes.

Electron is a thin launcher and security/credential/browser host, not the teaching engine. It launches the standalone server on loopback. A plain Next launch is not confined by that Electron setup: `next start` defaults to a wildcard listen address; standalone accepts `HOSTNAME`/`PORT`. Any future launch must choose an explicit bind address and independently approved access gate. No production listener was started here. Smoke servers were disposable, inside Docker without published ports.

### State and credential ownership

| State | Location and owner |
| --- | --- |
| Chats, plans, practice outcomes, usage | `LH_DATA_DIR/chats/*.json`, owned by the server process |
| Background jobs and delivery obligations | `LH_DATA_DIR/jobs/*.json` |
| Graph assertions/checkpoints/coverage | `LH_DATA_DIR/graph/{nodes,chains,sessions,coverage}.jsonl` |
| Imported-source metadata, positions, source organization, rendering | JSON files under `LH_DATA_DIR/graph/` |
| Preferences and prompt overrides | `LH_DATA_DIR/settings.json` and `LH_DATA_DIR/prompts/` |
| API keys/custom endpoint credential binding | `LH_AUTH_FILE`, a separate owner-only plaintext auth map |
| Web subscription credentials | `chatgpt-credentials.json`, `github-copilot-credentials.json`, `xai-credentials.json` beside `LH_AUTH_FILE`, including temporary atomic-write files |
| Packaged desktop subscriptions | Electron main-process credential owner/private transport, separate from web/dev profiles |
| Claude Code authentication | External CLI's own server-user environment/home/profile, not the app auth file |
| Provider/background debug traces | Under `LH_DATA_DIR/debug/` when explicitly enabled; may contain private lesson/source content |

See [config.ts](../config.ts), [storage adapters](../src/store/), [web subscriptions](../src/server/web-subscriptions.ts), and [development credential guidance](development.md#configuration-and-credentials). Defaults are repo `data/` and root `auth.json`; future deployment must override both to storage outside source/build contexts. Real environment API keys take precedence over saved keys. Custom-provider nonsecret settings and credential bindings must agree before authorization; keyless does not send a saved key. Auth files are not an encrypted vault.

Use one server owner/process per data/auth profile. Synchronous file IO, process-local queues/locks, and subscription refresh serialization do not support independent writers, multi-process scale-out, or per-browser learner isolation. Imported notes become graph/source records; learner file tools read original server files rather than creating an upload sandbox. Backups, source uploads, and learner records must never be placed in the source/build checkout. This ticket did not create personal records or choose a production storage layout.

### Model roles and external effects

[Role mappings](../src/core/settings.ts) and [resolution](../src/core/settings-resolution.ts) are explicit; there are no factory model selections:

| Role | Selection |
| --- | --- |
| Prober, teacher, conversational practitioner | Session's explicit model over Strong; new sessions copy Strong |
| Researcher, demo builder, extractor, auditor | Per-role override over Cheap |
| Visual maker, PDF reader | Per-role override over Vision |
| Session compaction | Session's own resolved engine, not a separate cheap-model default |

Background roles do not inherit an in-session model change. Missing configuration/credentials refuses rather than selecting another provider or paid route. See [models.ts](../src/agent/models.ts), [chat-handler.ts](../src/server/chat-handler.ts), and [compaction.ts](../src/server/compaction.ts).

Real model use sends relevant conversation/source context to the configured service. Optional search uses Tavily/Brave; direct fetching can use Jina Reader as fallback. Dictation mints Deepgram tokens server-side and sends browser audio directly to Deepgram. None of these live services or paid models was exercised. A custom OpenAI-compatible endpoint supports HTTP/HTTPS and private-network destinations; server deployment does not install or validate a local model backend.

### Native and desktop/browser dependencies

| Capability | Dependency or limitation |
| --- | --- |
| Next/Tailwind build | Platform-specific SWC, Tailwind oxide and related optional native packages from the lockfile |
| PDF conversion/rendering | PDF.js legacy worker/fonts plus `@napi-rs/canvas` Skia native binary |
| SVG rendering | `@resvg/resvg-js` platform native binary |
| Image conversion/resizing | Photon 0.3.4 JS/WASM and unbundled image workers |
| Interactive demo verification | Electron browser-service helper via Puppeteer, or system Chrome/Chromium via `CHROME_PATH`; no separate Puppeteer browser download |
| Local file path drag/drop | Desktop can obtain local paths; browser [drop zone](../components/file-path-drop-zone.tsx) tells users to paste a full path instead, which refers to the **server's** filesystem |
| Installed font enumeration, window controls, updates | Desktop capabilities; ordinary web mode is not an Electron shell |
| Web subscription connections | Server-owned shared connections; ChatGPT callback requires a browser on the server machine; Copilot/Grok use device codes |
| Claude Code | Separate opt-in external executable and native authentication under the server's OS user |

The app already externalizes native libraries and includes dynamic runtime assets in [next.config.ts](../next.config.ts). Do not cross-build native payloads or add broad tracing exclusions. Tests exercised native PDF/SVG/image paths under host Node inside Linux Docker. They did not launch the real Electron browser or prove Chrome fallback/demo execution. `ldd` on the downloaded Electron reported missing NSS/NSPR, GTK/ATK, CUPS, D-Bus, X11, GBM, keyboard, and audio libraries in the minimal image. No host packages, Xvfb, or browser were installed. Desktop packaging and Electron-runtime smoke checks are not claimed as passed.

## Dependency advisory assessment

`npm audit --json` on 2026-11-04 reported **35 affected package entries**, not 35 independent exploits. These include inherited/metavulnerability entries. The lockfile was not changed. Audit responses are date-dependent even with a fixed lockfile. Counts alone do not establish deployment reachability, and `--omit=dev` alone would miss libraries used while building untrusted source.

| Dependency and locked version | Assessment and disposition |
| --- | --- |
| `dompurify` 3.4.14 via Mermaid 11.17.0, critical aggregate | Mermaid renders model-authored diagrams in the browser. The app uses `securityLevel: strict`; inspected Mermaid calls sanitize strings, without `IN_PLACE`, `SAFE_FOR_TEMPLATES`, or XHTML parser mode. The reported [in-place hook](https://github.com/advisories/GHSA-p98j-92pf-mc4p), [shadow-template](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), and [XHTML/SMIL](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f) preconditions were not found in current configuration. This narrows the known paths, not a proof of no XSS. Diagram directives/frontmatter and plugin configuration were not exhaustively tested; defaults alone do not prove other sanitizer modes unreachable. Propose a targeted DOMPurify >=3.4.17 lock update with Mermaid rendering/security regression tests before deployment. |
| `shell-quote` 1.9.0 via `concurrently` 10.0.5, critical | [Command injection](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) requires a comment token followed by an attacker-controlled line terminator passed through `quote()` and then a shell. Concurrently is only used by the fixed `desktop:dev` script, not web production requests. Defer from the server runtime; a targeted >=1.11.0 update can address development tooling without replacing the application. Do not treat npm's aggregate critical label as an unauthenticated server RCE. |
| `undici` 7.29.0 via OpenAI SDK/Pi and Electron downloader, high | [Advisories](https://github.com/nodejs/undici/security/advisories) cover WebSocket, decompression, EventSource, retries/caching, and TLS dispatcher behavior. SDK presence means runtime relevance is possible, but this inspection did not establish that each affected optional API is used. Node's built-in fetch is a separate bundled implementation, not automatically fixed by changing the npm package. Block deployment sign-off pending a targeted >=7.30.1 update or adapter-specific reachability evidence, including custom endpoints and subscription transports. |
| `zod` 4.4.3 and Chromium BiDi's 3.25.76, high | [Oversized collection validation can exhaust memory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Pi/provider SDKs, MCP, and Chromium BiDi consume Zod. The external CLI MCP bridge is loopback/token-bound and opt-in, but SDK/model data remains a possible input. Propose a focused compatible 4.x >=4.6.6 update; the separate 3.x dependency needs its parent assessed rather than forcing all Zod versions to 4.x. Validate provider, custom endpoint, MCP and browser fixtures. Until resolved, runtime validation risk is a blocker to deployment sign-off. |
| `source-map-js` 1.2.1, high | [Indexed-map offsets cause resource exhaustion](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Present through Next/PostCSS/Tailwind tooling. No app route was found accepting source maps for processing. Lower direct serving risk, but build-input risk remains. A targeted >=1.2.2 update is preferable to upgrading the framework wholesale. |
| `linkify-it` 3.0.3 via `ansi-to-react` 6.2.6, high | [Quadratic matching](https://github.com/advisories/GHSA-22p9-wv53-3rq4) and [mailto scanning](https://github.com/advisories/GHSA-v245-v573-v5vm) can block rendering of hostile text. No application import of `ansi-to-react` was found in `app/`, `components/`, or `src/`. Installed does not prove an active request path. Recheck before enabling that renderer; no unrelated dependency removal here. |
| `brace-expansion` 1.1.18 and 5.0.9; `minimatch` 3.1.5 and 10.2.6, high/moderate aggregates | [Brace recursion/CPU](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [rewrite](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [comma parsing](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), and [glob amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) flow through ESLint, TypeScript lint tooling, and Electron packaging. App filesystem tools implement their own matching, not these packages. Treat as build/tooling exposure. Update compatible transitive patches in a bounded ticket; do not accept suggested major downgrades. |
| `fast-uri` 3.1.8 via AJV/MCP and packaging, moderate | [URI confusion](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) matters only where schema normalization affects a trust decision. Custom endpoint URL validation uses WHATWG `URL`, not this package. MCP remains a conditional SDK path. Propose a compatible >=3.1.9 update with MCP validation tests, not a blanket claim of unreachable risk. |

Remaining moderate package entries are propagated through ESLint and Electron packaging: `@electron/asar`, `@electron/universal`, `@eslint-community/eslint-utils`, `@eslint/config-array`, `@eslint/eslintrc`, `@next/eslint-plugin-next`, `@typescript-eslint/parser`, `@typescript-eslint/typescript-estree`, `app-builder-lib`, `dir-compare`, `dmg-builder`, `ejs`, `electron-builder`, `electron-builder-squirrel-windows`, `electron-winstaller`, `eslint`, `eslint-plugin-import`, `filelist`, `glob`, `jake`, `rimraf`, and `temp`. Their audit `via` chains terminate in the leaf advisories above. They do not justify npm's suggested old major versions of Electron Builder/Next lint tooling. Do not run `npm audit fix --force`.

No fixes were silently applied. Proposed targeted updates need owner approval and the full behavior suite, build, provider payload, and relevant native/browser gates. The current audit is evidence for those bounded tickets, not an acceptance of all risks.

## Privacy and history review

The checkout is not shallow. The review enumerated all locally reachable refs/history, 11,243 objects and 5,497 unique blobs, not just the current diff. Filename checks found no committed root app data/auth/subscription/env/upload/backup profile paths. All blobs were scanned for private-key blocks, GitHub token forms, AWS access IDs, and long provider-key forms; no matches were found. This is a heuristic review, not a guarantee against every possible secret format, arbitrary personal prose, or unavailable remote/deleted history. Repeat it before an authorized push, including any later commits.

Upstream's [golden fixtures](../tests/fixtures/golden-data/README.md) explicitly contain upstream-authored real application records and provenance. They are inherited compatibility fixtures, not the fork owner's learner records. They were neither rewritten nor represented as newly synthetic data. Removing them would weaken the upstream baseline. No fork-owner credentials, private endpoints/paths, learner records, uploads, or backups were introduced.

Only generic checking code and evidence documentation are added. `.pi/issue.json` is pre-existing local issue metadata and remains untracked. The new runner exports committed source only; private state stays outside the archive, dependency installation directory, and build context. Existing Git/build exclusions and standalone packaging guards are preserved. Do not rely on `.gitignore` as an artifact or filesystem sandbox.

## Blockers and next-ticket boundaries

There is no remaining blocker to reproducing the listed Node checks once the explicit locked Electron download is included. Deployment remains unauthorized and blocked on decisions/evidence outside this issue:

1. **Access and host gate.** [proxy.ts](../proxy.ts) delegates to [desktop access](../src/server/desktop-access.ts), which permits ordinary web mode without an Electron capability. There is no web-user authentication or per-learner isolation. Origin checks are not authentication/DNS-rebinding defense. A future ticket must choose and test an external access/host boundary before any exposure, plus an explicit listening address. No proxy or service policy was changed here.
2. **Filesystem/network authority.** Read-only [file tools](../src/agent/tools/fs-shared.ts) resolve against the server user's home and accept absolute paths. [Web fetch](../src/agent/tools/web.ts) follows ordinary URLs/redirects without a private-network destination gate; custom endpoints intentionally allow private networks. An approved deployment must bound what the server process can read/contact. No feature was disabled or filesystem behavior rewritten.
3. **Native/demo runtime.** A bounded verification ticket should prove real Electron-helper or Chrome demo execution in the intended isolated Linux runtime, with necessary libraries/display/sandbox choices. The passing missing-SVG fixture is not that proof. Do not remove mandatory demo verification to avoid the prerequisite.
4. **Advisory remediation.** Separate targeted runtime patches/reachability tests from tooling-only updates as described above. Unresolved DOMPurify, Undici, and Zod paths prevent deployment security sign-off. No broad upgrade or refactor is authorized.
5. **Remote subscriptions and process ownership.** ChatGPT's loopback callback is not implemented for an arbitrary remote browser; all browsers share server credentials and background-use consent. One process owns one data/auth profile. Any different requirement needs an explicit ticket and owner decision, not an implicit multi-user conversion.

No inspection proved a prerequisite broad refactor. The only implemented preparation change is explicit dependency-binary download in the checking script. If a later ticket proposes removing the visual worker's browser-availability coupling, first reproduce it with the focused test above and approve a bounded test-seam/guard change that preserves native rendering and mandatory demo verification.

## Compatible dependency patches after v0.5.0

This source update starts from `8c0a882`, after the historical baseline above. It changes compatible lockfile resolutions, not application code or deployment. Manifest ranges and existing overrides remain unchanged. The base already resolves DOMPurify to 3.4.17, npm Undici to 7.30.1 and root Zod to 4.6.7; those earlier fixes are retained.

| Dependency | Previous resolution | Patched resolution |
| --- | --- | --- |
| `concurrently` | 10.0.5 | 10.0.6 |
| Its exact `shell-quote` dependency | 1.9.0 | 1.12.0 |
| `fast-uri` | 3.1.8 | 3.1.9 |
| `source-map-js` | 1.2.1 | 1.2.2 |
| Vulnerable `brace-expansion` 1.x copies | 1.1.18 | 1.1.21 |
| `brace-expansion` 5.x | 5.0.9 | 5.0.12 |

Concurrently 10.0.6 supplies the fixed shell-quote through its own published exact dependency, without an override. All selected resolutions fit their declared parent ranges and Node 26. Unaffected brace-expansion 2.1.7 copies remain unchanged. The lockfile diff contains nine changed package entries and no added or removed packages.

These audit results describe different revisions:

| Audit date | Audited revision or lockfile | Affected package entries |
| --- | --- | --- |
| 2026-11-04 | Original upstream baseline `e69e852` | 35, including three critical |
| 2026-11-05 | Tested `2c6237a`, whose lockfile matches merge base `8c0a882` | 18, including two critical entries for one shell-quote advisory propagated through concurrently |
| 2026-11-05 | Patched dependency revision `90a8905` | 13, eight moderate and five high, with no critical entries |

The selected package advisories are absent from the patched report. Counts are date-dependent, not proof of exploitability or complete dependency safety. Independent Node 26 verification of `90a8905` passed 3,579 tests with four skips, typecheck, lint, build and subscription smoke. Lint retains one existing warning.

Chromium BiDi's Zod 3 dependency, minimatch and linkify-it remain deferred. Their fixes need separate parent compatibility work. Do not force nested major substitutions or use `npm audit fix --force`. The historical blockers above are not a current deployment assessment. This patch provides no new deployment sign-off: a trial update still needs separate owner approval and a consistent stopped-app data/auth snapshot under [the private-trial guide](archive/private-trial.md), now archived. No live provider or deployment operation is part of this update.

### Operator verification

No user-facing verification is required.

- [ ] Use the committed patch branch with Docker and enough temporary disk space for a clean Node 26 install/build. Leave the running trial and its data/auth volumes untouched.
- [ ] Inspect `git diff 8c0a882...HEAD -- package.json package-lock.json`. Expect no manifest changes and only the nine approved lock entries listed above.
- [ ] Run `bash scripts/check-server-baseline.sh HEAD`. It archives committed source into disposable containers with separate data/auth/home paths. Expect installation, tests, typecheck, lint, build and subscription smoke checks to pass. One existing lint warning is expected. The audit remains report-only.
- [ ] Inspect the printed evidence directory's `audit.json`. Expect no entries for `concurrently`, `shell-quote`, `fast-uri`, `source-map-js` or `brace-expansion`; record any new advisories separately. Remaining advisory entries are not accepted as fixed by this patch.
- [ ] For a focused development CLI check, use a separate disposable checkout with its locked dependencies installed. Run `node node_modules/concurrently/dist/bin/index.js --raw 'node -e "console.log(1)"' 'node -e "console.log(2)"'`. Expect both numbers, in either order, and exit 0. This must not start Next, Electron or a provider request.
