import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Public web requests only. Provider/inference endpoints have no exception here.
 * Callers get fully consumed, bounded bytes, not an unbounded response stream.
 * This is application enforcement, not the container egress protection in #27. */
export interface PublicFetchOptions {
	/** Received HTTP bytes, including headers/framing across all hops. The
	 * decoded final body is independently capped at this same size. */
	maxBytes: number;
	/** One budget for DNS, connections, redirects and body consumption. */
	timeoutMs?: number;
	maxRedirects?: number;
	signal?: AbortSignal;
	method?: "GET" | "POST";
	headers?: Readonly<Record<string, string>>;
	body?: string;
}
export interface PublicFetchResponse {
	url: string;
	status: number;
	statusText: string;
	headers: Headers;
	bytes: Uint8Array;
}

// Conservative special-use exclusions, including globally reachable protocol
// assignments rather than treating them as ordinary web servers. Sources:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const excluded = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
	["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) excluded.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) excluded.addSubnet(address, prefix, "ipv6");
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** IPv6 must be ordinary global unicast. Mapped/compatible, NAT64, Teredo,
 * 6to4, multicast, scoped, documentation and reserved ranges fail closed. */
export function isPublicAddress(address: string): boolean {
	if (address.includes("%")) return false;
	const family = net.isIP(address);
	if (family === 4) return !excluded.check(address, "ipv4");
	return family === 6 && globalV6.check(address, "ipv6") && !excluded.check(address, "ipv6");
}

function normalizedUrl(raw: string): URL {
	let url: URL;
	try { url = new URL(raw); }
	catch { throw new Error("Invalid public HTTP(S) URL"); }
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port) {
		throw new Error("Only public HTTP(S) URLs on standard ports without credentials are allowed");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (!hostname || ["localhost", "local", "internal", "home.arpa"].some((name) => hostname === name || hostname.endsWith(`.${name}`))) {
		throw new Error("Destination denied: non-public hostname");
	}
	url.hash = "";
	return url;
}

/** A DNS lookup cannot be cancelled at the OS resolver, but its late result
 * never starts a connection after the operation has been cancelled. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function destination(url: URL, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const literalFamily = net.isIP(hostname);
	const answers = literalFamily ? [{ address: hostname, family: literalFamily }]
		: await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
	signal.throwIfAborted();
	if (!answers.length || answers.some(({ address, family }) => !isPublicAddress(address) || net.isIP(address) !== family)) {
		throw new Error("Destination denied: DNS must contain only public addresses");
	}
	return { address: answers[0]!.address, family: answers[0]!.family as 4 | 6 };
}

/** Connect once to the literal validated IP, never look up the name again.
 * No proxy environment variables, ambient dispatcher or pooled socket applies.
 * TLS still authenticates the original URL hostname, not the selected IP. */
async function connect(url: URL, target: { address: string; family: 4 | 6 }, signal: AbortSignal): Promise<net.Socket> {
	signal.throwIfAborted();
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const secure = url.protocol === "https:";
	const addressOptions = { host: target.address, family: target.family, port: secure ? 443 : 80 };
	const socket = secure ? tls.connect({
		...addressOptions,
		servername: net.isIP(hostname) ? undefined : hostname,
		rejectUnauthorized: true,
		checkServerIdentity: (_name, cert) => tls.checkServerIdentity(hostname, cert),
		ALPNProtocols: ["http/1.1"],
	}) : net.connect(addressOptions);
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => { cleanup(); socket.destroy(); reject(signal.reason); };
			const failed = (error: Error) => { cleanup(); reject(error); };
			const connected = () => {
				cleanup();
				const peer = socket.remoteAddress;
				const selected = new net.BlockList();
				selected.addAddress(target.address, target.family === 4 ? "ipv4" : "ipv6");
				if (!peer || !isPublicAddress(peer) || socket.remotePort !== (secure ? 443 : 80) ||
					!selected.check(peer, net.isIP(peer) === 4 ? "ipv4" : "ipv6")) {
					reject(new Error("Destination denied: connected peer does not match the validated public address"));
				} else resolve();
			};
			const event = secure ? "secureConnect" : "connect";
			const cleanup = () => {
				signal.removeEventListener("abort", abort);
				socket.removeListener("error", failed);
				socket.removeListener(event, connected);
			};
			socket.once("error", failed);
			socket.once(event, connected);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { cleanup(); abort(); }
		}).finally(() => signal.throwIfAborted());
		return socket;
	} catch (error) { socket.destroy(); throw error; }
}

