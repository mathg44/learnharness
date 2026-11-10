/** Synthetic endpoint for the disposable egress check. It answers only
 * fixed test bodies, keeps no request data and logs request lines only.
 *
 * Env: FIXTURE_NAME (body marker), FIXTURE_PORTS (comma list of TCP ports;
 * 443 is HTTPS), FIXTURE_UDP (comma list of UDP echo ports), FIXTURE_HOST
 * (listen address, default "::" for dual stack), FIXTURE_TLS (directory with
 * server.pem/server-key.pem). Port 3128 also acts as a forward proxy. */
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const name = process.env.FIXTURE_NAME ?? "fixture";
const host = process.env.FIXTURE_HOST ?? "::";
const list = (/** @type {string | undefined} */ value) => (value ?? "").split(",").filter(Boolean).map(Number);
const tlsDir = process.env.FIXTURE_TLS ?? "/tls";

/** One-page PDF with a real xref table and a line of Helvetica text. */
function onePagePdf(/** @type {string} */ text) {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
		`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = body.length;
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}
const pdf = onePagePdf(`fixture:${name} synthetic pdf`);

/** @param {number} port */
function handler(port) {
	return (/** @type {http.IncomingMessage} */ request, /** @type {http.ServerResponse} */ response) => {
		console.log(`${name} ${port} ${request.method} ${request.url?.slice(0, 120)}`);
		const marker = `fixture:${name}`;
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-private-network": "true",
			"cache-control": "no-store",
		};
		if (request.method === "OPTIONS") return void response.writeHead(204, { ...headers, "access-control-allow-headers": "*" }).end();
		// A forward proxy receives absolute-form targets.
		if (port === 3128 && /^https?:\/\//.test(request.url ?? "")) {
			return void response.writeHead(200, { ...headers, "content-type": "text/html" }).end(`<title>${marker}:proxy</title>${marker}:proxy`);
		}
		const url = new URL(request.url ?? "/", "http://fixture.invalid");
		if (url.pathname === "/redirect") {
			return void response.writeHead(302, { ...headers, location: url.searchParams.get("to") ?? "/" }).end();
		}
		if (url.pathname === "/pdf") return void response.writeHead(200, { ...headers, "content-type": "application/pdf" }).end(pdf);
		if (url.pathname === "/text") return void response.writeHead(200, { ...headers, "content-type": "text/plain; charset=utf-8" }).end(`${marker} synthetic plain text\n`);
		if (url.pathname === "/tick") return void response.writeHead(200, { ...headers, "content-type": "text/plain", "content-length": 4 }).end("tick");
		response.writeHead(200, { ...headers, "content-type": "text/html" }).end(`<title>${marker}</title>${marker}`);
	};
}

for (const port of list(process.env.FIXTURE_PORTS)) {
	const server = port === 443
		? https.createServer({ cert: fs.readFileSync(path.join(tlsDir, "server.pem")), key: fs.readFileSync(path.join(tlsDir, "server-key.pem")) }, handler(port))
		: http.createServer(handler(port));
	// Long-lived sockets let the runner prove established flows stop too.
	server.keepAliveTimeout = 120_000;
	server.headersTimeout = 125_000;
	server.listen({ host, port, ipv6Only: false }, () => console.log(`${name} listening tcp ${host} ${port}`));
}

for (const port of list(process.env.FIXTURE_UDP)) {
	const socket = dgram.createSocket({ type: host.includes(":") ? "udp6" : "udp4", ipv6Only: false });
	socket.on("message", (_message, remote) => socket.send(`fixture:${name}`, remote.port, remote.address));
	socket.bind(port, host, () => console.log(`${name} listening udp ${host} ${port}`));
}

process.on("SIGTERM", () => process.exit(0));
