import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";
import { isPublicAddress } from "../src/agent/public-fetch.ts";
import { chooseTopology, occupiedPrefixes, overlaps } from "../scripts/egress-check/topology.mjs";

const runner = "scripts/check-container-egress.sh";

function sequence(values: number[]): () => number {
	let index = 0;
	return () => values[index++ % values.length]!;
}

it("reads host routes, host addresses and Docker subnets as occupied prefixes", () => {
	const occupied = occupiedPrefixes({
		routes4: [{ dst: "default", gateway: "10.20.30.1" }, { dst: "10.20.30.0/24" }, { dst: "100.64.0.7", table: "52" }, { type: "local", dst: "10.20.30.42" }],
		routes6: [{ dst: "fd12:3456:789a:1::/64" }, { dst: "default" }],
		addresses: [{ addr_info: [{ local: "100.64.0.42", prefixlen: 32 }, { local: "fd12::42", prefixlen: 128 }] }],
		docker: [{ IPAM: { Config: [{ Subnet: "172.31.0.0/16" }, { Subnet: "2a0e:1::/64" }] } }],
	});
	assert.deepEqual(occupied.sort(), [
		"10.20.30.0/24", "10.20.30.42/32", "100.64.0.7/32", "100.64.0.42/32", "172.31.0.0/16",
		"2a0e:1::/64", "fd12::42/128", "fd12:3456:789a:1::/64",
	].sort());
});

it("detects IPv4 and IPv6 prefix overlap in both directions", () => {
	assert.equal(overlaps("10.20.30.0/24", "10.20.0.0/16"), true);
	assert.equal(overlaps("10.20.0.0/16", "10.20.30.7/32"), true);
	assert.equal(overlaps("10.20.30.0/24", "10.20.31.0/24"), false);
	assert.equal(overlaps("2a0e:7f3c:91d4:1::/64", "2a0e:7f3c::/32"), true);
	assert.equal(overlaps("2a0e:7f3c:91d4:1::/64", "2a0e:7f3c:91d4:2::/64"), false);
	assert.equal(overlaps("10.0.0.0/8", "::/0"), false);
});

it("chooses public-classified fixture prefixes outside occupied routes and special-use ranges", () => {
	// Low values would land in 1.x/2400:: style prefixes; occupy them so the chooser must move on.
	const occupied = ["1.0.0.0/8", "2400::/12", "10.0.0.0/9", "100.64.0.0/11"];
	const topology = chooseTopology({ occupied, isPublic: isPublicAddress, random: sequence([0, 0.01, 0.37, 0.52, 0.81, 0.29, 0.66, 0.13]) });
	const prefixes = [topology.public.v4, topology.public.v6, topology.private.v4, topology.private.v6, topology.tailnet.v4, topology.linkLocal.v4];
	for (const prefix of prefixes) for (const taken of occupied) assert.equal(overlaps(prefix, taken), false, `${prefix} overlaps ${taken}`);
	for (const address of Object.values(topology.public.hosts)) assert.equal(isPublicAddress(address), true, address);
	for (const prefix of [topology.private.v4, topology.private.v6, topology.tailnet.v4, topology.linkLocal.v4]) {
		assert.equal(isPublicAddress(prefix.split("/")[0]!.replace(/0$/, "1").replace(/::$/, "::1")), false, prefix);
	}
	assert.doesNotMatch(topology.public.v4, /^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
	assert.doesNotMatch(topology.public.v6, /^2001:db8:/i);
	assert.equal(topology.linkLocal.hosts.metadata, "169.254.169.254");
	assert.equal(new Set(prefixes).size, prefixes.length);
});

it("refuses to run when every candidate overlaps the host", () => {
	assert.throws(() => chooseTopology({ occupied: ["0.0.0.0/0", "::/0"], isPublic: isPublicAddress, random: Math.random }), /No free/);
});

it("ships syntactically valid runner and fixture scripts", () => {
	execFileSync("bash", ["-n", runner]);
	for (const file of readdirSync("scripts/egress-check").filter((name) => name.endsWith(".mjs"))) {
		execFileSync(process.execPath, ["--check", `scripts/egress-check/${file}`]);
	}
});

it("never prunes or edits host firewall, routes, sysctls or Tailscale", () => {
	const source = readFileSync(runner, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
	assert.doesNotMatch(source, /\bprune\b/);
	assert.doesNotMatch(source, /^\s*(sudo|iptables|ip6tables|nft|sysctl|tailscale|ip (route|addr|link|rule))\b/m);
	assert.doesNotMatch(source, /--network[= ]host|network_mode: *host|--privileged/);
	// Only resources labelled with this run's id may be removed.
	assert.match(source, /label=\$label/);
});
