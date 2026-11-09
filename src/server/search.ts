/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): search adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when several keys are
 *    present the order is Tavily → Brave → Exa → Firecrawl → Ollama);
 *    without a pin, the first keyed engine wins.
 *  - An explicit choice does NOT silently fall back to another engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 *
 * Server mode (#23): with LH_SERVER_MODE set, the default transport is
 * publicFetch, limited to the five exact search endpoints, with no
 * redirects, a 30 s budget and 1 MiB of response bytes. Failures carry
 * only the provider label and HTTP status, never provider bodies or
 * transport details. Desktop keeps global fetch.
 */

import { publicFetch, type PublicFetchOptions, type PublicFetchResponse } from "../agent/public-fetch.ts";
import { SEARCH_ENGINES, type SearchEngineId, type SearchHit, type SearchProvider, type SearchStatus } from "../core/search.ts";
import { isServerMode } from "../core/server-capabilities.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type PublicFetchLike = (url: string, options: PublicFetchOptions) => Promise<PublicFetchResponse>;

const SEARCH_TIMEOUT_MS = 30_000;
const SERVER_SEARCH_MAX_BYTES = 1024 * 1024;

/** Each fixed search protocol, checked before any credential reaches IO.
 * Only Brave uses a query string, with one q and one count parameter. */
const SEARCH_ENDPOINTS: ReadonlyMap<string, "GET" | "POST"> = new Map([
	["https://api.tavily.com/search", "POST"],
	["https://api.search.brave.com/res/v1/web/search", "GET"],
	["https://api.exa.ai/search", "POST"],
	["https://api.firecrawl.dev/v2/search", "POST"],
	["https://ollama.com/api/web_search", "POST"],
]);

/** The server-mode transport: exact endpoint check, then publicFetch with
 *  the search limits. The bounded bytes are rewrapped as a Response so the
 *  adapters parse the same way in both modes. */
export function serverSearchFetch(transport: PublicFetchLike = publicFetch): FetchLike {
	return async (input, init) => {
		const url = new URL(input);
		const expectedMethod = SEARCH_ENDPOINTS.get(`${url.origin}${url.pathname}`);
		if (url.protocol !== "https:" || url.username || url.password || url.hash || !expectedMethod) {
			throw new Error("search endpoint is not allowed");
		}
		const method = init.method ?? "GET";
		if (method !== expectedMethod) throw new Error("search method is not allowed");
		const queryKeys = [...url.searchParams.keys()].sort();
		if (expectedMethod === "POST" ? url.search !== "" : queryKeys.join(",") !== "count,q") {
			throw new Error("search query parameters are not allowed");
		}
		if (init.body != null && typeof init.body !== "string") throw new Error("search body must be a string");
		const response = await transport(url.href, {
			maxBytes: SERVER_SEARCH_MAX_BYTES,
			timeoutMs: SEARCH_TIMEOUT_MS,
			maxRedirects: 0,
			signal: init.signal ?? undefined,
			method,
			headers: Object.fromEntries(new Headers(init.headers)),
			body: init.body ?? undefined,
		});
		const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
		return new Response(nullBody ? null : new Uint8Array(response.bytes), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/** Chooses the transport per call, so the server-mode check is never
 *  captured when a provider is built. */
const defaultSearchFetch: FetchLike = (input, init) =>
	isServerMode() ? serverSearchFetch()(input, init) : fetch(input, init);

/** The adapter's 30 s timeout, combined with the caller's cancellation. */
function searchSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** In server mode, transport errors (blocked destination, size limit,
 *  timeout, DNS) are reduced to the provider label. */
async function searchRequest(label: string, fetchFn: FetchLike, url: string, init: RequestInit): Promise<Response> {
	if (!isServerMode()) return fetchFn(url, init);
	try {
		return await fetchFn(url, init);
	} catch {
		throw new Error(`${label} search request failed`);
	}
}

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = defaultSearchFetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const resp = await searchRequest("Tavily", fetchFn, "https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: searchSignal(signal),
			});
			if (!resp.ok) {
				if (isServerMode()) throw new Error(`Tavily search API ${resp.status}`);
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await (isServerMode() ? searchJson(resp, "Tavily") : resp.json())) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = defaultSearchFetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await searchRequest("Brave", fetchFn, url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: searchSignal(signal),
			});
			if (!resp.ok) {
				if (isServerMode()) throw new Error(`Brave search API ${resp.status}`);
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await (isServerMode() ? searchJson(resp, "Brave") : resp.json())) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Invalid JSON must not echo provider response bodies into tool results. */
async function searchJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} search API returned an invalid response`);
	}
}

/** Exa's Search API returns highlights when requested. Its result snippets
 * are normalized to the same bounded, provider-neutral shape as the other
 * adapters. Do not expose error bodies, which may contain credentials. */
export function exaProvider(apiKey: string, fetchFn: FetchLike = defaultSearchFetch): SearchProvider {
	return {
		id: "exa",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const resp = await searchRequest("Exa", fetchFn, "https://api.exa.ai/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify({ query, type: "auto", numResults: Math.min(100, Math.max(1, Math.floor(count))), contents: { highlights: true } }),
				signal: searchSignal(signal),
			});
			if (!resp.ok) throw new Error(`Exa search API ${resp.status}`);
			const data = await searchJson(resp, "Exa");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Exa search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; highlights?: unknown; text?: unknown };
				if (typeof row.url !== "string" || !row.url.trim()) return [];
				try {
					const protocol = new URL(row.url).protocol;
					if (protocol !== "http:" && protocol !== "https:") return [];
				} catch { return []; }
				const highlights = Array.isArray(row.highlights) ? row.highlights.filter((v): v is string => typeof v === "string").join(" ") : "";
				const snippet = highlights || (typeof row.text === "string" ? row.text : "");
				return [{ title: typeof row.title === "string" && row.title ? row.title : row.url, url: row.url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) }];
			});
		},
	};
}

/** Firecrawl's v2 search API: no scrapeOptions, so web_fetch still owns
 *  page bodies. Wire shape checked against the official 2026-11-03 snapshot;
 *  live account access and pricing are not inferred from configuration. */
export function firecrawlProvider(apiKey: string, fetchFn: FetchLike = defaultSearchFetch): SearchProvider {
	return {
		id: "firecrawl",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const resp = await searchRequest("Firecrawl", fetchFn, "https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, limit: Math.min(100, Math.max(1, Math.floor(count))) }),
				signal: searchSignal(signal),
			});
			if (!resp.ok) throw new Error(`Firecrawl search API ${resp.status}`);
			const data = await searchJson(resp, "Firecrawl");
			if (!data || typeof data !== "object" || (data as { success?: unknown }).success !== true) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			const payload = (data as { data?: unknown }).data;
			if (!payload || typeof payload !== "object" || !Array.isArray((payload as { web?: unknown }).web)) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			return (payload as { web: unknown[] }).web.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; description?: unknown };
				return searchHit(row.title, row.url, row.description);
			});
		},
	};
}

/** Hosted search only, adapted from chiranjivsethi's PR #81 (a216fa8).
 *  No local model URL, model registration, or provider-backed page fetch. */
export function ollamaProvider(apiKey: string, fetchFn: FetchLike = defaultSearchFetch): SearchProvider {
	return {
		id: "ollama",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const resp = await searchRequest("Ollama", fetchFn, "https://ollama.com/api/web_search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, Math.floor(count))) }),
				signal: searchSignal(signal),
			});
			if (!resp.ok) throw new Error(`Ollama search API ${resp.status}`);
			const data = await searchJson(resp, "Ollama");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Ollama search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; content?: unknown };
				return searchHit(row.title, row.url, row.content);
			});
		},
	};
}

/** Match Exa's bounded result contract for the other new adapters. */
function searchHit(title: unknown, url: unknown, snippet: unknown): SearchHit[] {
	if (typeof url !== "string" || !url.trim()) return [];
	try {
		const protocol = new URL(url).protocol;
		if (protocol !== "http:" && protocol !== "https:") return [];
	} catch { return []; }
	return [{
		title: typeof title === "string" && title ? title : url,
		url,
		snippet: typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim().slice(0, 500) : "",
	}];
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Every engine's live key, read fresh (the resolver's input). */
function engineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of SEARCH_ENGINES) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${SEARCH_ENGINES.find((e) => e.id === pinned)?.envVar} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of SEARCH_ENGINES) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily, Brave, Exa, Firecrawl, or Ollama search API key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** Search status only — research itself remains available without a key. */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	switch (resolved.engine) {
		case "tavily":
			return tavilyProvider(resolved.key);
		case "brave":
			return braveProvider(resolved.key);
		case "exa":
			return exaProvider(resolved.key);
		case "firecrawl":
			return firecrawlProvider(resolved.key);
		case "ollama":
			return ollamaProvider(resolved.key);
		default:
			return null;
	}
}
