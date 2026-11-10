/** Server capability readiness as the app composes it: src/server/egress.ts
 * installs enforcementReady() into src/core/server-capabilities.ts. Runs in
 * the guard namespace with the app's policy and status mounts, from the
 * read-only checkout at /src-check, using Node's type stripping.
 *
 * Usage: node capabilities.mjs <fresh|stale>
 * fresh: research and downloaded PDFs ready; files, demo and visual still off.
 * stale: every capability off. */
process.env.LH_SERVER_MODE = "tailscale";
await import("/src-check/src/server/egress.ts");
const capabilities = await import("/src-check/src/core/server-capabilities.ts");

const expected = process.argv[2];
if (expected !== "fresh" && expected !== "stale") throw new Error("Usage: capabilities.mjs <fresh|stale>");
const fresh = expected === "fresh";
const checks = {
	research: capabilities.isServerCapabilityAvailable("research") === fresh,
	pdf: capabilities.isServerCapabilityAvailable("pdf") === fresh,
	"web_fetch tool": (capabilities.serverToolBlockReason("web_fetch") === null) === fresh,
	"web_fetch_pdf tool": (capabilities.serverToolBlockReason("web_fetch_pdf") === null) === fresh,
	"research job": (capabilities.serverJobBlockReason("research") === null) === fresh,
	files: capabilities.isServerCapabilityAvailable("files") === false,
	demo: capabilities.isServerCapabilityAvailable("demo") === false,
	visual: capabilities.isServerCapabilityAvailable("visual") === false,
	// Local-path PDF jobs still need file access.
	"local pdf tool": capabilities.serverToolBlockReason("pdf") !== null,
};
let failed = 0;
for (const [name, pass] of Object.entries(checks)) {
	if (!pass) failed++;
	console.log(JSON.stringify({ role: `capabilities-${expected}`, case: name, pass }));
}
process.exit(failed ? 1 : 0);