const redirectHeaders = new Set(["accept", "accept-language", "user-agent"]);
function requestHeaders(url: URL, options: PublicFetchOptions, redirected: boolean): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		const lower = name.toLowerCase();
		if (redirected && !redirectHeaders.has(lower)) continue;
		if (["host", "connection", "proxy-authorization", "transfer-encoding", "content-length", "upgrade", "te", "trailer", "expect"].includes(lower)) continue;
		headers[lower] = value;
	}
	headers.host = url.host;
	headers.connection = "close";
	headers["accept-encoding"] = "gzip, deflate, br";
	if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
	return headers;
}

function responseHeaders(response: http.IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) for (const part of value) headers.append(name, part);
		else if (value !== undefined) headers.set(name, value);
	}
	return headers;
}

async function readBody(response: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	const declared = Number(response.headers["content-length"] ?? 0);
	if (declared > maxBytes) throw new Error("Response too large");
	const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
	const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
		: encoding === "br" ? createBrotliDecompress() : undefined;
	if (!decoder && encoding !== "identity") throw new Error("Unsupported response content encoding");
	const counter = () => {
		let length = 0;
		return new Transform({ transform(chunk: Buffer, _encoding, callback) {
			length += chunk.length;
			callback(length > maxBytes ? new Error("Response too large") : null, chunk);
		} });
	};
	const chunks: Buffer[] = [];
	const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); } });
	if (decoder) await pipeline(response, counter(), decoder, counter(), sink, { signal });
	else await pipeline(response, counter(), sink, { signal });
	return Buffer.concat(chunks);
}

/** Every hop has a fresh DNS/peer check; one deadline covers the entire chain.
 * Limits are trusted caller configuration, not model-controlled tool inputs. */
export async function publicFetch(rawUrl: string, options: PublicFetchOptions): Promise<PublicFetchResponse> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxRedirects = options.maxRedirects ?? 5;
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
		!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5 ||
		(options.method !== undefined && options.method !== "GET" && options.method !== "POST") ||
		(options.body !== undefined && options.method !== "POST")) throw new Error("Invalid public fetch limits or method");
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Request cancelled"));
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
	const signal = controller.signal;
	try {
		let url = normalizedUrl(rawUrl);
		// Count HTTP bytes before Node discards chunk framing and informational
		// responses. One budget includes headers and all redirect hops too.
		let receivedBytes = 0;
		for (let redirects = 0; ; redirects++) {
			signal.throwIfAborted();
			const target = await destination(url, signal);
			const socket = await connect(url, target, signal);
			let response: http.IncomingMessage | undefined;
			let request: http.ClientRequest | undefined;
			const countSocketBytes = (chunk: Buffer) => {
				receivedBytes += chunk.length;
				if (receivedBytes > options.maxBytes) request?.destroy(new Error("Response too large"));
			};
			try {
				signal.throwIfAborted();
				response = await new Promise<http.IncomingMessage>((resolve, reject) => {
					request = (url.protocol === "https:" ? https : http).request({
						hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.protocol === "https:" ? 443 : 80,
						method: options.method ?? "GET", path: url.pathname + url.search,
						headers: requestHeaders(url, options, redirects > 0), maxHeaderSize: 16 * 1024,
						signal, createConnection: () => socket,
					}, (incoming) => {
						if (receivedBytes > options.maxBytes) { incoming.destroy(); reject(new Error("Response too large")); }
						else resolve(incoming);
					});
					// The socket event runs after HTTP installs its parser, before
					// data can flow. Prepend the counter so framing is charged first.
					request.once("socket", () => socket.prependListener("data", countSocketBytes));
					request.once("error", reject);
					request.end(options.body);
				});
				const status = response.statusCode ?? 0;
				const headers = responseHeaders(response);
				if ([301, 302, 303, 307, 308].includes(status)) {
					if (redirects >= maxRedirects || (options.method ?? "GET") !== "GET") throw new Error("Redirect limit exceeded or redirects forbidden");
					const location = headers.get("location");
					if (!location) throw new Error("Redirect has no Location");
					url = normalizedUrl(new URL(location, url).href);
					continue;
				}
				const bytes = await readBody(response, options.maxBytes, signal);
				if (receivedBytes > options.maxBytes) throw new Error("Response too large");
				return { url: url.href, status, statusText: response.statusMessage ?? "", headers, bytes };
			} finally {
				socket.removeListener("data", countSocketBytes);
				response?.destroy();
				request?.destroy();
				socket.destroy();
			}
		}
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		// Never echo TLS, DNS or HTTP parser details, which can include raw
		// response bytes or configured request headers, into model tool results.
		if (error instanceof Error && /^(Destination denied:|Only public HTTP|Invalid public|Response too large|Unsupported response content encoding|Redirect )/.test(error.message)) throw error;
		throw new Error("Public request failed");
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
