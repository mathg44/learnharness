import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { isPublicAddress } from "../src/agent/public-fetch.ts";
import { checkDockerResolver, inspectTable, isPublicDestination, parsePolicy, renderGrants, renderRevoke, renderTable } from "../scripts/egress/policy.mjs";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** A trimmed `nft -j list table inet lh_egress` listing in kernel shape. */
function listing({ expires = 4, prio = -150, policy = "drop", extraRules = [] as unknown[][] } = {}) {
	const match = (left: unknown, right: unknown, op = "==") => ({ match: { op, left, right } });
	const rule = (handle: number, expr: unknown[]) => ({ rule: { family: "inet", table: "lh_egress", chain: "output", handle, expr } });
	return JSON.stringify({ nftables: [
		{ metainfo: { version: "1.0.2", json_schema_version: 1 } },
		{ table: { family: "inet", name: "lh_egress", handle: 6 } },
		{ set: { family: "inet", name: "public_tcp", table: "lh_egress", type: "inet_service", handle: 2, flags: ["timeout"],
			elem: [{ elem: { val: 443, timeout: 5, expires } }] } },
		{ set: { family: "inet", name: "excluded4", table: "lh_egress", type: "ipv4_addr", handle: 5, flags: ["interval"],
			elem: [{ prefix: { addr: "10.0.0.0", len: 8 } }] } },
		{ chain: { family: "inet", table: "lh_egress", name: "output", handle: 1, type: "filter", hook: "output", prio, policy } },
		rule(9, [match({ ct: { key: "direction" } }, "reply"), match({ ct: { key: "state" } }, ["established", "related"], "in"), { accept: null }]),
		rule(10, [match({ payload: { protocol: "ip", field: "daddr" } }, "@excluded4"), { drop: null }]),
		rule(11, [match({ payload: { protocol: "tcp", field: "dport" } }, "@public_tcp"), { accept: null }]),
		...extraRules.map((expr, index) => rule(20 + index, expr)),
	] });
}

test("app policy accepts one exact private inference endpoint", () => {
	const policy = parsePolicy(json({ version: 1, profile: "app", inference: { address: "10.20.30.40", port: 8080 } }));
	assert.deepEqual(policy, { version: 1, profile: "app", inference: { address: "10.20.30.40", port: 8080 }, denyCidrs: [] });
});

test("inference accepts only RFC1918, CGNAT and ULA literals", () => {
	for (const address of ["172.16.0.1", "192.168.1.2", "100.64.0.9", "fd12:3456::7"]) {
		assert.equal(parsePolicy(json({ version: 1, profile: "app", inference: { address, port: 443 } })).inference?.address, address);
	}
});

test("invalid configs fail closed instead of widening policy", () => {
	const app = (inference: unknown) => json({ version: 1, profile: "app", inference });
	const rejected: Array<[string, Buffer]> = [
		["hostname", app({ address: "inference.internal", port: 80 })],
		["wildcard", app({ address: "10.0.0.*", port: 80 })],
		["range", app({ address: "10.0.0.0/24", port: 80 })],
		["public", app({ address: "8.8.8.8", port: 80 })],
		["loopback", app({ address: "127.0.0.1", port: 80 })],
		["link-local metadata", app({ address: "169.254.169.254", port: 80 })],
		["IPv6 metadata", app({ address: "fd00:ec2::254", port: 80 })],
		["IPv6 link-local", app({ address: "fe80::1", port: 80 })],
		["IPv6 loopback", app({ address: "::1", port: 80 })],
		["mapped", app({ address: "::ffff:10.0.0.1", port: 80 })],
		["compressed mapped", app({ address: "::ffff:a00:1", port: 80 })],
		["NAT64", app({ address: "64:ff9b::a00:1", port: 80 })],
		["6to4", app({ address: "2002:a00:1::1", port: 80 })],
		["zone id", app({ address: "fd00::1%eth0", port: 80 })],
		["benchmark", app({ address: "198.18.0.1", port: 80 })],
		["non-canonical", app({ address: "010.0.0.1", port: 80 })],
		["port zero", app({ address: "10.0.0.1", port: 0 })],
		["port range", app({ address: "10.0.0.1", port: "80-90" })],
		["port too large", app({ address: "10.0.0.1", port: 65536 })],
		["fractional port", app({ address: "10.0.0.1", port: 80.5 })],
		["extra inference key", app({ address: "10.0.0.1", port: 80, protocol: "udp" })],
		["browser inference", json({ version: 1, profile: "browser", inference: { address: "10.0.0.1", port: 80 } })],
		["unknown profile", json({ version: 1, profile: "admin" })],
		["wrong version", json({ version: 2, profile: "app" })],
		["unknown key", json({ version: 1, profile: "browser", allowCidrs: ["10.0.0.0/8"] })],
		["duplicate key", Buffer.from('{"version":1,"profile":"app","profile":"browser"}')],
		["nested duplicate key", Buffer.from('{"version":1,"profile":"app","inference":{"address":"10.0.0.1","port":80,"port":81}}')],
		["bad deny CIDR", json({ version: 1, profile: "browser", denyCidrs: ["203.0.113.0/33"] })],
		["deny host bits", json({ version: 1, profile: "browser", denyCidrs: ["203.0.113.7/24"] })],
		["deny without prefix", json({ version: 1, profile: "browser", denyCidrs: ["203.0.113.7"] })],
		["deny not list", json({ version: 1, profile: "browser", denyCidrs: "203.0.113.0/24" })],
		["array root", json([])],
		["not JSON", Buffer.from("profile=app")],
	];
	for (const [label, bytes] of rejected) assert.throws(() => parsePolicy(bytes), Error, label);
});

