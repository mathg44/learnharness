/** Exercise the image's actual native libraries, workers and traced providers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tinyPdf } from "/tiny-pdf.ts";
import { verifyProviderRuntime } from "/smoke/smoke-provider-runtime.mjs";
import { verifyImageRuntime } from "/smoke/smoke-image-runtime.mjs";
import { verifyDemoRuntime } from "/smoke/smoke-demo-runtime.mjs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Source-only native probes need the same extension resolution as upstream tsx.
// The HTTP production server remains Next's compiled output, without this hook.
const sourceHook = registerHooks({
	resolve(specifier, context, nextResolve) {
		try { return nextResolve(specifier, context); }
		catch (error) {
			if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && context.parentURL?.startsWith("file:///app/")) {
				const candidate = new URL(`${specifier}.ts`, context.parentURL);
				if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
			}
			throw error;
		}
	},
});
const { realHeadless } = await import("/app/src/agent/subagents/headless.ts");
const { pdfInfo, pdfExtract } = await import("/app/src/agent/subagents/pdf-ops.ts");
sourceHook.deregister();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-native-"));
try {
	const file = path.join(scratch, "synthetic.pdf");
	fs.writeFileSync(file, tinyPdf([{ runs: [{ text: "Synthetic PDF fixture", x: 40, y: 700 }] }]));
	assert.equal((await pdfInfo(file)).page_count, 1);
	assert.match(await pdfExtract(file, "1"), /Synthetic PDF fixture/);
	const pages = await realHeadless.renderPdfPages(file, [1], { dpi: 72 });
	assert.equal(pages.length, 1);
	assert.equal(pages[0].png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	const svg = await realHeadless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>');
	assert.equal(svg.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	console.log("native PDF text/page rendering and SVG rendering passed");
	verifyImageRuntime("/app");
	verifyProviderRuntime("/app");
	verifyDemoRuntime("/app");
	console.log("demo dependencies import successfully; real browser execution is not tested and remains a separate gate");
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
