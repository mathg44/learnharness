/** Executed through stdin in the running app, under its configured identity. */
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
const status = fs.readFileSync("/proc/self/status", "utf8");
assert.match(status, /NoNewPrivs:\s+1/);
assert.match(status, /CapEff:\s+0+\n/);
for (const directory of ["/app", "/usr/local/lib/learnharness", "/home/node"]) {
	assert.throws(() => fs.writeFileSync(`${directory}/.must-not-write`, "probe"), (error) => ["EROFS", "EACCES"].includes(error.code));
}
for (const directory of ["/data", "/auth", "/tmp", "/app/.next/cache"]) {
	fs.writeFileSync(`${directory}/.write-probe`, "probe", { mode: 0o600 });
	fs.unlinkSync(`${directory}/.write-probe`);
}
for (const directory of ["/data", "/auth"]) {
	assert.equal(fs.statSync(directory).uid, 1000);
	assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
}
// The route seed selects API-key auth so the real atomic auth writer has run.
assert(fs.existsSync("/auth/auth.json"), "API-key seed must create private auth storage");
assert.equal(fs.statSync("/auth/auth.json").mode & 0o777, 0o600);
for (const secret of ["/.ssh", "/root/.ssh", "/var/run/docker.sock", "/app/auth.json", "/app/.env.local", "/app/tests"]) assert(!fs.existsSync(secret));
console.log("UID/GID 1000, no capabilities, no-new-privileges, read-only code, writable data/auth/tmp/cache and private file modes passed");
