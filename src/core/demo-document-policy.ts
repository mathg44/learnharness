/**
 * Demo-document policy for server mode, shared by the demo worker
 * (scripts/demo), the demo builder and the demo card. Pure and dependency
 * free: the worker image copies this one file and runs it with Node's type
 * stripping, so keep to erasable TypeScript syntax.
 *
 * Desktop keeps its permissive documents (CDN imports allowed). Server mode
 * selects "offline" for every demo document, saved ones included. The name
 * describes the document (self-contained, no network addresses), and the
 * verification worker, which has no network at all. In the learner's
 * browser the demo is network-RESTRICTED, not network-free:
 *
 * - the server page sends `frame-src 'none'; child-src 'none'`, which stops
 *   the srcdoc frame navigating itself (a meta CSP inside the frame cannot
 *   block navigation);
 * - the iframe sandbox (allow-scripts only) gives an opaque origin with no
 *   storage, cookies, app DOM, popups, forms or top navigation;
 * - the meta CSP blocks subresources, fetch, XHR, WebSocket, WebTransport,
 *   EventSource, beacons, pings, workers and nested fetched frames.
 *
 * Known residual channels, proven in Chromium 156 by tests/demo-browser and
 * accepted by the owner: WebRTC STUN/TURN UDP (CSP does not govern it and
 * Chromium ignores `webrtc 'block'`) and DNS lookups from
 * `<link rel=preconnect>`. No page-controlled mechanism closes them, so
 * nothing here pretends to.
 */

export type DemoDocumentPolicy = "desktop" | "offline";

/** Largest demo document the server accepts, in UTF-8 bytes. */
export const MAX_DEMO_HTML_BYTES = 512 * 1024;
/** Request body limit for the worker socket (JSON-escaped HTML plus probe). */
export const MAX_DEMO_REQUEST_BYTES = 1024 * 1024;
export const MAX_DEMO_PROBE_CHARS = 4096;

/**
 * Same directives for the worker's response header and the displayed
 * document's meta tag. Inline script and eval stay allowed (demos are inline
 * by contract); everything that could fetch is 'none' or local-only.
 */
export const OFFLINE_DEMO_CSP_DIRECTIVES: readonly string[] = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"connect-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"worker-src 'none'",
	"object-src 'none'",
	"manifest-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
];

export const OFFLINE_DEMO_CSP = OFFLINE_DEMO_CSP_DIRECTIVES.join("; ");

/** The CSP header on server-mode HTML pages (proxy.ts). The srcdoc frame
 *  is never fetched, so 'none' still renders it, but every navigation the
 *  frame starts (location, meta refresh, link click, data:) is refused
 *  before a request leaves the browser. */
export const OFFLINE_DEMO_PARENT_CSP = "frame-src 'none'; child-src 'none'";

/** Placed first in the document so the policy covers every later element.
 *  The prefetch-control meta stops implicit anchor prefetching only;
 *  explicit preconnect/dns-prefetch hints are a known residual. */
export const OFFLINE_DEMO_HEAD =
	`<meta http-equiv="Content-Security-Policy" content="${OFFLINE_DEMO_CSP}">` +
	`<meta http-equiv="x-dns-prefetch-control" content="off">`;

export type DemoHtmlProblem =
	| { kind: "not-text" }
	| { kind: "empty" }
	| { kind: "too-large"; bytes: number }
	| { kind: "nul" }
	| { kind: "lone-surrogate" };

/** Structural checks only. Browsers parse any text, so "malformed" means
 *  the bytes cannot be carried faithfully. */
export function demoHtmlProblem(html: unknown): DemoHtmlProblem | null {
	if (typeof html !== "string") return { kind: "not-text" };
	if (html.trim().length === 0) return { kind: "empty" };
	if (html.includes("\u0000")) return { kind: "nul" };
	if (!isWellFormedText(html)) return { kind: "lone-surrogate" };
	const bytes = utf8Length(html);
	if (bytes > MAX_DEMO_HTML_BYTES) return { kind: "too-large", bytes };
	return null;
}

