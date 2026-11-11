# Demo worker

In server mode the demo builder's generated HTML runs here, in a separate
container, and never in the app. The container has no network
(`network_mode: none`), no app data, no credentials, no Docker socket and no
environment from the app. The app reaches it only through an HTTP-over-Unix-socket
control channel on the private volume `/run/learnharness-demo`, which the app
mounts read-only (connecting to the socket works on a read-only mount).

Files:

- `controller.mjs` serves `/run/learnharness-demo/demo.sock` (mode 0600, uid 1000).
  `GET /health` answers 200 only after the sandbox self-test has passed.
  `POST /run` takes `{html, probe?, settleMs?}` and returns the demo run result.
  Limits: 1 MiB request body, 512 KiB of HTML, 4 KiB probe, one run at a time,
  at most two queued, 60 s per run. Closing the connection cancels the run.
- `browser.mjs` starts a fresh Chromium for each run: empty profile in a
  temporary directory, CDP over `--remote-debugging-pipe` (no port), killed
  together with every descendant process when the run ends. The document is
  served from `https://demo.invalid/` through Fetch interception, never
  `file://`. Its response carries `sandbox allow-scripts` plus the offline CSP,
  so the page gets the same opaque origin as the displayed iframe. Every other
  request fails and is reported. A main-frame navigation to anything else,
  `data:`, `blob:` and `about:` included, fails the run, and the replacement
  document is never probed.
- `cdp-pipe.mjs` is the protocol transport. No puppeteer and no app
  dependencies in the image.
- `healthcheck.mjs` is the container healthcheck.
- `Dockerfile` (with `Dockerfile.dockerignore`) uses the root image's pinned
  Node 26 base and Debian's `chromium=156.0.8078.79-1~deb12u1`. It copies only
  these files and `src/core/demo-document-policy.ts`. Debian's security
  archive keeps only the current Chromium, so a rebuild fails until the pin is
  updated. That is on purpose.

## Sandbox

Chromium runs with its sandbox on. No `--no-sandbox`, no setuid helper, no
privileges. Each run proves the sandbox from the kernel's view before the
demo's bytes reach the browser, and again before it returns. Every renderer
must be in its own user, PID and network namespace, carry more seccomp
filters than the controller (Chromium's seccomp-bpf on top of Docker's) and
have `no_new_privs` set. The command lines must hold none of the flags that
weaken the sandbox. The startup self-test also requires `chrome://sandbox` to
say "You are adequately sandboxed". If any check fails, the worker refuses
runs and reports unhealthy, and the app's readiness check denies demos.

Under Docker's default seccomp profile Chromium exits with "No usable
sandbox". The worker uses its own profile, `seccomp.json`.

### seccomp.json provenance

`seccomp.json` is the official Docker default profile, `seccomp/default.json`
from [moby/profiles](https://github.com/moby/profiles) at tag
`seccomp/v0.2.3` (the version Docker Engine 29.7.2 vendors; upstream file
SHA-256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`),
copyright The Moby Authors, licensed under the Apache License 2.0. The license
is in `seccomp.LICENSE`. The upstream rules are unchanged and come first. Three
rules are appended, each marked with a `learnharness-demo:` comment:

1. `clone` is allowed when its flags request no namespaces other than user, PID
   and network. The mask `0x0E020000` (`CLONE_NEWNS | CLONE_NEWCGROUP |
   CLONE_NEWUTS | CLONE_NEWIPC`) must be zero. Without CAP_SYS_ADMIN, the
   upstream profile allows `clone` only with no namespace flags at all.
2. `unshare` with the same mask, same limits.
3. `chroot`. Chromium chroots its sandboxed processes into an empty
   directory inside their new user namespace. Outside one, the kernel still
   requires CAP_SYS_CHROOT, which the container does not have.

Nothing else changes. `mount`, `setns`, `bpf`, `pivot_root` and the other
CAP_SYS_ADMIN-gated calls stay gated. `clone3` still returns ENOSYS so glibc
falls back to `clone`. The container still runs with `cap_drop: [ALL]`,
`no-new-privileges`, AppArmor's default profile and no host changes.
`tests/demo-worker-socket.test.ts` pins the three additions. To check the
profile against upstream:

```sh
curl -fsSL https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.3/seccomp/default.json | python3 -c '
import json, sys
up = json.load(sys.stdin); ours = json.load(open("scripts/demo/seccomp.json"))
assert ours["syscalls"][:len(up["syscalls"])] == up["syscalls"]
assert all(ours[k] == up[k] for k in up if k != "syscalls")
print(len(ours["syscalls"]) - len(up["syscalls"]), "added rules")'
```

## What "offline" covers

The worker is offline: its container has no network interface besides
loopback.

The learner's browser is network-restricted, not offline. A server-mode demo
runs in a sandboxed `srcdoc` iframe (`allow-scripts` only) with the offline
CSP in the document, and the server page sends
`Content-Security-Policy: frame-src 'none'; child-src 'none'`. A downloaded
demo gets the same frame inside a fixed, script-free outer page whose CSP
does the header's job. `tests/demo-browser/run.ts` checks both in Chromium
156. These are blocked: subresources of every kind, fetch, XHR, WebSocket,
WebTransport, EventSource, beacons, pings, workers, dynamic import, forms,
popups, top navigation and self-navigation (location, meta refresh, link
click, `data:`). Storage, cookies and the app's DOM are unreachable.

Residual channels that remain, accepted by the owner:

- WebRTC. `RTCPeerConnection` sends STUN and TURN UDP to any host. CSP does not
  govern ICE, and Chromium 156 ignores `webrtc 'block'`. Deleting the
  constructor would not help, because a nested `srcdoc` frame gets a fresh one.
- DNS. `<link rel=preconnect>` and `<link rel=dns-prefetch>`, in the markup or
  added by script, resolve any hostname. `X-DNS-Prefetch-Control: off` on the
  parent page does not stop explicit link hints.

The demo has no app data to send. What it can leak is that it was opened,
when, from which resolver or IP, and anything the learner types into it.

## Tests

- `tests/demo-worker-socket.test.ts` (in `npm test`) covers the controller and
  the app adapter over a real socket with a fake browser: readiness, limits,
  queueing, cancellation, the 60 s limit, sandbox refusal and the seccomp
  additions.
- `tests/demo-offline-policy.test.tsx` (in `npm test`) covers the document
  policy, the card under each runtime policy (saved demos included) and the
  builder's server prompt, offline gate and cancellation.
- `tests/demo-browser/worker.ts` (manual, needs Docker) runs the real worker
  through the real adapter. It covers success, errors, denied
  network/file/private/app access, navigations away, malformed and oversized
  input, a renderer crash, cancellation, the busy-page timeout, process-tree
  cleanup, and refusal under Docker's default seccomp profile.
- `tests/demo-browser/run.ts` (manual, needs Docker) is the display and
  download proof described above. For the WebRTC residual, run it on a
  disposable internal network:
  `docker network create --internal lh-demo-probe-net`,
  `LH_DEMO_PROBE_NETWORK=lh-demo-probe-net npx tsx tests/demo-browser/run.ts`,
  then `docker network rm lh-demo-probe-net`.

Build the test image from the repository root with
`docker build -f scripts/demo/Dockerfile -t learnharness-demo-test:dev .`.
