import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { evaluateServerAccess } from "./src/server/server-access.ts";
import { OFFLINE_DEMO_PARENT_CSP } from "./src/core/demo-document-policy.ts";

/** Server mode protects pages, APIs and streams. Desktop capabilities remain API-only. */
export function proxy(request: NextRequest) {
	const access = evaluateServerAccess(request.method, request.headers);
	if (!access.allowed) {
		return NextResponse.json({ error: "Access denied." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	if (!request.nextUrl.pathname.startsWith("/api/")) {
		const response = NextResponse.next();
		if (process.env.LH_SERVER_MODE !== undefined) {
			response.headers.set("Content-Security-Policy", OFFLINE_DEMO_PARENT_CSP);
			response.headers.set("X-DNS-Prefetch-Control", "off");
		}
		return response;
	}
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static/|favicon\\.ico$).*)"] };
