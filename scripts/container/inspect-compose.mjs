/** Check the unmodified run recipe before test overrides replace its port. */
import assert from "node:assert/strict";
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync(0, "utf8"));
const app = config.services.app;
assert.equal(app.ports.length, 1);
assert.equal(app.ports[0].host_ip, "127.0.0.1");
assert.equal(Number(app.ports[0].published), 3000);
assert.equal(app.ports[0].target, 3000);
assert.equal(app.ports[0].protocol, "tcp");
assert.equal(app.read_only, true);
assert.equal(app.user, "1000:1000");
assert.equal(app.restart, "unless-stopped");
assert.equal(app.network_mode, undefined);
assert.equal(app.privileged ?? false, false);
assert.deepEqual(app.volumes.map((mount) => [mount.type, mount.target]).sort(), [["volume", "/auth"], ["volume", "/data"]]);
console.log("base Compose recipe publishes only 127.0.0.1:3000 and mounts only dedicated data/auth volumes");
