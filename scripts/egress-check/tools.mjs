/** The real model tools under the real guard: web_fetch from
 * createWebTools and web_fetch_pdf/pdf_extract from createPdfReadTools,
 * loaded from the read-only checkout at /workspace/lh with the lockfile's
 * node_modules (Dockerfile dependencies stage; the standalone app bundles
 * them). Loaded through tsx, not strip-only Node: pdf-ops.ts uses
 * TypeScript parameter properties. Readiness is the app's own adapter
 * (src/server/egress.ts -> enforcementReady), never a stub. No search
 * provider, no keys, scratch data only in /tmp.
 *
 * Usage: node tools.mjs <fresh|stale> */
import fs from "node:fs";
import path from "node:path";

const expected = process.argv[2];
if (expected !== "fresh" && expected !== "stale") throw new Error("Usage: tools.mjs <fresh|stale>");
const scratch = fs.mkdtempSync("/tmp/lh-tools-");
fs.writeFileSync(path.join(scratch, "auth.json"), "{}", { mode: 0o600 });
Object.assign(process.env, { LH_SERVER_MODE: "tailscale", HOME: scratch, LH_DATA_DIR: path.join(scratch, "data"), LH_AUTH_FILE: path.join(scratch, "auth.json") });

const checkout = process.env.LH_CHECKOUT ?? "/workspace/lh";
await import(`${checkout}/src/server/egress.ts`);
const { createWebTools } = await import(`${checkout}/src/agent/tools/web.ts`);
const { createPdfReadTools } = await import(`${checkout}/src/agent/tools/pdf-read.ts`);
const topology = JSON.parse(fs.readFileSync("/topology.json", "utf8"));
const v4 = topology.public.hosts.fixture4;
const redirect = (/** @type {string} */ to) => `http://${v4}/redirect?to=${encodeURIComponent(to)}`;
const text = (/** @type {any} */ result) => (result.content ?? []).map((part) => part.text ?? "").join("\n");

const web = createWebTools(() => null);
const downloads = fs.mkdtempSync(path.join(scratch, "downloads-"));
const pdf = createPdfReadTools(downloads);
let failed = 0;
const report = (/** @type {string} */ name, /** @type {boolean} */ pass, /** @type {string} */ detail) => {
	if (!pass) failed++;
	console.log(JSON.stringify({ role: `tools-${expected}`, case: name, pass, detail: detail.replace(/\s+/g, " ").slice(0, 120) }));
};
const call = async (/** @type {any} */ tool, /** @type {object} */ input) => {
	try { return text(await tool.execute("egress-check", input, new AbortController().signal)); }
	catch (error) { return `threw: ${/** @type {Error} */ (error).message}`; }
};

const blocked = (/** @type {string} */ output) => /not available on this server/.test(output);
if (expected === "stale") {
	report("web_fetch blocked while stale", blocked(await call(web.web_fetch, { url: "https://public.fixture.test/text" })), "");
	report("web_fetch_pdf blocked while stale", blocked(await call(pdf.web_fetch_pdf, { url: "https://public.fixture.test/pdf" })), "");
} else {
	const fetched = await call(web.web_fetch, { url: "https://public.fixture.test/text" });
	report("web_fetch public HTTPS by DNS name", fetched.includes("fixture:public synthetic plain text"), fetched);
	const viaRedirect = await call(web.web_fetch, { url: redirect("https://public.fixture.test/text") });
	report("web_fetch public redirect to public", viaRedirect.includes("fixture:public"), viaRedirect);
	for (const [name, url] of [
		["private literal", redirect(`http://${topology.private.hosts.unrelated4}/text`)],
		["provider", redirect(`http://${topology.private.hosts.provider4}/text`)],
		["alias resolving private", redirect("http://private.fixture.test/text")],
		["alias resolving public and private", redirect("http://mixed.fixture.test/text")],
		["metadata", redirect(`http://${topology.linkLocal.hosts.metadata}/text`)],
	]) {
		const output = await call(web.web_fetch, { url });
		report(`web_fetch redirect to ${name} refused`, /web_fetch failed/.test(output) && !output.includes("fixture:"), output);
	}
	const download = await pdf.web_fetch_pdf.execute("egress-check", { url: redirect("https://public.fixture.test/pdf") }, new AbortController().signal)
		.catch((/** @type {Error} */ error) => ({ details: undefined, content: [{ text: error.message }] }));
	const summary = /** @type {any} */ (download).details;
	report("web_fetch_pdf public PDF via redirect", summary?.page_count === 1, text(download));
	if (summary?.path) {
		const extracted = await call(pdf.pdf_extract, { path: summary.path, pages: "1" });
		report("pdf_extract reads the downloaded page", extracted.includes("fixture:public synthetic pdf"), extracted);
	}
	const denied = await call(pdf.web_fetch_pdf, { url: redirect(`http://${topology.private.hosts.unrelated4}/pdf`) });
	report("web_fetch_pdf redirect to private refused", /web_fetch_pdf failed/.test(denied), denied);
}
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
