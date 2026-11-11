/**
 * Container settings shared by the Docker checks in scripts/check-server-backups.mjs
 * and scripts/check-server-updates.mjs. Each check keeps its own process,
 * cleanup and ownership handling.
 */

/** Server-mode env for a synthetic app that keeps its profile in /data and /auth. */
export const serverCheckEnv = (origin) => ["LH_SERVER_MODE=tailscale", `LH_SERVER_ORIGIN=${origin}`, "LH_DATA_DIR=/data", "LH_AUTH_FILE=/auth/auth.json", "LH_IGNORE_ENV_KEYS=1"];

export const HARDENED = [
	"--pull", "never", "--network", "none", "--read-only", "--user", "1000:1000",
	"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
	"--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
];
export const APP_CACHE = ["--tmpfs", "/app/.next/cache:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700"];
// Docker and the CLI see only what they need to reach the daemon, never provider variables.
export const CHILD_ENV = Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]
	.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));

/** The container really has no network, no host ports, no extra privileges and no Docker socket. */
export function isolated(info) {
	const host = info.HostConfig;
	return host.NetworkMode === "none"
		&& Object.keys(info.NetworkSettings?.Networks ?? {}).every((network) => network === "none")
		&& Object.keys(host.PortBindings ?? {}).length === 0 && !host.PublishAllPorts
		&& host.ReadonlyRootfs === true && host.CapDrop?.includes("ALL") && !(host.CapAdd?.length)
		&& host.SecurityOpt?.includes("no-new-privileges") && info.Config.User === "1000:1000" && !host.Privileged
		&& info.Mounts.every((mount) => !String(mount.Source).includes("docker.sock"));
}
