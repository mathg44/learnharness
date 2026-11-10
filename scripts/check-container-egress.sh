#!/usr/bin/env bash
# Disposable container egress check (issue #27). Builds throwaway guard, app
# and test-browser images, then probes them with real sockets, the real
# publicFetch and a real Chromium against synthetic fixtures.
#
# Safety:
# - Every container, network, volume and image carries this run's label or
#   tag. Cleanup removes only those. No prune, no existing project.
# - Fixture networks are --internal bridges in isolated gateway mode: the
#   host bridge gets no address in any fixture prefix (at most automatic
#   IPv6 link-local) and the host gets no fixture-prefix route, so the
#   public-classified fixture prefixes never reach or shadow anything real.
#   Requires Docker Engine 29.7.2+ (gateway_mode_ipv4/ipv6=isolated).
# - The only non-internal network is the ingress-only pair. Its guard denies
#   all outbound web traffic (denyCidrs 0.0.0.0/0 and ::/0) and nothing in it
#   makes outbound requests. Its port is published on 127.0.0.1 only.
# - No credentials, learner records or host profile mounts. App data/auth
#   are tmpfs. Policies and the TLS CA are synthetic and generated here.
# - No manual host changes: no host firewall, route, sysctl or Tailscale
#   commands. The host changes only through ordinary creation of this run's
#   own Docker resources; the ingress bridge gets Docker-owned host routes
#   and NAT rules that Docker removes with the network. Route and rule
#   mutations run only inside a disposable guard container.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
root=$PWD
run="lh-egress-$(date +%s)-$$"
label="com.learnharness.egress-check.run=$run"
scratch=$(mktemp -d /tmp/lh-egress.XXXXXX)
evidence_root=$(git rev-parse --git-path pi-issue/egress-checks)
mkdir -p "$evidence_root"
evidence=$(mktemp -d "$evidence_root/run.XXXXXX")
evidence=$(cd "$evidence" && pwd)
guard_image="learnharness-egress-check:$run-guard"
app_image="learnharness-egress-check:$run-app"
browser_image="learnharness-egress-check:$run-browser"
deps_image="learnharness-egress-check:$run-deps"
tools_image="learnharness-egress-check:$run-tools"
origin="https://learnharness.egress-check.test"
built=()
failures=0

log() { printf '%s\n' "$*" | tee -a "$evidence/results.txt"; }
owned() { docker "$1" ls -q --filter "label=$label" 2>/dev/null; }

