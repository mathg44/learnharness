/**
 * Trial topology: owner -> Tailscale Serve HTTPS -> host-loopback Docker port.
 * Serve strips client identity headers and supplies Tailscale-User-Login.
 * Host administrators and other local processes are trusted, since they can
 * already read the app's credentials or control Docker. Never publish the
 * backend port to a LAN/tailnet interface or use this behind another ingress.
 * Verify the actual Serve Host/forwarded headers when enabling the route.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type TrialAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: "trial_misconfigured" | "identity" | "host" | "origin" };

function configuredOrigin(raw: string | undefined): { origin: string; host: string } | null {
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname) return null;
	return { origin: url.origin, host: url.host };
}

/** Fail closed when enabled without a valid owner and public HTTPS origin. */
export function evaluateTrialAccess(
	method: string,
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): TrialAccessDecision {
	if (env.LH_SERVER_TRIAL !== "1") return { allowed: true };

	const owner = env.LH_SERVER_TRIAL_OWNER;
	const origin = configuredOrigin(env.LH_SERVER_TRIAL_ORIGIN);
	if (!owner || owner.trim() !== owner || owner.includes(",") || !origin) return { allowed: false, reason: "trial_misconfigured" };
	if (headers.get("tailscale-user-login") !== owner) return { allowed: false, reason: "identity" };

	const forwardedHost = headers.get("x-forwarded-host");
	const forwardedProto = headers.get("x-forwarded-proto");
	if (headers.get("host") !== origin.host) return { allowed: false, reason: "host" };
	if (forwardedHost !== null && forwardedHost !== origin.host) return { allowed: false, reason: "host" };
	if (forwardedProto !== null && forwardedProto !== "https") return { allowed: false, reason: "host" };

	const requestOrigin = headers.get("origin");
	if (requestOrigin !== null) {
		if (requestOrigin !== origin.origin) return { allowed: false, reason: "origin" };
	} else if (!SAFE_METHODS.has(method.toUpperCase())) {
		return { allowed: false, reason: "origin" };
	}
	return { allowed: true };
}
