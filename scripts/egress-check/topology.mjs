/** Fixture address plan for the disposable egress check (issue #27).
 * Every prefix here belongs to an internal Docker bridge with isolated
 * gateway mode: no host address, no host route. Prefixes still avoid all
 * host routes, host addresses and existing Docker subnets, so a fixture can
 * never alias something real on this machine. Test-only addresses.
 *
 * CLI: reads {routes4, routes6, addresses, docker} JSON (from `ip -j` and
 * `docker network inspect`) on stdin, prints the topology JSON. */
import net from "node:net";

export const INFERENCE_PORT = 11434;
export const LINK_LOCAL = "169.254.169.0/24";

function parse(/** @type {string} */ cidr) {
	const [address = "", length] = cidr.split("/");
	const family = net.isIP(address);
	if (!family) throw new Error(`Not a prefix: ${cidr}`);
	const bits = family === 4 ? 32 : 128;
	const prefix = length === undefined ? bits : Number(length);
	let value = 0n;
	if (family === 4) for (const part of address.split(".")) value = (value << 8n) | BigInt(part);
	else {
		const [head = "", tail] = address.split("::");
		const left = head ? head.split(":") : [];
		const right = tail ? tail.split(":") : [];
		const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
		for (const group of groups) value = (value << 16n) | BigInt(`0x${group}`);
	}
	return { family, bits, prefix, value };
}

/** True when the two prefixes share any address. Different families never do. */
export function overlaps(/** @type {string} */ a, /** @type {string} */ b) {
	const left = parse(a), right = parse(b);
	if (left.family !== right.family) return false;
	const shift = BigInt(left.bits - Math.min(left.prefix, right.prefix));
	return left.value >> shift === right.value >> shift;
}

/** Routes, addresses and Docker subnets this run must not reuse. Default
 * routes are skipped: everything overlaps them, and the fixture bridges
 * add no host routes of their own. */
export function occupiedPrefixes(/** @type {any} */ input) {
	const prefixes = new Set();
	const add = (/** @type {unknown} */ value, /** @type {number | undefined} */ length) => {
		if (typeof value !== "string" || value === "default") return;
		const [address = ""] = value.split("/");
		const family = net.isIP(address);
		if (!family) return;
		prefixes.add(value.includes("/") ? value : `${address}/${length ?? (family === 4 ? 32 : 128)}`);
	};
	for (const route of [...(input.routes4 ?? []), ...(input.routes6 ?? [])]) {
		add(route.dst);
		add(route.prefsrc);
	}
	for (const link of input.addresses ?? []) for (const info of link.addr_info ?? []) add(info.local, undefined);
	for (const network of input.docker ?? []) for (const config of network.IPAM?.Config ?? []) add(config.Subnet);
	return [...prefixes];
}

const hex = (/** @type {number} */ value) => value.toString(16);
const pick = (/** @type {() => number} */ random, /** @type {number} */ count) => Math.floor(random() * count) % count;

/**
 * @param {{ occupied: string[], isPublic: (address: string) => boolean, random: () => number }} options
 */
export function chooseTopology({ occupied, isPublic, random }) {
	const taken = [...occupied];
	const free = (/** @type {string} */ name, /** @type {() => string} */ candidate, /** @type {(prefix: string) => boolean} */ valid) => {
		for (let attempt = 0; attempt < 500; attempt++) {
			const prefix = candidate();
			if (valid(prefix) && !taken.some((other) => overlaps(prefix, other))) {
				taken.push(prefix);
				return prefix;
			}
		}
		throw new Error(`No free ${name} fixture prefix outside host routes and Docker networks`);
	};
	const base4 = (/** @type {string} */ prefix) => prefix.slice(0, prefix.lastIndexOf(".") + 1);
	const base6 = (/** @type {string} */ prefix) => prefix.replace(/\/64$/, "");
	const publicV4 = free("public IPv4", () => `${1 + pick(random, 223)}.${pick(random, 256)}.${pick(random, 256)}.0/24`,
		(prefix) => isPublic(`${base4(prefix)}1`) && isPublic(`${base4(prefix)}254`));
	const publicV6 = free("public IPv6", () => `${hex(0x2400 + pick(random, 0xc00))}:${hex(pick(random, 0x10000))}:${hex(pick(random, 0x10000))}:${hex(1 + pick(random, 0xffff))}::/64`,
		(prefix) => isPublic(`${base6(prefix)}1`));
	const privateV4 = free("private IPv4", () => `10.${pick(random, 256)}.${pick(random, 256)}.0/24`, () => true);
	const privateV6 = free("private IPv6", () => `fd${hex(pick(random, 256)).padStart(2, "0")}:${hex(pick(random, 0x10000))}:${hex(pick(random, 0x10000))}:${hex(1 + pick(random, 0xffff))}::/64`, () => true);
	const tailnetV4 = free("tailnet IPv4", () => `100.${64 + pick(random, 64)}.${pick(random, 256)}.0/24`, () => true);
	const linkLocal = free("link-local", () => LINK_LOCAL, () => true);
	const v4 = (/** @type {string} */ prefix, /** @type {number} */ host) => `${base4(prefix)}${host}`;
	const v6 = (/** @type {string} */ prefix, /** @type {number} */ host) => `${base6(prefix)}${hex(host)}`;
	// .2 app guard, .3 browser guard, .4 unguarded control, .5 replacement
	// guard, .1 gateway-shaped fixture.
	const members = (/** @type {string} */ four, /** @type {string | undefined} */ six) => ({
		guard4: v4(four, 2), browser4: v4(four, 3), control4: v4(four, 4), spare4: v4(four, 5),
		...(six ? { guard6: v6(six, 2), browser6: v6(six, 3), control6: v6(six, 4), spare6: v6(six, 5) } : {}),
	});
	return {
		inferencePort: INFERENCE_PORT,
		public: { v4: publicV4, v6: publicV6, hosts: { fixture4: v4(publicV4, 10), fixture6: v6(publicV6, 0x10), ...members(publicV4, publicV6) } },
		private: { v4: privateV4, v6: privateV6, hosts: {
			gateway4: v4(privateV4, 1), gateway6: v6(privateV6, 1),
			provider4: v4(privateV4, 20), provider6: v6(privateV6, 0x20),
			unrelated4: v4(privateV4, 30), unrelated6: v6(privateV6, 0x30),
			...members(privateV4, privateV6),
		} },
		tailnet: { v4: tailnetV4, hosts: { fixture4: v4(tailnetV4, 10), ...members(tailnetV4, undefined) } },
		linkLocal: { v4: linkLocal, hosts: { metadata: v4(linkLocal, 254), fixture4: v4(linkLocal, 10), ...members(linkLocal, undefined) } },
	};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const { isPublicAddress } = await import(process.env.LH_PUBLIC_FETCH ?? "/src/public-fetch.ts");
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const occupied = occupiedPrefixes(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	process.stdout.write(`${JSON.stringify(chooseTopology({ occupied, isPublic: isPublicAddress, random: Math.random }), null, "\t")}\n`);
}
