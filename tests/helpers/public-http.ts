/** Real Node HTTP parsing over synthetic sockets. No external connections,
 * credentials, ambient DNS or global fetch dispatcher are used. */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import type { TestContext } from "node:test";

export interface WireResponse {
	status?: number;
	headers?: Record<string, string>;
	body?: string | Buffer;
	raw?: string | Buffer;
	peer?: string;
	peerPort?: number;
	stallConnect?: boolean;
	stallBody?: boolean;
	onRequest?: () => void;
}
export interface Dial {
	host: string;
	family: number;
	port: number;
	servername?: string;
	rejectUnauthorized?: boolean;
	checkServerIdentity?: typeof tls.checkServerIdentity;
	ALPNProtocols?: string[];
}

class HttpSocket extends Duplex {
	readonly remoteAddress: string;
	readonly remotePort: number;
	connecting = false;
	private sent = false;
	private request = Buffer.alloc(0);
	constructor(readonly dial: Dial, readonly reply: WireResponse, readonly requests: string[]) {
		super();
		this.remoteAddress = reply.peer ?? dial.host;
		this.remotePort = reply.peerPort ?? dial.port;
	}
	_read() {}
	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.request = Buffer.concat([this.request, chunk]);
		const end = this.request.indexOf("\r\n\r\n");
		const length = Number(/content-length: (\d+)/i.exec(this.request.subarray(0, end).toString())?.[1] ?? 0);
		if (!this.sent && end >= 0 && this.request.length >= end + 4 + length) {
			this.sent = true;
			this.requests.push(this.request.toString());
			this.reply.onRequest?.();
			queueMicrotask(() => {
				if (this.destroyed) return;
				if (this.reply.raw !== undefined) this.push(this.reply.raw);
				else {
					const body = Buffer.from(this.reply.body ?? "Synthetic public page");
					const headers: Record<string, string> = { "content-type": "text/plain", ...this.reply.headers };
					if (!("content-length" in headers) && !("transfer-encoding" in headers)) headers["content-length"] = String(body.length);
					this.push(`HTTP/1.1 ${this.reply.status ?? 200} Fixture\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
					this.push(body);
				}
				if (!this.reply.stallBody) this.push(null);
			});
		}
		callback();
	}
	setTimeout() { return this; }
	setNoDelay() { return this; }
	setKeepAlive() { return this; }
	ref() { return this; }
	unref() { return this; }
}

export function installPublicHttp(t: TestContext, options: {
	lookup?: (hostname: string) => Promise<{ address: string; family: number }[]> | { address: string; family: number }[];
	responses?: WireResponse[];
} = {}) {
	const connections: Dial[] = [];
	const requests: string[] = [];
	const dnsNames: string[] = [];
	const sockets: HttpSocket[] = [];
	const replies = [...(options.responses ?? [{}])];
	t.mock.method(dns, "lookup", async (hostname: string, lookupOptions: unknown) => {
		dnsNames.push(hostname);
		if (JSON.stringify(lookupOptions) !== JSON.stringify({ all: true, verbatim: true })) throw new Error("Expected all DNS answers");
		return options.lookup ? options.lookup(hostname) : [{ address: "93.184.216.34", family: 4 }];
	});
	const dial = (parameters: Dial, secure: boolean) => {
		connections.push(parameters);
		const reply = replies.shift();
		if (!reply) throw new Error("Unexpected connection");
		const socket = new HttpSocket(parameters, reply, requests);
		sockets.push(socket);
		if (!reply.stallConnect) queueMicrotask(() => socket.emit(secure ? "secureConnect" : "connect"));
		return socket;
	};
	t.mock.method(net, "connect", (parameters: Dial) => dial(parameters, false));
	t.mock.method(tls, "connect", (parameters: Dial) => dial(parameters, true));
	return { connections, requests, dnsNames, sockets };
}