test("only the app table reaches app health and inference", () => {
	const app = renderTable(parsePolicy(json({ version: 1, profile: "app", inference: { address: "fd12::7", port: 8080 } })));
	const browser = renderTable(parsePolicy(json({ version: 1, profile: "browser" })));
	assert.match(app, /ip daddr 127\.0\.0\.1 tcp dport 3000 accept/);
	assert.match(app, /ip6 daddr \. tcp dport @inference6 accept/);
	assert.doesNotMatch(browser, /3000|inference/);
});

test("table script manages only its own inet lh_egress table", () => {
	const script = renderTable(parsePolicy(json({ version: 1, profile: "app" })));
	const topLevel = script.split("\n").filter((line) => line && !/^\s/.test(line) && line !== "}");
	assert.deepEqual(topLevel, ["table inet lh_egress", "delete table inet lh_egress", "table inet lh_egress {"]);
	assert.match(script, /type filter hook output priority -150; policy drop;/);
});

test("public destination ranges match the research fetcher", () => {
	for (const address of [
		"1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255",
		"172.32.0.0", "192.0.1.0", "198.17.255.255", "198.20.0.0", "223.255.255.255", "10.0.0.1", "127.0.0.11",
		"169.254.169.254", "192.168.1.1", "224.0.0.1", "255.255.255.255", "203.0.113.9",
		"2606:4700::1111", "2001:4860::8888", "2001:200::1", "2001:1ff::1", "2001:db8::1", "2002::1", "3fff::1",
		"3ffe::1", "4000::1", "64:ff9b::808:808", "::ffff:8.8.8.8", "fd00::1", "fe80::1", "ff02::1", "::1",
	]) assert.equal(isPublicDestination(address), isPublicAddress(address), address);
});

test("grant renewal replaces every timed permission with a five second lease", () => {
	const grants = renderGrants(parsePolicy(json({ version: 1, profile: "app", inference: { address: "10.20.30.40", port: 8080 } })));
	assert.equal(grants, [
		"flush set inet lh_egress public_tcp",
		"flush set inet lh_egress dns4",
		"flush set inet lh_egress inference4",
		"flush set inet lh_egress inference6",
		"add element inet lh_egress public_tcp { 80 timeout 5s, 443 timeout 5s }",
		"add element inet lh_egress dns4 { 127.0.0.11 . udp . 53 timeout 5s, 127.0.0.11 . tcp . 53 timeout 5s }",
		"add element inet lh_egress inference4 { 10.20.30.40 . 8080 timeout 5s }",
		"",
	].join("\n"));
});

