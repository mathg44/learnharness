import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	installServerEgressReadiness,
	isServerCapabilityAvailable,
	serverJobBlockReason,
	serverToolBlockReason,
} from "../src/core/server-capabilities.ts";

const previousMode = process.env.LH_SERVER_MODE;
afterEach(() => {
	installServerEgressReadiness(undefined);
	if (previousMode === undefined) delete process.env.LH_SERVER_MODE;
	else process.env.LH_SERVER_MODE = previousMode;
});

test("research and downloaded PDFs require a fresh enforcement check on every admission", () => {
	process.env.LH_SERVER_MODE = "tailscale";
	assert.equal(isServerCapabilityAvailable("research"), false);
	assert.equal(isServerCapabilityAvailable("pdf"), false);
	let fresh = true;
	installServerEgressReadiness(() => fresh);
	assert.equal(serverJobBlockReason("research"), null);
	assert.equal(serverToolBlockReason("web_fetch_pdf"), null);
	assert.equal(serverToolBlockReason("pdf_info"), null);
	assert.ok(serverJobBlockReason("pdf"), "local PDFs still require file access");
	for (const capability of ["files", "demo", "visual"] as const) {
		assert.equal(isServerCapabilityAvailable(capability), false);
	}
	fresh = false;
	assert.ok(serverJobBlockReason("research"));
	assert.ok(serverToolBlockReason("web_fetch_pdf"));
});

test("a failed or unwired enforcement adapter never grants a server capability", () => {
	process.env.LH_SERVER_MODE = "tailscale";
	installServerEgressReadiness(() => { throw new Error("unreadable state"); });
	assert.ok(serverJobBlockReason("research"));
	assert.ok(serverToolBlockReason("web_fetch_pdf"));
	installServerEgressReadiness(undefined);
	assert.equal(isServerCapabilityAvailable("research"), false);
});

test("desktop and local development do not require a container guard", () => {
	delete process.env.LH_SERVER_MODE;
	installServerEgressReadiness(() => { throw new Error("must not probe on desktop"); });
	for (const capability of ["files", "research", "pdf", "demo", "visual"] as const) {
		assert.equal(isServerCapabilityAvailable(capability), true);
	}
});
