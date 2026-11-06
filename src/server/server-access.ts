/**
 * Server topology: tailnet user -> Tailscale Serve HTTPS -> host-loopback
 * Docker port. Serve strips client identity headers and supplies
 * Tailscale-User-Login for authenticated tailnet users. Any such user is
 * accepted; access control beyond that is the tailnet's membership and ACLs.
 * Host administrators and other local processes are trusted, since they can
 * already read the app's credentials or control Docker. Never publish the
 * backend port to a LAN/tailnet interface, enable Funnel, or use this behind
 * another ingress. Verify the actual Serve Host/forwarded headers when
 * enabling the route.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ServerAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: "server_misconfigured" | "identity" | "host" | "origin" };

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

/** Unset LH_SERVER_MODE allows everything (desktop and local development).
 * Any value other than "tailscale", or a missing/invalid origin, fails closed. */
export function evaluateServerAccess(
	method: string,
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): ServerAccessDecision {
	if (env.LH_SERVER_MODE === undefined) return { allowed: true };

	const origin = configuredOrigin(env.LH_SERVER_ORIGIN);
	if (env.LH_SERVER_MODE !== "tailscale" || !origin) return { allowed: false, reason: "server_misconfigured" };
	if (!headers.get("tailscale-user-login")) return { allowed: false, reason: "identity" };

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
