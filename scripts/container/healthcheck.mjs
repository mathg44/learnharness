import { get } from "node:http";

/** Local liveness probe. The container is a trusted local administrator. */
try {
	const headers = {};
	if (process.env.LH_SERVER_TRIAL === "1") {
		headers.host = new URL(process.env.LH_SERVER_TRIAL_ORIGIN).host;
		headers["tailscale-user-login"] = process.env.LH_SERVER_TRIAL_OWNER;
		headers["x-forwarded-proto"] = "https";
	}
	// Node fetch does not preserve an overridden Host. Use HTTP directly.
	const request = get(`http://127.0.0.1:${process.env.PORT || "3000"}/api/settings`, { headers, timeout: 4000 }, (response) => {
		let body = "";
		response.setEncoding("utf8");
		response.on("data", (chunk) => {
			body += chunk;
			if (body.length > 65536) request.destroy(new Error("Health response too large"));
		});
		response.on("error", () => { process.exitCode = 1; });
		response.on("end", () => {
			try {
				if (response.statusCode !== 200 || !("settings" in JSON.parse(body))) process.exitCode = 1;
			} catch { process.exitCode = 1; }
		});
	});
	request.on("timeout", () => request.destroy(new Error("Health timeout")));
	request.on("error", () => { process.exitCode = 1; });
} catch {
	process.exitCode = 1;
}
