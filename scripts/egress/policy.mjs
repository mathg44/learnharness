/** Container egress policy for issue #27: config validation and nft rendering.
 * Plain Node so the guard and the app image run it without a build step. */
import net from "node:net";

/**
 * @typedef {{ address: string, port: number }} Inference
 * @typedef {{ version: 1, profile: "app" | "browser", inference?: Inference, denyCidrs: string[] }} Policy
 */

// The exact inference tuple may only point at a private network. IPv6 is
// checked on raw bits: net.BlockList matches IPv4-mapped IPv6 against IPv4
// subnets, which would let ::ffff:a00:1 pass as 10.0.0.1.
const privateInference4 = new net.BlockList();
for (const [address, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]]) {
	privateInference4.addSubnet(address, prefix, "ipv4");
}
/** ULA fc00::/7, minus cloud metadata fd00:ec2::/32 (AWS IMDS over IPv6). */
function isPrivateInference6(/** @type {string} */ address) {
	const hex = expand6(address);
	return (parseInt(hex.slice(0, 2), 16) & 0xfe) === 0xfc && !hex.startsWith("fd000ec2");
}

export const TABLE = "inet lh_egress";
export const LEASE_SECONDS = 5;
export const PUBLIC_TCP_PORTS = [80, 443];
export const DNS_ADDRESS = "127.0.0.11";
export const HEALTH = { address: "127.0.0.1", port: 3000 };

// Conservative IANA special-use exclusions. Keep in step with
// src/agent/public-fetch.ts; the policy test checks parity.
export const EXCLUDED_IPV4 = [
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16",
	"192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
];
export const EXCLUDED_IPV6 = ["2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20"];
/** Public IPv6 must also be ordinary global unicast. */
export const GLOBAL_IPV6 = "2000::/3";

/** What the drop rules leave reachable on public ports, as nft sees it. IPv6
 * is compared on raw bits like the kernel, so mapped addresses stay IPv6.
 * @param {string} address */
export function isPublicDestination(address) {
	const family = net.isIP(address);
	if (family === 4) return !EXCLUDED_IPV4.some((cidr) => inCidr(address, cidr));
	return family === 6 && !address.includes("%") && inCidr(address, GLOBAL_IPV6)
		&& !EXCLUDED_IPV6.some((cidr) => inCidr(address, cidr));
}

function inCidr(/** @type {string} */ address, /** @type {string} */ cidr) {
	const [network = "", prefix] = cidr.split("/");
	return net.isIP(network) === net.isIP(address) && networkAddress(address, Number(prefix)) === network;
}

/** The policy only grants DNS to Docker's embedded resolver, so resolv.conf
 * must name exactly that one nameserver. Throws otherwise.
 * @param {string} text */
export function checkDockerResolver(text) {
	const nameservers = text.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([keyword]) => keyword === "nameserver")
		.map((fields) => fields.slice(1).join(" "));
	if (nameservers.length !== 1 || nameservers[0] !== DNS_ADDRESS) {
		throw new Error(`resolv.conf must name only the Docker resolver ${DNS_ADDRESS}`);
	}
}

/** Parse the private egress config. Throws on anything not exactly valid.
 * @param {Buffer | string} bytes
 * @returns {Policy} */
export function parsePolicy(bytes) {
	const text = String(bytes);
	rejectDuplicateKeys(text);
	const value = JSON.parse(text);
	if (!isRecord(value)) throw new Error("Egress config must be a JSON object");
	onlyKeys(value, ["version", "profile", "inference", "denyCidrs"], "Egress config");
	if (value.version !== 1) throw new Error("Unsupported egress config version");
	if (value.profile !== "app" && value.profile !== "browser") throw new Error("Egress profile must be app or browser");
	const denyCidrs = value.denyCidrs === undefined ? [] : parseCidrs(value.denyCidrs);
	if (value.inference === undefined) return { version: 1, profile: value.profile, denyCidrs };
	if (value.profile !== "app") throw new Error("Only the app profile may reach inference");
	return { version: 1, profile: "app", inference: parseInference(value.inference), denyCidrs };
}

/** The full table with every timed grant empty. Loading it replaces any
 * earlier lh_egress table in one transaction, so it never opens a gap.
 * @param {Policy} policy */