export function describeDemoHtmlProblem(problem: DemoHtmlProblem): string {
	switch (problem.kind) {
		case "not-text": return "the demo document is not text";
		case "empty": return "the demo document is empty";
		case "nul": return "the demo document contains a NUL character";
		case "lone-surrogate": return "the demo document contains invalid Unicode";
		case "too-large":
			return `the demo document is ${Math.ceil(problem.bytes / 1024)} KB; the limit is ${MAX_DEMO_HTML_BYTES / 1024} KB`;
	}
}

// XML namespace identifiers look like URLs but are never fetched.
const NAMESPACE_URIS = new Set([
	"http://www.w3.org/2000/svg",
	"http://www.w3.org/1999/xhtml",
	"http://www.w3.org/1999/xlink",
	"http://www.w3.org/1998/math/mathml",
	"http://www.w3.org/xml/1998/namespace",
	"http://www.w3.org/2000/xmlns/",
]);

const ABSOLUTE_URL = /\b(?:https?|wss?|ftp|file):\/\/[^\s"'`<>()]*/gi;
// Scheme-relative references in attribute, CSS and import positions.
const SCHEME_RELATIVE = /(?:\b(?:src|href|action|poster|data|srcset)\s*=\s*["']?|url\(\s*["']?|@import\s+["']|\bfrom\s+["']|\bimport\(\s*["'])\/\/[^\s"'`<>()]+/gi;

/** Network addresses the document names (bounded list). Offline demos may
 *  name none: an offline frame cannot load them and links would be dead. */
export function findExternalReferences(html: string, limit = 10): string[] {
	const found: string[] = [];
	const add = (value: string) => {
		const trimmed = value.replace(/[.,;]+$/, "");
		if (NAMESPACE_URIS.has(trimmed.toLowerCase())) return;
		if (!found.includes(trimmed)) found.push(trimmed.slice(0, 200));
	};
	for (const match of html.matchAll(ABSOLUTE_URL)) {
		add(match[0]);
		if (found.length >= limit) return found;
	}
	for (const match of html.matchAll(SCHEME_RELATIVE)) {
		add(match[0].slice(match[0].indexOf("//")));
		if (found.length >= limit) return found;
	}
	return found;
}

const DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/** Put the offline head first, after an optional doctype. A meta element
 *  before <html> starts the head, so the policy precedes all demo content;
 *  the demo cannot loosen it (extra policies only narrow). */
export function withOfflineDemoPolicy(html: string): string {
	const doctype = html.match(DOCTYPE)?.[0];
	if (doctype) return `${doctype}${OFFLINE_DEMO_HEAD}${html.slice(doctype.length)}`;
	// No doctype: keep the author's quirks mode, the meta still opens the head.
	return `${OFFLINE_DEMO_HEAD}${html}`;
}

/** The fixed outer page of a downloaded offline demo. A file on disk has
 *  no server header, so this page plays the server page's role: it runs no
 *  script and its frame-src/child-src stop the inner frame navigating. */
export const OFFLINE_DEMO_DOWNLOAD_CSP = [
	"default-src 'none'",
	"script-src 'none'",
	"style-src 'unsafe-inline'",
	"frame-src 'none'",
	"child-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

/** Downloaded offline demo: generated code runs only inside the opaque
 *  sandboxed srcdoc frame, under the same document policy as on screen. */
export function offlineDemoDownload(title: string, html: string): string {
	return [
		"<!doctype html><html><head><meta charset=\"utf-8\">",
		`<meta http-equiv="Content-Security-Policy" content="${OFFLINE_DEMO_DOWNLOAD_CSP}">`,
		"<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">",
		`<title>${escapeHtml(title)}</title>`,
		"<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>",
		"</head><body>",
		`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(title)}" srcdoc="${escapeHtml(withOfflineDemoPolicy(html))}"></iframe>`,
		"</body></html>",
	].join("");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

function isWellFormedText(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}
