#!/usr/bin/env bash
# Verify a committed snapshot, never the caller's data, credentials, or Node.
set -euo pipefail

if (( $# > 1 )); then
	printf 'Usage: bash scripts/check-server-baseline.sh [git-ref]\n' >&2
	exit 2
fi

readonly baseline=e69e85269c064c6c9c49a8b06ae78c06e79c4a63
readonly image=node@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853
cd "$(git rev-parse --show-toplevel)"
revision=$(git rev-parse --verify "${1:-HEAD}^{commit}")
readonly revision
git merge-base --is-ancestor "$baseline" "$revision" || {
	printf 'Refusing a revision without the pinned upstream ancestor.\n' >&2
	exit 2
}

# Fail rather than silently exclude a mistakenly committed private profile.
while IFS= read -r -d '' file; do
	case "$file" in
		data/*|auth.json|chatgpt-credentials.json*|github-copilot-credentials.json*|xai-credentials.json*|.env*|.pi/*|.fresh-data/*|real-data-extraction/*|uploads/*|backups/*|backup/*)
			printf 'Refusing tracked runtime/private material. Review the selected commit locally.\n' >&2
			exit 2 ;;
	esac
done < <(git ls-tree -rz --name-only "$revision")

# Evidence stays in Git's administrative directory, outside source snapshots.
evidence_root=$(git rev-parse --git-path pi-issue/checks)
mkdir -p "$evidence_root"
evidence=$(mktemp -d "$evidence_root/run.XXXXXX")
evidence=$(cd "$evidence" && pwd)
readonly evidence
scratch=$(mktemp -d /tmp/lh-baseline.XXXXXX)
readonly scratch
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/source" "$scratch/profile"/{home,tmp,config,cache,xdg-data,data}
chmod 700 "$scratch/profile"
printf '{}\n' > "$scratch/profile/auth.json"
chmod 600 "$scratch/profile/auth.json"
git archive "$revision" | tar -x -C "$scratch/source"

{
	printf 'revision=%s\nbaseline=%s\nimage=%s\n' "$revision" "$baseline" "$image"
	printf 'started='; date -u +%FT%TZ
	printf 'host='; uname -sm
	docker version --format 'docker-client={{.Client.Version}} docker-server={{.Server.Version}}'
	sha256sum "$scratch/source/package-lock.json" | awk '{print "lockfile-sha256=" $1}'
} > "$evidence/runtime.txt"
printf 'Checking committed snapshot %s. Working-tree edits are not included.\n' "$revision"
printf 'Evidence: %s\n' "$evidence_root/${evidence##*/}"
docker pull "$image" > "$evidence/image.log" 2>&1

container() {
	local network=$1
	shift
	docker run --rm --init --network "$network" \
		--user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
		--mount "type=bind,src=$scratch/source,dst=/workspace" \
		--mount "type=bind,src=$scratch/profile,dst=/profile" \
		--mount "type=bind,src=$evidence,dst=/evidence,readonly" \
		--workdir /workspace \
		--env HOME=/profile/home --env TMPDIR=/profile/tmp \
		--env XDG_CONFIG_HOME=/profile/config --env XDG_CACHE_HOME=/profile/cache \
		--env XDG_DATA_HOME=/profile/xdg-data \
		--env LH_DATA_DIR=/profile/data --env LH_AUTH_FILE=/profile/auth.json \
		--env NEXT_TELEMETRY_DISABLED=1 --env HOSTNAME=127.0.0.1 \
		"$image" "$@"
}

# No --env-file, forwarded provider variables, host home, CLI profile, or ports.
# Do not set LH_IGNORE_ENV_KEYS: tests intentionally create synthetic env keys.
container none bash -c 'node --version; npm --version; uname -sm; cat /etc/os-release' >> "$evidence/runtime.txt"
failed=0
run_check() {
	local name=$1 network=$2 status
	shift 2
	printf 'command=' >> "$evidence/$name.log"
	printf '%q ' "$@" >> "$evidence/$name.log"
	printf '\n' >> "$evidence/$name.log"
	if container "$network" "$@" >> "$evidence/$name.log" 2>&1; then
		status=0
	else
		status=$?
		failed=1
	fi
	printf '%s exit=%s\n' "$name" "$status" | tee -a "$evidence/results.txt"
	if (( status != 0 )); then tail -n 25 "$evidence/$name.log"; fi
	return "$status"
}

run_check install bridge npm ci || exit 1
# Electron 44.9.3 has no postinstall. Its locked installer is explicit.
run_check electron-install bridge node node_modules/electron/install.js || exit 1
run_check test none npm test || :
run_check typecheck none npm run typecheck || :
run_check lint none npm run lint || :
if run_check build bridge npm run build; then
	run_check web-subscriptions none node scripts/smoke-web-subscriptions.mjs || :
else
	printf 'web-subscriptions not run: production build failed\n' | tee -a "$evidence/results.txt"
fi

# Audit is evidence, not a claim that inherited advisories have been fixed.
# Exit 1 means advisories; malformed responses and transport errors fail the run.
printf 'command=npm audit --json\n' > "$evidence/audit-stderr.log"
if container bridge npm audit --json > "$evidence/audit.json" 2>> "$evidence/audit-stderr.log"; then
	audit_status=0
else
	audit_status=$?
fi
printf 'audit exit=%s, advisory counts are report-only\n' "$audit_status" | tee -a "$evidence/results.txt"
if (( audit_status > 1 )); then
	failed=1
	tail -n 25 "$evidence/audit-stderr.log"
fi
run_check audit-response none node -e '
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync("/evidence/audit.json", "utf8"));
if (audit.error || !audit.metadata?.vulnerabilities) process.exit(1);
console.log(JSON.stringify(audit.metadata.vulnerabilities));
' || :
cat "$evidence/audit-response.log"
printf 'finished=' >> "$evidence/runtime.txt"; date -u +%FT%TZ >> "$evidence/runtime.txt"
exit "$failed"
