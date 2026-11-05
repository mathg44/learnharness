/** Assert Docker's effective configuration, not just the Compose text. */
import assert from "node:assert/strict";
import fs from "node:fs";
const [container] = JSON.parse(fs.readFileSync(0, "utf8"));
const host = container.HostConfig;
assert.equal(container.Config.User, "1000:1000");
assert.equal(host.ReadonlyRootfs, true);
assert.equal(host.Privileged, false);
assert.equal(host.Init, true);
assert.deepEqual(host.CapDrop, ["ALL"]);
assert(host.SecurityOpt.includes("no-new-privileges:true"));
assert.notEqual(host.NetworkMode, "host");
assert.equal(host.RestartPolicy.Name, "unless-stopped");
assert.equal(container.Config.StopTimeout, 30);
assert.equal(container.State.Health.Status, "healthy");
assert.deepEqual(Object.keys(host.PortBindings), ["3000/tcp"]);
assert(host.PortBindings["3000/tcp"].every((binding) => binding.HostIp === "127.0.0.1"));
if (process.argv[2] === "published") {
	const published = container.NetworkSettings.Ports["3000/tcp"];
	assert(published?.length, "loopback port must actually be published");
	assert(published.every((binding) => binding.HostIp === "127.0.0.1" && Number(binding.HostPort) > 0));
}
for (const mount of container.Mounts) {
	assert(["/data", "/auth", "/tmp", "/app/.next/cache"].includes(mount.Destination), "unexpected host mount");
	if (["/data", "/auth"].includes(mount.Destination)) assert.equal(mount.Type, "volume");
}
assert(host.Tmpfs["/tmp"]);
assert(host.Tmpfs["/app/.next/cache"]);
console.log("effective mount, loopback port, health, init, restart and isolation configuration passed");