cleanup() {
    status=$?
    trap - EXIT
    set +e
    mkdir -p "$evidence/logs"
    for id in $(docker ps -aq --filter "label=$label"); do
        name=$(docker inspect --format '{{.Name}}' "$id" | sed 's#^/##')
        docker logs "$id" > "$evidence/logs/${name#"$run-"}.log" 2>&1
    done
    for id in $(docker ps -aq --filter "label=$label"); do docker rm -f "$id" >> "$evidence/cleanup.log" 2>&1; done
    for id in $(owned network); do docker network rm "$id" >> "$evidence/cleanup.log" 2>&1 || status=1; done
    for id in $(owned volume); do docker volume rm "$id" >> "$evidence/cleanup.log" 2>&1 || status=1; done
    for image in "${built[@]}"; do docker image rm "$image" >> "$evidence/cleanup.log" 2>&1; done
    left="$(docker ps -aq --filter "label=$label")$(owned network)$(owned volume)"
    [[ -z $left ]] || { printf 'Owned resources left after cleanup.\n' >> "$evidence/results.txt"; status=1; }
    rm -rf -- "$scratch"
    printf 'failures=%s exit=%s\n' "$failures" "$status" >> "$evidence/results.txt"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Record a check. Failures do not stop later, independent checks.
check() {
    local name=$1
    shift
    if "$@" > "$evidence/$name.jsonl" 2>&1; then
        log "PASS $name"
    else
        failures=$((failures + 1))
        log "FAIL $name (see $name.jsonl)"
        grep -h '"pass":false' "$evidence/$name.jsonl" | head -20 | sed 's/^/  /' | tee -a "$evidence/results.txt" || :
    fi
}
fail() { log "FAIL $*"; failures=$((failures + 1)); }
# Remove owned containers mid-run, keeping their logs as evidence.
removed=0
discard() {
    mkdir -p "$evidence/logs"
    for name in "$@"; do
        docker inspect "$run-$name" > /dev/null 2>&1 || continue
        removed=$((removed + 1))
        docker logs "$run-$name" > "$evidence/logs/$name.$removed.log" 2>&1
        docker rm -f "$run-$name" > /dev/null
    done
}
pass() { log "PASS $*"; }
topo() { jq -r "$1" "$scratch/topology.json"; }
host_uptime() { cut -d' ' -f1 /proc/uptime; }

printf 'Disposable egress check %s. Evidence: %s\n' "$run" "$evidence"
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' > "$evidence/runtime.txt"
server_version=$(docker version --format '{{.Server.Version}}')
if [[ $(printf '%s\n29.7.2\n' "$server_version" | sort -V | head -1) != 29.7.2 ]]; then
    printf 'Docker Engine %s is older than 29.7.2; isolated gateway mode is required.\n' "$server_version" >&2
    exit 1
fi

# --- Images -----------------------------------------------------------------
docker build --label "$label" --target egress -t "$guard_image" . > "$evidence/build-guard.log" 2>&1
built+=("$guard_image")
docker build --label "$label" -t "$app_image" . > "$evidence/build-app.log" 2>&1
built+=("$app_image")
# The standalone app bundles its server code, so the tool check loads the
# checkout's TypeScript against the lockfile's dependency stage.
docker build --label "$label" --target dependencies -t "$deps_image" . > "$evidence/build-deps.log" 2>&1
built+=("$deps_image")
for target in tools browser; do
    image="learnharness-egress-check:$run-$target"
    docker build --label "$label" --target "$target" --build-arg "BASE_IMAGE=$app_image" --build-arg "DEPS_IMAGE=$deps_image" \
        -t "$image" -f scripts/egress-check/Dockerfile scripts/egress-check > "$evidence/build-$target.log" 2>&1
    built+=("$image")
done
for image in "${built[@]}"; do docker image inspect --format "$image {{.Id}}" "$image" >> "$evidence/runtime.txt"; done

# --- Fixture address plan -----------------------------------------------------
# Read-only host network state, used only to avoid every prefix in use.
{
    printf '{"routes4":'; ip -j -4 route show table all
    printf ',"routes6":'; ip -j -6 route show table all
    printf ',"addresses":'; ip -j addr show
    printf ',"docker":'; docker network ls -q | xargs docker network inspect
    printf '}'
} > "$scratch/host-network.json"
check_mounts=(--mount "type=bind,src=$root/scripts/egress-check,dst=/check,readonly"
    --mount "type=bind,src=$root/src/agent/public-fetch.ts,dst=/src/public-fetch.ts,readonly")
docker run --rm -i --label "$label" --network none --read-only --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges "${check_mounts[@]}" --entrypoint node "$app_image" \
    /check/topology.mjs < "$scratch/host-network.json" > "$scratch/topology.json"
rm -f -- "$scratch/host-network.json"
inference_port=$(topo .inferencePort)

# --- Synthetic TLS ------------------------------------------------------------
mkdir -p "$scratch/tls"
sans="DNS:*.fixture.test,DNS:public.fixture.test"
for address in $(topo '[.public.hosts.fixture4, .public.hosts.fixture6, (.private.hosts | .unrelated4, .unrelated6, .provider4, .provider6, .gateway4, .gateway6), .tailnet.hosts.fixture4, .linkLocal.hosts.metadata, .linkLocal.hosts.fixture4] | .[]'); do
    sans="$sans,IP:$address"
done
docker run --rm --label "$label" --network none --read-only --user "$(id -u):$(id -g)" --cap-drop ALL \
    --security-opt no-new-privileges --tmpfs /tmp --mount "type=bind,src=$scratch/tls,dst=/tls" \
    --entrypoint sh "$app_image" -c '
        set -e
        cd /tls
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
            -subj "/CN=learnharness egress-check test CA" -keyout ca-key.pem -out ca.pem 2>/dev/null
        openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
            -subj "/CN=public.fixture.test" -keyout server-key.pem -out server.csr 2>/dev/null
        printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$1" > ext.cnf
        openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 2 \
            -extfile ext.cnf -out server.pem 2>/dev/null
        rm -f ca-key.pem server.csr ext.cnf ca.srl
        chmod 0444 ca.pem server.pem server-key.pem' sh "$sans"
mkdir -p "$scratch/server-tls"
mv "$scratch/tls/server.pem" "$scratch/tls/server-key.pem" "$scratch/server-tls/"

# --- Policies (synthetic, root-readable without DAC_OVERRIDE) ----------------
mkdir -p "$scratch/policy"
policy() { printf '%s\n' "$2" > "$scratch/policy/$1.json"; chmod 0444 "$scratch/policy/$1.json"; }
policy app "$(jq -cn --arg a "$(topo .private.hosts.provider4)" --argjson p "$inference_port" \
    '{version:1,profile:"app",inference:{address:$a,port:$p}}')"
policy browser '{"version":1,"profile":"browser"}'
policy ingress '{"version":1,"profile":"app","denyCidrs":["0.0.0.0/0","::/0"]}'
policy invalid-json '{"version":1,'
policy wrong-version '{"version":2,"profile":"app"}'
policy unknown-profile '{"version":1,"profile":"proxy"}'
policy inference-hostname "$(jq -cn --argjson p "$inference_port" '{version:1,profile:"app",inference:{address:"provider.fixture.test",port:$p}}')"
policy inference-public "$(jq -cn --arg a "$(topo .public.hosts.fixture4)" --argjson p "$inference_port" '{version:1,profile:"app",inference:{address:$a,port:$p}}')"
policy browser-inference "$(jq -cn --arg a "$(topo .private.hosts.provider4)" --argjson p "$inference_port" '{version:1,profile:"browser",inference:{address:$a,port:$p}}')"
cp "$scratch/policy"/{app,browser,ingress}.json "$evidence/"

# --- Networks -----------------------------------------------------------------
isolated=(--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated
    -o com.docker.network.bridge.gateway_mode_ipv6=isolated --label "$label" --label com.learnharness.egress-check.test-only=true)
docker network create "${isolated[@]}" --ipv6 --subnet "$(topo .public.v4)" --subnet "$(topo .public.v6)" "$run-public" > /dev/null
docker network create "${isolated[@]}" --ipv6 --subnet "$(topo .private.v4)" --subnet "$(topo .private.v6)" "$run-private" > /dev/null
docker network create "${isolated[@]}" --subnet "$(topo .tailnet.v4)" "$run-tailnet" > /dev/null
docker network create "${isolated[@]}" --subnet "$(topo .linkLocal.v4)" "$run-linklocal" > /dev/null

# Attach a created container to one fixture network: name net ipv4 [ipv6] [aliases...]
attach() {
    local container=$1 network=$2 ip4=$3 ip6=${4:-}
    local args=(--ip "$ip4")
    [[ -n $ip6 ]] && args+=(--ip6 "$ip6")
    for alias in "${@:5}"; do args+=(--alias "$alias"); done
    docker network connect "${args[@]}" "$run-$network" "$container"
}
hardened=(--label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges)

# fixture name ports udp-ports, then attach calls with $run-fx-name
fixture() {
    docker create --name "$run-fx-$1" "${hardened[@]}" --user 1000:1000 --network none \
        -e "FIXTURE_NAME=$1" -e "FIXTURE_PORTS=$2" -e "FIXTURE_UDP=$3" \
        --mount "type=bind,src=$root/scripts/egress-check,dst=/check,readonly" \
        --mount "type=bind,src=$scratch/server-tls,dst=/tls,readonly" \
        --entrypoint node "$app_image" /check/fixture.mjs > /dev/null
    docker network disconnect none "$run-fx-$1"
}
fixture public "80,443,8080,3128,$inference_port" "443,53"
attach "$run-fx-public" public "$(topo .public.hosts.fixture4)" "$(topo .public.hosts.fixture6)" public.fixture.test mixed.fixture.test
fixture provider "80,443,8080,$inference_port" ""
attach "$run-fx-provider" private "$(topo .private.hosts.provider4)" "$(topo .private.hosts.provider6)" provider.fixture.test
fixture unrelated "80,443,3128,$inference_port" ""
attach "$run-fx-unrelated" private "$(topo .private.hosts.unrelated4)" "$(topo .private.hosts.unrelated6)" private.fixture.test mixed.fixture.test
fixture gateway "80,443" ""
attach "$run-fx-gateway" private "$(topo .private.hosts.gateway4)" "$(topo .private.hosts.gateway6)"
fixture tailnet "80,443" ""
attach "$run-fx-tailnet" tailnet "$(topo .tailnet.hosts.fixture4)"
fixture metadata "80" ""
attach "$run-fx-metadata" linklocal "$(topo .linkLocal.hosts.metadata)"
fixture linklocal "80" ""
attach "$run-fx-linklocal" linklocal "$(topo .linkLocal.hosts.fixture4)"
for name in public provider unrelated gateway tailnet metadata linklocal; do docker start "$run-fx-$name" > /dev/null; done

wait_logs() {
    local container=$1 pattern=$2 count=$3
    for ((attempt = 0; attempt < 60; attempt++)); do
        (( $(docker logs "$container" 2>&1 | grep -c -- "$pattern") >= count )) && return 0
        sleep 0.5
    done
    printf 'Timed out waiting for %s.\n' "$container" >&2
    return 1
}
wait_logs "$run-fx-public" listening 7
wait_logs "$run-fx-metadata" listening 1

# IPv6 link-local of the unrelated fixture, from inside that fixture only.
link_local6=$(docker exec "$run-fx-unrelated" awk '$6 == "eth0" && $1 ~ /^fe80/ { print $1 }' /proc/net/if_inet6 | head -1 | sed -E 's/(....)/\1:/g; s/:$//')
jq --arg a "$link_local6" '.private.hosts.linkLocal6 = $a' "$scratch/topology.json" > "$scratch/topology.next"
mv "$scratch/topology.next" "$scratch/topology.json"
chmod 0444 "$scratch/topology.json"
cp "$scratch/topology.json" "$evidence/topology.json"
check_mounts+=(--mount "type=bind,src=$scratch/topology.json,dst=/topology.json,readonly"
    --mount "type=bind,src=$scratch/tls/ca.pem,dst=/tls/ca.pem,readonly")

# Isolation evidence: fixture bridges carry no host address beyond automatic
# IPv6 link-local, and the host has no route for any fixture prefix.
isolation_ok=true
for network in public private tailnet linklocal; do
    bridge="br-$(docker network inspect --format '{{.Id}}' "$run-$network" | cut -c1-12)"
    addresses=$(ip -j addr show dev "$bridge" | jq -r '[.[].addr_info[] | select(.scope != "link")] | length')
    printf '%s %s non-link-local-addresses=%s\n' "$network" "$bridge" "$addresses" >> "$evidence/isolation.txt"
    [[ $addresses == 0 ]] || isolation_ok=false
done
for prefix in $(topo '[.public.v4, .public.v6, .private.v4, .private.v6, .tailnet.v4, .linkLocal.v4] | .[]'); do
    family=-4; [[ $prefix == *:* ]] && family=-6
    routes=$(ip "$family" -j route show table all | jq --arg p "$prefix" '[.[] | select(.dst == $p)] | length')
    printf '%s host-routes=%s\n' "$prefix" "$routes" >> "$evidence/isolation.txt"
    [[ $routes == 0 ]] || isolation_ok=false
done
if $isolation_ok; then pass "fixture bridges: no non-link-local host address, no host route for any fixture prefix"; else fail "fixture bridge isolation (see isolation.txt)"; fi

# Unguarded control namespace on every fixture network. It proves each
# fixture answers, so a denial in a guarded namespace is the guard's doing.
docker create --name "$run-control" "${hardened[@]}" --user 1000:1000 --network none "${check_mounts[@]}" \
    -e NODE_EXTRA_CA_CERTS=/tls/ca.pem --entrypoint node "$app_image" -e 'setInterval(() => {}, 1 << 30)' > /dev/null
docker network disconnect none "$run-control"
attach "$run-control" public "$(topo .public.hosts.control4)" "$(topo .public.hosts.control6)"
attach "$run-control" private "$(topo .private.hosts.control4)" "$(topo .private.hosts.control6)"
attach "$run-control" tailnet "$(topo .tailnet.hosts.control4)"
attach "$run-control" linklocal "$(topo .linkLocal.hosts.control4)"
docker start "$run-control" > /dev/null
check control-matrix docker exec "$run-control" node /check/probe.mjs matrix control

# --- Guard pairs ----------------------------------------------------------------
# Mirrors compose.server.yaml: root, read-only, only NET_ADMIN, policy bind
# read-only, state volume shared read-only with the dependent. A guard
# normally owns "<name>-state"; state_of[name] lets a replacement guard
# reuse a predecessor's volume.
declare -A state_of=()
state_volume() { printf '%s-%s-state' "$run" "${state_of[$1]:-$1}"; }
guard_args() {
    local name=$1 policy_file=$2 cap=${3-NET_ADMIN}
    [[ -n $cap ]] && printf '%s\n' --cap-add "$cap"
    printf '%s\n' --name "$run-$name" "${hardened[@]}" --user 0:0 --init \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
        --mount "type=volume,src=$(state_volume "$name"),dst=/run/lh-egress"
    [[ -n $policy_file ]] && printf '%s\n' --mount "type=bind,src=$scratch/policy/$policy_file.json,dst=/etc/learnharness/egress.json,readonly"
    return 0
}
# start_guard name policy slot(guard|browser) [extra docker args...]
start_guard() {
    local name=$1 policy_file=$2 slot=$3
    docker volume inspect "$(state_volume "$name")" > /dev/null 2>&1 ||
        docker volume create --label "$label" "$(state_volume "$name")" > /dev/null
    mapfile -t args < <(guard_args "$name" "$policy_file")
    docker create "${args[@]}" "${@:4}" --network none "$guard_image" > /dev/null
    docker network disconnect none "$run-$name"
    attach "$run-$name" public "$(topo ".public.hosts.${slot}4")" "$(topo ".public.hosts.${slot}6")"
    attach "$run-$name" private "$(topo ".private.hosts.${slot}4")" "$(topo ".private.hosts.${slot}6")"
    attach "$run-$name" tailnet "$(topo ".tailnet.hosts.${slot}4")"
    attach "$run-$name" linklocal "$(topo ".linkLocal.hosts.${slot}4")"
    docker start "$run-$name" > /dev/null
}
wait_health() {
    local container=$1 expected=$2 seconds=${3:-60}
    for ((attempt = 0; attempt < seconds * 2; attempt++)); do
        [[ $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") == "$expected" ]] && return 0
        [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || return 1
        sleep 0.5
    done
    return 1
}
# Loopback listener inside a guard namespace. Proves loopback denial is real.
start_loopback() {
    docker run -d --name "$run-$1-loop" "${hardened[@]}" --user 1000:1000 --network "container:$run-$1" \
        -e FIXTURE_NAME=loopback -e FIXTURE_PORTS=9080 -e FIXTURE_HOST=:: \
        --mount "type=bind,src=$root/scripts/egress-check,dst=/check,readonly" \
        --entrypoint node "$app_image" /check/fixture.mjs > /dev/null
    wait_logs "$run-$1-loop" listening 1
}
app_mounts() {
    printf '%s\n' --mount "type=bind,src=$scratch/policy/$2.json,dst=/etc/learnharness/egress.json,readonly" \
        --mount "type=volume,src=$(state_volume "$1"),dst=/run/lh-egress,readonly"
}
# start_app name guard policy — the real app image and entrypoint, server mode.
start_app() {
    local name=$1 guard=$2 policy_file=$3
    mapfile -t mounts < <(app_mounts "$guard" "$policy_file")
    docker run -d --name "$run-$name" "${hardened[@]}" --user 1000:1000 --init --network "container:$run-$guard" \
        -e LH_SERVER_MODE=tailscale -e "LH_SERVER_ORIGIN=$origin" "${mounts[@]}" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 \
        --tmpfs /app/.next/cache:rw,noexec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
        --tmpfs /data:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
        --tmpfs /auth:rw,noexec,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700 \
        --health-interval 2s --health-start-period 5s "$app_image" > /dev/null
}
probe() {
    local namespace=$1
    shift
    docker run --rm --label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
        --network "container:$run-$namespace" "${check_mounts[@]}" -e NODE_EXTRA_CA_CERTS=/tls/ca.pem \
        --entrypoint node "$app_image" /check/probe.mjs "$@"
}
capabilities() {
    local guard=$1 policy_file=$2 expected=$3
    mapfile -t mounts < <(app_mounts "$guard" "$policy_file")
    docker run --rm --label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
        --network "container:$run-$guard" "${mounts[@]}" \
        --mount "type=bind,src=$root/scripts/egress-check,dst=/check,readonly" \
        --mount "type=bind,src=$root/src/core/server-capabilities.ts,dst=/src-check/src/core/server-capabilities.ts,readonly" \
        --mount "type=bind,src=$root/src/server/egress.ts,dst=/src-check/src/server/egress.ts,readonly" \
        --mount "type=bind,src=$root/scripts/egress,dst=/src-check/scripts/egress,readonly" \
        --entrypoint node "$app_image" /check/capabilities.mjs "$expected"
}
# Real web_fetch / web_fetch_pdf tools with the app's readiness adapter.
tools() {
    local guard=$1 policy_file=$2 expected=$3
    mapfile -t mounts < <(app_mounts "$guard" "$policy_file")
    docker run --rm --label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
        --network "container:$run-$guard" "${mounts[@]}" "${check_mounts[@]}" -e NODE_EXTRA_CA_CERTS=/tls/ca.pem \
        --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
        --mount "type=bind,src=$root/src,dst=/workspace/lh/src,readonly" \
        --mount "type=bind,src=$root/config.ts,dst=/workspace/lh/config.ts,readonly" \
        --mount "type=bind,src=$root/scripts/egress,dst=/workspace/lh/scripts/egress,readonly" \
        --workdir /workspace --entrypoint node "$tools_image" --import tsx /check/tools.mjs "$expected"
}
# The app's own enforcement check, run inside the real app container.
app_ready() {
    docker exec "$run-$1" node --input-type=module -e '
        import { enforcementReady } from "/usr/local/lib/learnharness/egress/state.mjs";
        console.log(JSON.stringify({ case: "app container enforcementReady", ready: enforcementReady() }));
        process.exit(enforcementReady() === (process.argv[1] === "fresh") ? 0 : 1);' "$2"
}
# A new app joining a live namespace whose lease is stale must stop in the
# entrypoint's Node preflight: nonzero exit, the refusal message, and no
# Next startup (so not a Docker join failure or EADDRINUSE either).
stale_startup() {
    local guard=$1 name=$2 code logs
    [[ $(docker inspect --format '{{.State.Running}}' "$run-$guard") == true ]] || { printf '{"case":"stale startup","guard":"not running"}\n'; return 1; }
    start_app "$name" "$guard" app
    if ! code=$(timeout 30 docker wait "$run-$name"); then
        printf '{"case":"stale startup","app":"still running after 30s","pass":false}\n'
        discard "$name"
        return 1
    fi
    logs=$(docker logs "$run-$name" 2>&1)
    printf '%s\n' "$logs"
    discard "$name"
    local refused=false started=false
    grep -q 'Container network enforcement is unavailable. Refusing server startup.' <<< "$logs" && refused=true
    grep -Eqi 'next\.js|ready in|EADDRINUSE|listening' <<< "$logs" && started=true
    local pass=false
    [[ $code != 0 ]] && $refused && ! $started && pass=true
    printf '{"case":"stale startup","exit":%s,"refused":%s,"next_started":%s,"pass":%s}\n' "$code" "$refused" "$started" "$pass"
    $pass
}
guard_signal() {
    docker exec "$run-$1" node -e '
        const fs = require("node:fs");
        const pid = fs.readdirSync("/proc").find((entry) => /^\d+$/.test(entry) && (() => {
            // argv[0] must be node itself: docker-init (PID 1) also lists guard.mjs.
            try { const [command = "", script = ""] = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0"); return /(^|\/)node$/.test(command) && script.endsWith("/egress/guard.mjs"); }
            catch { return false; }
        })());
        if (!pid) throw new Error("guard process not found");
        process.kill(Number(pid), process.argv[1]);' "$2"
}
# hold namespace role action...: established and new flows across a disturbance.
hold() {
    local namespace=$1 role=$2 name=$3
    shift 3
    local dir="$scratch/hold-$name"
    mkdir -p "$dir"
    chmod 0777 "$dir"
    docker run -d --name "$run-hold-$name" --label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges \
        --user 1000:1000 --network "container:$run-$namespace" "${check_mounts[@]}" \
        --mount "type=bind,src=$dir,dst=/hold" --entrypoint node "$app_image" /check/probe.mjs hold "$role" > /dev/null
    for ((attempt = 0; attempt < 60; attempt++)); do [[ -f $dir/ready ]] && break; sleep 0.5; done
    [[ -f $dir/ready ]] || { docker logs "$run-hold-$name" > "$evidence/hold-$name.jsonl" 2>&1; fail "hold-$name never established flows"; return 0; }
    "$@" >> "$evidence/actions.log" 2>&1 || printf 'action %s exited nonzero\n' "$*" >> "$evidence/actions.log"
    host_uptime > "$dir/action"
    local code
    code=$(docker wait "$run-hold-$name")
    docker logs "$run-hold-$name" > "$evidence/hold-$name.jsonl" 2>&1
    docker rm "$run-hold-$name" > /dev/null
    if [[ $code == 0 ]]; then pass "hold-$name"; else fail "hold-$name (see hold-$name.jsonl)"; fi
}
inspect_pair() {
    local guard=$1 dependent=$2
    {
        docker inspect --format 'guard caps add={{json .HostConfig.CapAdd}} drop={{json .HostConfig.CapDrop}} user={{.Config.User}} ports={{json .HostConfig.PortBindings}}' "$run-$guard"
        docker inspect --format 'dependent caps add={{json .HostConfig.CapAdd}} drop={{json .HostConfig.CapDrop}} user={{.Config.User}} network={{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}} mounts={{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}' "$run-$dependent"
    } | tee "$evidence/inspect-$guard-$dependent.txt"
    [[ $(docker inspect --format '{{json .HostConfig.CapAdd}}' "$run-$guard") == '["CAP_NET_ADMIN"]' || \
       $(docker inspect --format '{{json .HostConfig.CapAdd}}' "$run-$guard") == '["NET_ADMIN"]' ]] &&
    [[ $(docker inspect --format '{{json .HostConfig.CapAdd}}' "$run-$dependent") == null ]] &&
    [[ $(docker inspect --format '{{json .HostConfig.CapDrop}}' "$run-$dependent") == *ALL* ]] &&
    [[ $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$run-$dependent") == "container:"* ]]
}

# Pair A: app profile. Fresh enforcement, then a frozen guard.
start_guard guard-a app guard
if wait_health "$run-guard-a" healthy 30; then
    pass "app guard healthy with valid policy"
    start_loopback guard-a
    start_app app-a guard-a app
    if wait_health "$run-app-a" healthy 90; then pass "protected app started and healthy"; else fail "protected app did not become healthy"; fi
    check inspect-app-pair inspect_pair guard-a app-a
    check app-matrix probe guard-a matrix app
    check public-fetch probe guard-a public-fetch
    check capabilities-fresh capabilities guard-a app fresh
    check app-ready-fresh app_ready app-a fresh
    check tools-fresh tools guard-a app fresh
    # Docker DNATs 127.0.0.11:53 to random resolver ports in this namespace;
    # the DNS probes above prove those flows and their replies pass.
    docker exec "$run-guard-a" nft list table inet lh_egress > "$evidence/guard-a-table.nft" 2>&1 || :
    docker exec "$run-guard-a" nft list ruleset > "$evidence/guard-a-ruleset.nft" 2>&1 || :
    hold guard-a app sigstop guard_signal guard-a SIGSTOP
    check stale-matrix probe guard-a matrix closed
    check capabilities-stale capabilities guard-a app stale
    check app-ready-stale app_ready app-a stale
    check tools-stale tools guard-a app stale
    check stale-startup-refused stale_startup guard-a app-stale
    guard_signal guard-a SIGCONT >> "$evidence/actions.log" 2>&1
    # A resumed guard finds its lease lapsed. Record what it does.
    sleep 3
    log "INFO guard after SIGCONT: health=$(docker inspect --format '{{.State.Health.Status}}' "$run-guard-a") running=$(docker inspect --format '{{.State.Running}}' "$run-guard-a")"
    discard guard-a-loop
else
    fail "app guard never became healthy with a valid policy"
fi

# Pair A2: crash. The kernel must expire grants without the guard process.
discard app-a guard-a
start_guard guard-a app guard
if wait_health "$run-guard-a" healthy 30; then
    start_app app-a guard-a app
    wait_health "$run-app-a" healthy 90 || fail "protected app did not become healthy before crash"
    # An idle worker and a loopback fixture stay in the old namespace too.
    start_loopback guard-a
    docker run -d --name "$run-worker-a" "${hardened[@]}" --user 1000:1000 --network "container:$run-guard-a" \
        "${check_mounts[@]}" -e NODE_EXTRA_CA_CERTS=/tls/ca.pem --entrypoint node "$app_image" -e 'setInterval(() => {}, 1 << 30)' > /dev/null
    hold guard-a app crash guard_signal guard-a SIGKILL
    check app-ready-after-crash app_ready app-a stale
    log "INFO guard after SIGKILL: running=$(docker inspect --format '{{.State.Running}}' "$run-guard-a") exit=$(docker inspect --format '{{.State.ExitCode}}' "$run-guard-a")"
    # Namespace owner replacement: a new guard in a NEW namespace writes a
    # fresh status into the SAME volume, on spare fixture addresses. The old
    # app and worker must reject that status and still cannot egress.
    state_of[guard-n]=guard-a
    start_guard guard-n app spare
    if wait_health "$run-guard-n" healthy 30; then
        pass "replacement guard healthy on the shared state volume"
        docker exec "$run-worker-a" node -e 'console.log(JSON.stringify(Object.keys(require("node:os").networkInterfaces())))' \
            > "$evidence/old-namespace-interfaces.json" 2>&1 || :
        check replaced-old-app-rejects-new-status app_ready app-a stale
        check replaced-old-namespace-matrix docker exec "$run-worker-a" node /check/probe.mjs matrix closed
        check replaced-new-namespace-capabilities capabilities guard-n app fresh
        # Recreating the dependents in the new namespace restores service.
        discard worker-a app-a guard-a-loop guard-a
        start_loopback guard-n
        start_app app-n guard-n app
        if wait_health "$run-app-n" healthy 90; then pass "app recreated in replacement namespace healthy"; else fail "app in replacement namespace did not become healthy"; fi
        check replaced-pair-matrix probe guard-n matrix app
        check replaced-pair-app-ready app_ready app-n fresh
    else
        fail "replacement guard never became healthy on the shared state volume"
    fi
    discard app-n guard-n-loop guard-n worker-a
else
    fail "app guard never became healthy for the crash check"
fi

# Pair A3: recreate the pair with the same names and the same state volume.
discard app-a guard-a
mapfile -t args < <(guard_args guard-a app)
docker create "${args[@]}" --network none "$guard_image" > /dev/null
docker network disconnect none "$run-guard-a"
attach "$run-guard-a" public "$(topo .public.hosts.guard4)" "$(topo .public.hosts.guard6)"
attach "$run-guard-a" private "$(topo .private.hosts.guard4)" "$(topo .private.hosts.guard6)"
attach "$run-guard-a" tailnet "$(topo .tailnet.hosts.guard4)"
attach "$run-guard-a" linklocal "$(topo .linkLocal.hosts.guard4)"
docker start "$run-guard-a" > /dev/null
if wait_health "$run-guard-a" healthy 30; then
    start_loopback guard-a
    start_app app-a guard-a app
    if wait_health "$run-app-a" healthy 90; then pass "recreated pair healthy"; else fail "recreated app did not become healthy"; fi
    check recreated-matrix probe guard-a matrix app
    check recreated-capabilities capabilities guard-a app fresh
else
    fail "recreated guard never became healthy"
fi
discard app-a guard-a guard-a-loop

# Pairs C and D: topology and rule changes inside a disposable guard only.
mutation() {
    local name=$1
    shift
    start_guard "$name" app guard
    if ! wait_health "$run-$name" healthy 30; then fail "$name guard never became healthy"; discard "$name"; return 0; fi
    start_loopback "$name"
    start_app "app-$name" "$name" app
    wait_health "$run-app-$name" healthy 90 || fail "$name app did not become healthy"
    hold "$name" app "$name" "$@"
    check "$name-matrix" probe "$name" matrix closed
    check "$name-capabilities" capabilities "$name" app stale
    check "$name-app-ready" app_ready "app-$name" stale
    discard "app-$name" "$name-loop" "$name"
}
route_change() { docker exec "$run-route-change" ip route add 198.51.100.0/24 dev eth0; }
rule_change() {
    local chain
    chain=$(docker exec "$run-rule-change" nft -j list table inet lh_egress | jq -r '[.nftables[] | select(.chain.hook == "output") | .chain.name][0]')
    docker exec "$run-rule-change" nft insert rule inet lh_egress "$chain" accept
}
mutation route-change route_change
mutation rule-change rule_change

# Invalid or unsupported configuration: the guard must not become healthy
# and the protected app must refuse to start in its namespace.
refuses() {
    local name=$1 policy_file=$2 cap=${3-NET_ADMIN}
    docker volume create --label "$label" "$run-$name-state" > /dev/null
    mapfile -t args < <(guard_args "$name" "$policy_file" "$cap")
    docker run -d "${args[@]}" --network "$run-private" "$guard_image" > /dev/null
    sleep 8
    local health
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}} running={{.State.Running}}' "$run-$name")
    printf '{"case":"%s","guard":"%s"}\n' "$name" "$health"
    [[ $health != healthy* ]] || return 1
    local app_policy=${policy_file:-app}
    mapfile -t mounts < <(app_mounts "$name" "$app_policy")
    if docker run -d --name "$run-$name-app" "${hardened[@]}" --user 1000:1000 --network "container:$run-$name" \
        -e LH_SERVER_MODE=tailscale -e "LH_SERVER_ORIGIN=$origin" "${mounts[@]}" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 "$app_image" > /dev/null 2>&1; then
        local code
        code=$(timeout 30 docker wait "$run-$name-app") || return 1
        printf '{"case":"%s","app_exit":%s}\n' "$name" "$code"
        docker logs "$run-$name-app" 2>&1 | grep -q 'Refusing server startup' && [[ $code != 0 ]]
    else
        printf '{"case":"%s","app":"could not join a stopped guard namespace"}\n' "$name"
    fi
}
check refuses-missing-policy refuses bad-missing ""
for bad in invalid-json wrong-version unknown-profile inference-hostname inference-public browser-inference; do
    check "refuses-$bad" refuses "bad-$bad" "$bad"
done
check refuses-without-net-admin refuses bad-no-net-admin app ""
for bad in missing invalid-json wrong-version unknown-profile inference-hostname inference-public browser-inference no-net-admin; do
    discard "bad-$bad-app" "bad-$bad"
done

# Pair B: browser profile with a real Chromium in its own guard namespace.
start_guard guard-b browser browser
if wait_health "$run-guard-b" healthy 30; then
    pass "browser guard healthy"
    start_loopback guard-b
    check browser-socket-matrix probe guard-b matrix browser
    chromium() {
        docker run --rm --label "$label" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
            --network "container:$run-$1" --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 --shm-size 256m \
            -e HOME=/tmp -e XDG_CONFIG_HOME=/tmp/.config -e XDG_CACHE_HOME=/tmp/.cache \
            --mount "type=bind,src=$root/scripts/egress-check,dst=/check,readonly" \
            --mount "type=bind,src=$scratch/topology.json,dst=/topology.json,readonly" \
            --entrypoint node "$browser_image" /check/browser.mjs "$2"
    }
    check chromium-control chromium control control
    check chromium-guarded chromium guard-b browser
    hold guard-b browser browser-sigstop guard_signal guard-b SIGSTOP
    guard_signal guard-b SIGCONT >> "$evidence/actions.log" 2>&1 || :
else
    fail "browser guard never became healthy"
fi
discard guard-b-loop guard-b

# Ingress-only pair (owner-approved): one ordinary non-internal bridge so
# Docker can publish 127.0.0.1. All outbound web traffic is denied by policy.
docker network create --label "$label" "$run-ingress" > /dev/null
docker volume create --label "$label" "$run-guard-i-state" > /dev/null
mapfile -t args < <(guard_args guard-i ingress)
docker run -d "${args[@]}" --network "$run-ingress" -p 127.0.0.1::3000 "$guard_image" > /dev/null
if wait_health "$run-guard-i" healthy 30; then
    start_app app-i guard-i ingress
    if wait_health "$run-app-i" healthy 90; then
        address=$(docker port "$run-guard-i" 3000/tcp | head -1)
        log "INFO ingress published at $address"
        [[ $address == 127.0.0.1:* ]] && pass "guard publishes only on 127.0.0.1" || fail "non-loopback publication $address"
        [[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$run-app-i") == '{}' || \
           $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$run-app-i") == null ]] && pass "app publishes no ports" || fail "app has its own port bindings"
        host=${origin#https://}
        with_identity=$(curl --silent --max-time 10 -o "$scratch/ingress.json" -w '%{http_code}' \
            -H "Host: $host" -H 'Tailscale-User-Login: synthetic-user@egress-check.test' -H 'X-Forwarded-Proto: https' \
            "http://$address/api/settings")
        without_identity=$(curl --silent --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $host" "http://$address/api/settings")
        printf '{"with_identity":%s,"without_identity":%s}\n' "$with_identity" "$without_identity" > "$evidence/ingress.jsonl"
        [[ $with_identity == 200 ]] && jq -e 'has("settings")' "$scratch/ingress.json" > /dev/null &&
            pass "loopback ingress serves settings with synthetic identity" || fail "loopback ingress with identity returned $with_identity"
        [[ $without_identity == 403 ]] && pass "loopback ingress without identity is 403" || fail "loopback ingress without identity returned $without_identity"
    else
        fail "ingress app did not become healthy"
    fi
else
    fail "ingress guard never became healthy with broad deny ranges"
fi
discard app-i guard-i

log "failures=$failures"
(( failures == 0 ))
