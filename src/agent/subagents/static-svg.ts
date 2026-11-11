import { DOMParser } from "linkedom";
import { LEARNER_IMAGE_HREF } from "../../core/learner-image-svg.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "../tools/learner-image-dimensions.ts";

/**
 * Server static-SVG policy (issue #26). resvg reads absolute and relative
 * file paths named by <image href> while it parses, so this check must run
 * before any Resvg is constructed. Every resource reference must be a local
 * #fragment. The only exceptions are the learner-image placeholder while the
 * maker authors an annotation, and, for the render of an annotation, the one
 * raster the app embedded from the session snapshot.
 *
 * Desktop does not call this: its visuals keep their existing behavior.
 */

/** Authored markup, not counting an app-embedded snapshot raster. */
export const MAX_STATIC_SVG_BYTES = 1024 * 1024;
/** Elements after expanding every <use> reference, so reference fan-out cannot multiply work. */
export const MAX_STATIC_SVG_EXPANDED_ELEMENTS = 50_000;

export interface StaticSvgOptions {
	/** Maker authoring an annotation: <image href="learner-image"> is allowed. */
	learnerPlaceholder?: boolean;
	/** Annotation render: at most one <image> may carry a bounded PNG/JPEG data URI. */
	embeddedRaster?: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const FRAGMENT = /^#[A-Za-z_][\w:.-]*$/;
const FRAGMENT_URL = /url\(\s*(["']?)#[A-Za-z_][\w:.-]*\1\s*\)/gi;
const ACTIVE_ELEMENTS = new Set(["script", "foreignobject", "animate", "animatemotion", "animatetransform", "animatecolor", "set", "discard", "iframe", "video", "audio", "canvas", "handler", "listener"]);
const RASTER = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const RASTER_MAGIC: Record<string, string> = { "image/png": "89504e470d0a1a0a", "image/jpeg": "ffd8ff" };

/** CSS text (a style attribute or <style> body) may only point at local fragments. */
function cssProblem(css: string): string | null {
	if (/\\/.test(css)) return "SVG styles cannot use escaped syntax";
	if (/@import/i.test(css)) return "SVG styles cannot import other resources";
	if (/url\s*\(/i.test(css.replace(FRAGMENT_URL, ""))) return "SVG resources must be local #fragment references";
	return null;
}

function rasterProblem(value: string): string | null {
	const match = RASTER.exec(value);
	if (!match) return "an embedded image must be a base64 PNG or JPEG";
	const mime = match[1]!;
	const encoded = match[2]!;
	if (encoded.length > Math.ceil(MAX_LEARNER_IMAGE_BYTES / 3) * 4) return "the embedded image exceeds 25 MiB";
	const bytes = Buffer.from(encoded, "base64");
	if (!bytes.subarray(0, RASTER_MAGIC[mime]!.length / 2).toString("hex").startsWith(RASTER_MAGIC[mime]!)) return "the embedded image bytes do not match their type";
	try {
		checkImageDimensions(bytes, mime);
	} catch (error) {
		return `the embedded image is out of bounds (${error instanceof Error ? error.message : String(error)})`;
	}
	return null;
}

/** Null when the SVG is static and self-contained under the server policy. */
export function staticSvgProblem(svg: string, opts: StaticSvgOptions = {}): string | null {
	const maxChars = MAX_STATIC_SVG_BYTES + (opts.embeddedRaster ? Math.ceil(MAX_LEARNER_IMAGE_BYTES / 3) * 4 + 64 : 0);
	if (svg.length > maxChars) return "the SVG exceeds 1 MiB";
	if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return "SVGs cannot declare entities or a document type";
	// Only a leading XML declaration; any other processing instruction is refused.
	if (/<\?/.test(svg.replace(/^\uFEFF?\s*<\?xml\s[^?<>]*\?>/, ""))) return "SVGs cannot contain processing instructions";
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml") as unknown as Document;
	const root = doc.documentElement;
	if (root?.localName !== "svg") return "expected a complete SVG document";
	const elements = Array.from(doc.querySelectorAll("*"));
	const ids = new Map<string, Element>();
	let embedded = 0;
	let embeddedChars = 0;
	for (const element of elements) {
		const name = element.localName.toLowerCase();
		if (name.includes(":")) return "SVG elements cannot use namespace prefixes";
		if (ACTIVE_ELEMENTS.has(name)) return "SVGs must be static: no scripts, animation, foreignObject or media elements";
		if (name === "style") {
			const problem = cssProblem(element.textContent ?? "");
			if (problem) return problem;
		}
		for (const attr of Array.from(element.attributes)) {
			const attrName = attr.name.toLowerCase();
			const value = attr.value;
			if (attrName === "id") {
				// resvg resolves the first duplicate, so a later one would let the
				// expansion count miss the real <use> target. Refuse them all.
				if (ids.has(value)) return `SVG ids must be unique ("${value}" repeats)`;
				ids.set(value, element);
			}
			if (attrName === "xmlns" && value !== SVG_NS) return "SVGs must use the SVG namespace";
			if (attrName.startsWith("xmlns:") && (attrName !== "xmlns:xlink" || value !== XLINK_NS)) return "SVGs cannot declare namespace aliases";
			if (attrName.includes(":") && !["xmlns:xlink", "xlink:href", "xml:lang", "xml:space"].includes(attrName)) return "SVGs cannot use qualified attribute aliases";
			if (attrName.startsWith("on")) return "SVGs cannot contain event handlers";
			if (attrName === "href" || attrName === "xlink:href") {
				if (FRAGMENT.test(value)) continue;
				if (name === "image" && opts.learnerPlaceholder && value === LEARNER_IMAGE_HREF) continue;
				if (name === "image" && opts.embeddedRaster && value.startsWith("data:")) {
					if (++embedded > 1) return "only one embedded image is allowed";
					const problem = rasterProblem(value);
					if (problem) return problem;
					embeddedChars = value.length;
					continue;
				}
				return "SVGs cannot reference other files, URLs or data; use local #fragment references";
			}
			const problem = cssProblem(value);
			if (problem) return problem;
		}
	}
	if (Buffer.byteLength(svg, "utf8") - embeddedChars > MAX_STATIC_SVG_BYTES) return "the SVG exceeds 1 MiB";
	return expansionProblem(root, ids);
}

/** Count elements as the renderer sees them, with each <use> expanded in place. */
function expansionProblem(root: Element, ids: Map<string, Element>): string | null {
	const sizes = new Map<Element, number>();
	const active = new Set<Element>();
	const size = (element: Element): number => {
		const known = sizes.get(element);
		if (known !== undefined) return known;
		if (active.has(element)) throw new Error("SVG <use> references cannot form a cycle");
		active.add(element);
		let total = 1;
		for (const child of Array.from(element.children)) total += size(child);
		if (element.localName.toLowerCase() === "use") {
			const ref = element.getAttribute("href") ?? element.getAttribute("xlink:href");
			const target = ref ? ids.get(ref.slice(1)) : undefined;
			if (target) total += size(target);
		}
		active.delete(element);
		total = Math.min(total, MAX_STATIC_SVG_EXPANDED_ELEMENTS + 1);
		sizes.set(element, total);
		return total;
	};
	try {
		if (size(root) > MAX_STATIC_SVG_EXPANDED_ELEMENTS) return `the SVG expands to more than ${MAX_STATIC_SVG_EXPANDED_ELEMENTS} elements`;
	} catch (error) {
		if (error instanceof RangeError) return "the SVG nests too deeply";
		return error instanceof Error ? error.message : String(error);
	}
	return null;
}
