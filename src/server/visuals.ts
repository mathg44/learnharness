/** Native server visual readiness. The immutable runtime is probed once;
 * generated SVGs still pass the static-resource and canvas checks per render. */
import { Resvg } from "@resvg/resvg-js";
import { installServerVisualReadiness } from "../core/server-capabilities.ts";

const PROBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/></svg>';

export function nativeVisualsReady(render: () => Uint8Array = () => new Resvg(PROBE_SVG).render().asPng()): boolean {
	try {
		const png = Buffer.from(render());
		return png.length >= 24 && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && png.readUInt32BE(16) === 32 && png.readUInt32BE(20) === 32;
	} catch {
		return false;
	}
}

const ready = nativeVisualsReady();
installServerVisualReadiness(() => ready);
