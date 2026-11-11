import assert from "node:assert/strict";
import { test } from "node:test";
import { installServerVisualReadiness, isServerCapabilityAvailable } from "../src/core/server-capabilities.ts";
import { nativeVisualsReady } from "../src/server/visuals.ts";

test("native visual readiness proves real rendering and refuses failures or invalid output", () => {
	assert.equal(nativeVisualsReady(), true);
	assert.equal(nativeVisualsReady(() => { throw new Error("native binding failed"); }), false);
	assert.equal(nativeVisualsReady(() => new Uint8Array()), false);
	assert.equal(nativeVisualsReady(() => Buffer.alloc(32)), false);
});

test("server visuals fail closed without a successful probe; desktop does not consult it", () => {
	const previous = process.env.LH_SERVER_MODE;
	try {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerVisualReadiness(undefined);
		assert.equal(isServerCapabilityAvailable("visual"), false);
		installServerVisualReadiness(() => { throw new Error("probe unavailable"); });
		assert.equal(isServerCapabilityAvailable("visual"), false);
		installServerVisualReadiness(() => false);
		assert.equal(isServerCapabilityAvailable("visual"), false);
		installServerVisualReadiness(() => nativeVisualsReady());
		assert.equal(isServerCapabilityAvailable("visual"), true);
		delete process.env.LH_SERVER_MODE;
		installServerVisualReadiness(() => { throw new Error("desktop must not call server probe"); });
		assert.equal(isServerCapabilityAvailable("visual"), true);
	} finally {
		installServerVisualReadiness(undefined);
		if (previous === undefined) delete process.env.LH_SERVER_MODE;
		else process.env.LH_SERVER_MODE = previous;
	}
});
