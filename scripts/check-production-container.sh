#!/usr/bin/env bash
# Disposable production checks. Never attach to an existing Compose project.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
root=$PWD
# YAML single-quoted scalars escape apostrophes by doubling them.
yaml_root=${root//\'/\'\'}
scratch=$(mktemp -d /tmp/lh-container.XXXXXX)
project="lh-check-$(date +%s)-$$"
image="learnharness-check:$$"
evidence_root=$(git rev-parse --git-path pi-issue/container-checks)
mkdir -p "$evidence_root"
evidence=$(mktemp -d "$evidence_root/run.XXXXXX")
evidence=$(cd "$evidence" && pwd)
compose() {
    docker compose --env-file /dev/null -p "$project" -f "$root/compose.yaml" -f "$scratch/check.yaml" "$@"
}
loopback() {
    docker compose --env-file /dev/null -p "$project-loopback" -f "$root/compose.yaml" -f "$scratch/loopback.yaml" "$@"
}
cleanup() {
    status=$?
    trap - EXIT
    if [[ -f "$scratch/check.yaml" ]]; then
        compose logs --no-color app fixture > "$evidence/app.log" 2>&1 || :
        compose down --volumes --remove-orphans >> "$evidence/cleanup.log" 2>&1 || status=1
    fi
    if [[ -f "$scratch/loopback.yaml" ]]; then
        loopback down --volumes --remove-orphans >> "$evidence/cleanup.log" 2>&1 || status=1
    fi
    docker image rm "$image" >> "$evidence/cleanup.log" 2>&1 || :
    rm -rf -- "$scratch"
    printf 'exit=%s\n' "$status" >> "$evidence/results.txt"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Only these test containers use the internal network. No external provider route.
cat > "$scratch/check.yaml" <<EOF
services:
  app:
    image: $image
    ports: !override
      - "127.0.0.1::3000"
    healthcheck:
      interval: 2s
      start_period: 5s
    networks: [fixture]
  fixture:
    image: $image
    entrypoint: [node, /checks/fixture-provider.mjs]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - type: bind
        source: '$yaml_root/scripts/container'
        target: /checks
        read_only: true
    healthcheck:
      disable: true
    networks: [fixture]
  driver:
    image: $image
    user: "$(id -u):$(id -g)"
    entrypoint: [node, /checks/verify.mjs]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    volumes:
      - type: bind
        source: '$yaml_root/scripts/container'
        target: /checks
        read_only: true
      - type: bind
        source: $scratch
        target: /evidence
    networks: [fixture]
networks:
  fixture:
    internal: true
EOF
# Exercise the real deny-by-default rules against synthetic private canaries.
mkdir -p "$scratch/context"/{app,data,.pi,.ssh,uploads,backups,unlisted}
cp .dockerignore "$scratch/context/.dockerignore"
printf '{}\n' > "$scratch/context/package.json"
printf '// allowed source\n' > "$scratch/context/app/page.ts"
for file in auth.json .env.local data/record.json .pi/profile.json .ssh/key uploads/note.txt backups/record.json unlisted/private.txt app/.env.local app/auth.json app/chatgpt-credentials.json; do
    printf 'synthetic-private-canary\n' > "$scratch/context/$file"
done
cat > "$scratch/context.Dockerfile" <<'EOF'
FROM node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853
WORKDIR /context
COPY . .
RUN node -e 'const fs = require("node:fs"); const assert = require("node:assert/strict"); assert(fs.existsSync("package.json")); assert(fs.existsSync("app/page.ts")); for (const file of fs.readdirSync(".", {recursive:true})) if (fs.statSync(file).isFile()) assert(!fs.readFileSync(file,"utf8").includes("synthetic-private-canary"), "private canary entered build context");'
EOF
printf 'Building and checking disposable production containers. Evidence: %s\n' "$evidence"
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' > "$evidence/runtime.txt"
docker compose version >> "$evidence/runtime.txt"
sha256sum package-lock.json >> "$evidence/runtime.txt"
docker build --network none --file "$scratch/context.Dockerfile" --output type=cacheonly "$scratch/context" > "$evidence/context.log" 2>&1
printf 'private canaries excluded from Docker build context\n' | tee -a "$evidence/results.txt"
docker build -t "$image" . > "$evidence/build.log" 2>&1
docker compose --env-file /dev/null -p "$project-base" -f "$root/compose.yaml" config --format json | \
    docker run --rm -i --network none --read-only --user 1000:1000 \
        --cap-drop ALL --security-opt no-new-privileges \
        --mount "type=bind,src=$root/scripts/container,dst=/checks,readonly" \
        --entrypoint node "$image" /checks/inspect-compose.mjs | tee -a "$evidence/results.txt"
compose up -d --no-build --wait --wait-timeout 90 fixture app > "$evidence/start.log" 2>&1
check_routes() {
    compose run --rm --no-deps driver http://app:3000 "$1" | tee -a "$evidence/results.txt"
}
check_routes seed
id=$(compose ps -q app)
docker inspect "$id" | compose run --rm -T --no-deps --entrypoint node driver /checks/inspect-config.mjs | tee -a "$evidence/results.txt"
docker exec -i "$id" node --input-type=module < scripts/container/permissions.mjs | tee -a "$evidence/results.txt"
docker exec "$id" node -e 'require("node:fs").writeFileSync("/tmp/ephemeral-probe", "temporary")'
compose restart app >> "$evidence/start.log" 2>&1
compose up -d --no-build --wait --wait-timeout 90 app >> "$evidence/start.log" 2>&1
check_routes verify
docker exec "$id" node -e 'if (require("node:fs").existsSync("/tmp/ephemeral-probe")) process.exit(1)'
printf 'tmpfs cleared across restart while learner state survived\n' | tee -a "$evidence/results.txt"
check_routes answer
old_id=$(compose ps -q app)
compose stop app >> "$evidence/start.log" 2>&1
compose rm -f app >> "$evidence/start.log" 2>&1
compose up -d --no-build --wait --wait-timeout 90 app >> "$evidence/start.log" 2>&1
[[ $(compose ps -q app) != "$old_id" ]] || { printf 'Container was not replaced.\n' >&2; exit 1; }
check_routes verify
id=$(compose ps -q app)
# Only signal the Node child of this disposable container's init process.
signal_app() {
    docker exec "$id" node -e 'const fs = require("node:fs"); const children = fs.readFileSync("/proc/1/task/1/children", "utf8").trim().split(/\s+/); if (children.length !== 1 || !children[0]) throw new Error("Unexpected app process tree"); process.kill(Number(children[0]), process.argv[1]);' "$1"
}
wait_for() {
    local field=$1 expected=$2
    for ((attempt=0; attempt<60; attempt++)); do
        [[ $(docker inspect --format "$field" "$id") == "$expected" ]] && return 0
        sleep 1
    done
    printf 'Timed out waiting for disposable container state.\n' >&2
    return 1
}
signal_app SIGSTOP
wait_for '{{.State.Health.Status}}' unhealthy
[[ $(docker inspect --format '{{.RestartCount}}' "$id") == 0 ]]
signal_app SIGCONT
wait_for '{{.State.Health.Status}}' healthy
printf 'health detects a stalled app; unhealthy alone does not restart it\n' | tee -a "$evidence/results.txt"
signal_app SIGKILL
wait_for '{{.RestartCount}}' 1
wait_for '{{.State.Health.Status}}' healthy
check_routes verify
printf 'restart policy recovered an exited app with the same learner state\n' | tee -a "$evidence/results.txt"
docker diff "$id" > "$evidence/write-paths.txt"
# Engine injects docker-init even with a read-only root. This is not an app write.
if grep -Ev '^(C /usr|C /usr/sbin|A /usr/sbin/docker-init)$' "$evidence/write-paths.txt"; then
    printf 'Unexpected writes outside dedicated mounts.\n' >&2
    exit 1
fi
printf 'no application writes outside data/auth/tmp/cache; only Docker-injected init in diff\n' | tee -a "$evidence/results.txt"
started=$SECONDS
compose stop app >> "$evidence/start.log" 2>&1
# Standalone Node exits by SIGTERM, reported as 128 + 15, not SIGKILL/137.
[[ $(docker inspect --format '{{.State.ExitCode}}' "$id") == 143 ]]
[[ $(docker inspect --format '{{.State.OOMKilled}}' "$id") == false ]]
printf 'idle SIGTERM shutdown exit=143 elapsed=%ss, no forced kill\n' "$((SECONDS-started))" | tee -a "$evidence/results.txt"
docker run --rm --network none --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,nodev \
    --mount "type=bind,src=$root/scripts,dst=/smoke,readonly" \
    --mount "type=bind,src=$root/tests/helpers/tiny-pdf.ts,dst=/tiny-pdf.ts,readonly" \
    --entrypoint node "$image" /smoke/container/native.mjs > "$evidence/native.log" 2>&1
printf 'native PDF/SVG/image worker/provider and demo import smoke passed\n' | tee -a "$evidence/results.txt"
# Docker suppresses publication on internal networks. This separate, fresh app
# has no providers/keys and is used only for the approved host-loopback GET.
cat > "$scratch/loopback.yaml" <<EOF
services:
  app:
    image: $image
    ports: !override
      - "127.0.0.1::3000"
    healthcheck:
      interval: 2s
      start_period: 5s
EOF
loopback up -d --no-build --wait --wait-timeout 90 app > "$evidence/loopback.log" 2>&1
loopback_id=$(loopback ps -q app)
docker inspect "$loopback_id" | compose run --rm -T --no-deps --entrypoint node driver /checks/inspect-config.mjs published | tee -a "$evidence/results.txt"
address=$(loopback port app 3000)
[[ "$address" == 127.0.0.1:* ]] || { printf 'Non-loopback publication.\n' >&2; exit 1; }
curl --fail --silent --max-time 10 "http://$address/api/settings" > "$scratch/loopback-response.json"
printf 'host loopback HTTP passed using a separate empty profile\n' | tee -a "$evidence/results.txt"
loopback down --volumes --remove-orphans >> "$evidence/loopback.log" 2>&1
