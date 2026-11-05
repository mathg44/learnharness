import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { evaluateTrialAccess } from "./src/server/trial-access.ts";

/** Trial mode protects pages, APIs and streams. Desktop capabilities remain API-only. */
export function proxy(request: NextRequest) {
	const trial = evaluateTrialAccess(request.method, request.headers);
	if (!trial.allowed) {
		return NextResponse.json({ error: "Access denied." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	if (!request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static/|favicon\\.ico$).*)"] };