export function renderTable(policy) {
	const app = policy.profile === "app";
	const split = (/** @type {4 | 6} */ family) => policy.denyCidrs.filter((cidr) => net.isIP(cidr.split("/")[0] ?? "") === family);
	const sets = [
		timedSet("public_tcp", "inet_service"),
		timedSet("dns4", "ipv4_addr . inet_proto . inet_service"),
		...(app ? [timedSet("inference4", "ipv4_addr . inet_service"), timedSet("inference6", "ipv6_addr . inet_service")] : []),
		intervalSet("deny4", "ipv4_addr", split(4)),
		intervalSet("deny6", "ipv6_addr", split(6)),
		intervalSet("excluded4", "ipv4_addr", EXCLUDED_IPV4),
		intervalSet("excluded6", "ipv6_addr", EXCLUDED_IPV6),
		intervalSet("global6", "ipv6_addr", [GLOBAL_IPV6]),
	];
	const rules = [
		// Responses on connections someone else opened, such as inbound app
		// requests. Our own outbound flows never match this.
		"ct direction reply ct state established,related accept",
		...(app ? [`ip daddr ${HEALTH.address} tcp dport ${HEALTH.port} accept`] : []),
		// IPv6 neighbor discovery. Hop limit 255 keeps it on the local link.
		"icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept",
		"ip daddr . meta l4proto . th dport @dns4 accept",
		// The exact inference tuple wins over denyCidrs by owner decision.
		...(app ? ["ip daddr . tcp dport @inference4 accept", "ip6 daddr . tcp dport @inference6 accept"] : []),
		"ip daddr @deny4 drop",
		"ip6 daddr @deny6 drop",
		"ip daddr @excluded4 drop",
		"ip6 daddr @excluded6 drop",
		"ip6 daddr != @global6 drop",
		"tcp dport @public_tcp accept",
	];
	return [
		`table ${TABLE}`,
		`delete table ${TABLE}`,
		`table ${TABLE} {`,
		...sets.map((set) => `\t${set}`),
		"\tchain output {",
		// After conntrack at -200, before Docker DNS DNAT at -100. Reply
		// direction is available and DNS is still 127.0.0.11:53.
		"\t\ttype filter hook output priority -150; policy drop;",
		...rules.map((rule) => `\t\t${rule}`),
		"\t}",
		"}",
		"",
	].join("\n");
}

/** Clear every timed permission. Static health and reply traffic remain.
 * @param {Policy} policy */
export function renderRevoke(policy) {
	const sets = ["public_tcp", "dns4", ...(policy.profile === "app" ? ["inference4", "inference6"] : [])];
	return sets.map((set) => `flush set ${TABLE} ${set}\n`).join("");
}

/** One atomic renewal. Flushing first resets each timeout on any kernel;
 * re-adding an existing element does not.
 * @param {Policy} policy */
export function renderGrants(policy) {
	const lease = `timeout ${LEASE_SECONDS}s`;
	const lines = [
		`add element ${TABLE} public_tcp { ${PUBLIC_TCP_PORTS.map((port) => `${port} ${lease}`).join(", ")} }`,
		`add element ${TABLE} dns4 { ${DNS_ADDRESS} . udp . 53 ${lease}, ${DNS_ADDRESS} . tcp . 53 ${lease} }`,
	];
	const inference = policy.profile === "app" ? policy.inference : undefined;
	if (inference) {
		const set = net.isIP(inference.address) === 4 ? "inference4" : "inference6";
		lines.push(`add element ${TABLE} ${set} { ${inference.address} . ${inference.port} ${lease} }`);
	}
	return renderRevoke(policy) + lines.map((line) => `${line}\n`).join("");
}

/** Check a `nft -j list table inet lh_egress` listing for the shape the
 * guard installs and return it without handles or lease timers. The guard
 * compares this against its post-install baseline before every renewal.
 * @param {string} listingJson */
export function inspectTable(listingJson) {
	/** @type {Array<Record<string, any>>} */
	const objects = JSON.parse(listingJson).nftables.filter((/** @type {object} */ item) => !("metainfo" in item));
	const chains = objects.filter((item) => item.chain).map((item) => item.chain);
	const [chain] = chains;
	if (chains.length !== 1 || chain.name !== "output" || chain.type !== "filter" || chain.hook !== "output"
		|| chain.prio !== -150 || chain.policy !== "drop") throw new Error("lh_egress output chain changed");
	for (const item of objects) {
		const kind = Object.keys(item)[0];
		if (kind !== "table" && kind !== "set" && kind !== "chain" && kind !== "rule") throw new Error(`Unexpected lh_egress ${kind}`);
		const body = item[kind];
		if ((kind === "table" ? body.name : body.table) !== "lh_egress" || body.family !== "inet") throw new Error("Foreign object in listing");
		if (kind === "rule") checkRule(body.expr);
	}
	return JSON.stringify(objects.map((item) => {
		const kind = Object.keys(item)[0] ?? "";
		const { handle: _handle, ...body } = item[kind];
		if (kind === "set" && body.flags?.includes("timeout")) delete body.elem;
		return { [kind]: body };
	}));
}