test("browser grants and revocation never mention inference", () => {
	const browser = parsePolicy(json({ version: 1, profile: "browser" }));
	assert.equal(renderRevoke(browser), "flush set inet lh_egress public_tcp\nflush set inet lh_egress dns4\n");
	assert.doesNotMatch(renderGrants(browser), /inference/);
});

test("table inspection ignores lease timers but sees rule changes", () => {
	assert.equal(inspectTable(listing({ expires: 1 })), inspectTable(listing({ expires: 4 })));
	const extra = [{ match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } }, { drop: null }];
	assert.notEqual(inspectTable(listing({ extraRules: [extra] })), inspectTable(listing()));
});

test("table inspection rejects any outbound bypass", () => {
	const ctState = { match: { op: "in", left: { ct: { key: "state" } }, right: ["established"] } };
	for (const [label, table] of [
		["blanket established", listing({ extraRules: [[ctState, { accept: null }]] })],
		["unconditional accept", listing({ extraRules: [[{ accept: null }]] })],
		["jump", listing({ extraRules: [[{ jump: { target: "other" } }]] })],
		["same priority as conntrack", listing({ prio: -200 })],
		["after Docker DNAT", listing({ prio: -100 })],
		["accept policy", listing({ policy: "accept" })],
	] as const) assert.throws(() => inspectTable(table), Error, label);
});

// An unprivileged user+network namespace is enough for nft to load rules.
const namespaceNft = (script: string) => spawnSync("unshare", ["-rn", "sh", "-c", `nft -f - && nft -j list table inet lh_egress`], { input: script, encoding: "utf8" });
// Optional kernel check: the default suite needs no namespaces or root.
// Run with LH_EGRESS_KERNEL_TESTS=1 where unprivileged user namespaces work.
const skip = process.env.LH_EGRESS_KERNEL_TESTS === "1" ? false : "set LH_EGRESS_KERNEL_TESTS=1 to run";

test("kernel accepts the rendered table and renewal, and the listing inspects clean", { skip }, () => {
	for (const config of [
		{ version: 1, profile: "app", inference: { address: "fd12::7", port: 8080 }, denyCidrs: ["203.0.113.0/24", "203.0.113.128/25", "2001:db8::/32"] },
		{ version: 1, profile: "browser" },
		{ version: 1, profile: "app", denyCidrs: ["0.0.0.0/0", "10.0.0.0/8", "::/0", "2001:db8::/32"] },
	]) {
		const policy = parsePolicy(json(config));
		const result = namespaceNft(renderTable(policy) + renderGrants(policy) + renderGrants(policy));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(typeof inspectTable(result.stdout), "string");
	}
});

test("ingress-only pair may deny every destination", () => {
	const policy = parsePolicy(json({ version: 1, profile: "app", denyCidrs: ["0.0.0.0/0", "::/0"] }));
	assert.deepEqual(policy.denyCidrs, ["0.0.0.0/0", "::/0"]);
	assert.match(renderTable(policy), /ip daddr 127\.0\.0\.1 tcp dport 3000 accept/);
});

test("only Docker's embedded resolver is a supported resolv.conf", () => {
	assert.doesNotThrow(() => checkDockerResolver("# Generated by Docker\nnameserver 127.0.0.11\nsearch lan\noptions ndots:0\n"));
	for (const [label, text] of [
		["empty", ""],
		["no nameserver", "options ndots:0\n"],
		["upstream", "nameserver 1.1.1.1\n"],
		["extra upstream", "nameserver 127.0.0.11\nnameserver 192.168.1.1\n"],
		["duplicate", "nameserver 127.0.0.11\nnameserver 127.0.0.11\n"],
		["IPv6 resolver", "nameserver ::1\n"],
		["systemd stub", "nameserver 127.0.0.53\n"],
		["trailing port", "nameserver 127.0.0.11:5353\n"],
	] as const) assert.throws(() => checkDockerResolver(text), Error, label);
});

test("browser policy carries operator deny CIDRs for both families", () => {
	const policy = parsePolicy(json({ version: 1, profile: "browser", denyCidrs: ["203.0.113.0/24", "2001:db8:1::/48"] }));
	assert.deepEqual(policy, { version: 1, profile: "browser", denyCidrs: ["203.0.113.0/24", "2001:db8:1::/48"] });
});
