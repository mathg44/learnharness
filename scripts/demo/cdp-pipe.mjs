/**
 * Chrome DevTools Protocol over --remote-debugging-pipe: fd 3 carries
 * commands to the browser, fd 4 carries replies and events, each message is
 * JSON ended by a NUL byte. No port, no WebSocket, no puppeteer.
 */

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class CdpPipe {
	/** @param {import("node:stream").Writable} input @param {import("node:stream").Readable} output */
	constructor(input, output) {
		this.input = input;
		this.nextId = 1;
		/** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, method: string}>} */
		this.pending = new Map();
		/** @type {Set<(message: {method: string, params: any, sessionId?: string}) => void>} */
		this.listeners = new Set();
		this.closed = null;
		/** @type {Buffer[]} */
		let parts = [];
		let size = 0;
		output.on("data", (chunk) => {
			let start = 0;
			let end;
			while ((end = chunk.indexOf(0, start)) !== -1) {
				parts.push(chunk.subarray(start, end));
				const text = Buffer.concat(parts).toString("utf8");
				parts = [];
				size = 0;
				start = end + 1;
				this.#dispatch(text);
			}
			if (start < chunk.length) {
				parts.push(chunk.subarray(start));
				size += chunk.length - start;
				if (size > MAX_MESSAGE_BYTES) this.close(new Error("CDP message exceeded the size limit"));
			}
		});
		output.on("close", () => this.close(new Error("browser closed the CDP pipe")));
		output.on("error", (error) => this.close(error));
		input.on("error", (error) => this.close(error));
	}

	/** @param {string} text */
	#dispatch(text) {
		let message;
		try { message = JSON.parse(text); } catch { return; }
		if (typeof message.id === "number") {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? "CDP error"}`));
			else waiter.resolve(message.result ?? {});
			return;
		}
		if (typeof message.method === "string") {
			for (const listener of this.listeners) listener(message);
		}
	}

	/** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
	send(method, params = {}, sessionId) {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			this.input.write(`${message}\0`);
		});
	}

	/** @param {(message: {method: string, params: any, sessionId?: string}) => void} listener */
	on(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** @param {Error} [reason] */
	close(reason = new Error("CDP pipe closed")) {
		if (this.closed) return;
		this.closed = reason;
		for (const waiter of this.pending.values()) waiter.reject(reason);
		this.pending.clear();
		this.input.destroy();
	}
}