/** Only matches followed by accept or drop. An accept must match something,
 * and connection state may only accept the reply direction. */
function checkRule(/** @type {Array<Record<string, any>>} */ expr) {
	const verdict = expr.at(-1) ?? {};
	const matches = expr.slice(0, -1);
	if (!("accept" in verdict || "drop" in verdict) || matches.some((part) => !("match" in part))) {
		throw new Error("lh_egress rule has an unexpected statement");
	}
	if (!("accept" in verdict)) return;
	if (!matches.length) throw new Error("lh_egress has an unconditional accept");
	const ct = (/** @type {string} */ key) => matches.find((part) => part.match.left?.ct?.key === key);
	const direction = ct("direction");
	if (ct("state") && (direction?.match.op !== "==" || direction.match.right !== "reply")) {
		throw new Error("lh_egress accepts connection state outside the reply direction");
	}
}

function timedSet(/** @type {string} */ name, /** @type {string} */ type) {
	return `set ${name} { type ${type}; flags timeout; }`;
}

function intervalSet(/** @type {string} */ name, /** @type {string} */ type, /** @type {string[]} */ cidrs) {
	const elements = cidrs.length ? ` elements = { ${cidrs.join(", ")} }` : "";
	return `set ${name} { type ${type}; flags interval; auto-merge;${elements} }`;
}

/** @param {unknown} value @returns {Inference} */
function parseInference(value) {
	if (!isRecord(value)) throw new Error("Inference must be an object");
	onlyKeys(value, ["address", "port"], "Inference");
	const { address, port } = value;
	if (typeof address !== "string" || !net.isIP(address) || canonical(address) !== address) {
		throw new Error("Inference address must be a canonical IP literal");
	}
	const allowed = net.isIP(address) === 4 ? privateInference4.check(address, "ipv4") : isPrivateInference6(address);
	if (!allowed) {
		throw new Error("Inference address must be RFC1918, CGNAT or ULA");
	}
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("Inference port must be one TCP port");
	}
	return { address, port };
}

/** @param {unknown} value @returns {string[]} */
function parseCidrs(value) {
	if (!Array.isArray(value)) throw new Error("denyCidrs must be a list");
	return value.map((cidr) => {
		const match = typeof cidr === "string" ? /^([^/]+)\/(\d{1,3})$/.exec(cidr) : null;
		const family = match ? net.isIP(match[1] ?? "") : 0;
		const prefix = Number(match?.[2]);
		if (!match || !family || prefix > (family === 4 ? 32 : 128) || networkAddress(match[1] ?? "", prefix) !== match[1]) {
			throw new Error(`Invalid deny CIDR: ${String(cidr)}`);
		}
		return /** @type {string} */ (cidr);
	});
}

/** Lowercase compressed form. IPv4 rejects leading zeros via net.isIP. */
function canonical(/** @type {string} */ address) {
	return net.isIP(address) === 4 ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

/** The address with host bits cleared, in canonical text. */
function networkAddress(/** @type {string} */ address, /** @type {number} */ prefix) {
	const v4 = net.isIP(address) === 4;
	const bits = v4 ? 32 : 128;
	let value = v4
		? address.split(".").reduce((sum, part) => (sum << 8n) | BigInt(part), 0n)
		: BigInt(`0x${expand6(address)}`);
	value &= ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
	if (v4) return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
	const hex = value.toString(16).padStart(32, "0").replace(/(.{4})(?!$)/g, "$1:");
	return canonical(hex);
}

function expand6(/** @type {string} */ address) {
	const [head = "", tail = ""] = canonical(address).split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
	return groups.map((group) => group.padStart(4, "0")).join("");
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(/** @type {Record<string, unknown>} */ value, /** @type {string[]} */ allowed, /** @type {string} */ label) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown key ${key}`);
}

/** JSON.parse keeps the last duplicate silently, so a typo could override a
 * value. Scan object keys first. Syntax errors are left to JSON.parse. */
function rejectDuplicateKeys(/** @type {string} */ text) {
	/** @type {Array<Set<string> | null>} */
	const stack = [];
	const token = /"(?:[^"\\]|\\.)*"|[{}[\]:,]/g;
	/** @type {string | null} */
	let pending = null;
	for (const [part] of text.matchAll(token)) {
		const top = stack.at(-1);
		if (part === "{") stack.push(new Set());
		else if (part === "[") stack.push(null);
		else if (part === "}" || part === "]") stack.pop();
		else if (part === ":" && top && pending !== null) {
			if (top.has(pending)) throw new Error(`Duplicate config key ${pending}`);
			top.add(pending);
		}
		pending = part.startsWith('"') ? JSON.parse(part) : null;
	}
}
