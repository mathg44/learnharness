/** Server learner-file readiness (#22). The files capability opens only when
 * /materials is its own read-only mount that cannot reach app data,
 * credentials or home. Checked fresh on every admission; any doubt denies.
 * Only server mode consults this, so desktop never reads /proc. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_FILE, BACKUP_STAGING_DIR, PATHS } from "../../config.ts";
import { installServerFileReadiness } from "../core/server-capabilities.ts";
import { isWithin, realSourcePath, SERVER_MATERIALS_ROOT } from "../agent/tools/file-access.ts";

/** The approved host directory, on the host's root filesystem. Fixed, never configurable. */
export const MATERIALS_HOST_SOURCE = "/var/lib/learnharness-materials";

interface MountEntry { device: string; root: string; mountPoint: string; options: string[] }

/** Seams for tests: synthetic roots and mount tables, never the live host. */
export interface MaterialsProbe {
	root: string;
	mountInfo: () => string;
	/** App-private locations that must not share a filesystem subtree with root. */
	protectedPaths: readonly string[];
	/** Error code from a write-access probe of root; EROFS means kernel read-only. */
	writeAccessError: () => string | undefined;
	/** The mount's source path inside its filesystem (mountinfo "root"). */
	expectedSource: string;
}

function unescapeMountField(field: string): string {
	return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** proc(5) mountinfo: id parent major:minor root mount-point options ... - ... */
export function parseMountInfo(text: string): MountEntry[] {
	const entries: MountEntry[] = [];
	for (const line of text.split("\n")) {
		const fields = line.trim().split(" ");
		if (fields.length < 6 || !fields.includes("-")) continue;
		entries.push({
			device: fields[2]!,
			root: unescapeMountField(fields[3]!),
			mountPoint: unescapeMountField(fields[4]!),
			options: fields[5]!.split(","),
		});
	}
	return entries;
}

/** The visible mount for a path is the last-mounted longest prefix. */
function mountFor(entries: readonly MountEntry[], target: string): MountEntry | undefined {
	let best: MountEntry | undefined;
	for (const entry of entries) {
		if (!isWithin(target, entry.mountPoint)) continue;
		if (!best || entry.mountPoint.length >= best.mountPoint.length) best = entry;
	}
	return best;
}

/** Where a path lives inside its filesystem, for comparing bind mounts. */
function filesystemLocation(entries: readonly MountEntry[], target: string): { device: string; location: string } | undefined {
	const mount = mountFor(entries, target);
	if (!mount) return undefined;
	return { device: mount.device, location: path.posix.join(mount.root, path.posix.relative(mount.mountPoint, target)) };
}

export function materialsReady(probe: MaterialsProbe = liveMaterialsProbe()): boolean {
	try {
		const { root } = probe;
		// A fixed, non-symlinked directory the app can list but never write.
		if (fs.realpathSync.native(/* turbopackIgnore: true */ root) !== root) return false;
		if (!fs.lstatSync(/* turbopackIgnore: true */ root).isDirectory()) return false;
		fs.accessSync(/* turbopackIgnore: true */ root, fs.constants.R_OK | fs.constants.X_OK);
		if (probe.writeAccessError() !== "EROFS") return false;

		const entries = parseMountInfo(probe.mountInfo());
		const own = entries.filter((entry) => entry.mountPoint === root);
		const mount = own.at(-1);
		if (!mount || !mount.options.includes("ro")) return false;
		// Only the approved host directory itself, not another read-only mount.
		if (!probe.expectedSource || mount.root !== probe.expectedSource) return false;
		// Nested mounts could bring in another filesystem; refuse rather than audit them.
		if (entries.some((entry) => entry.mountPoint !== root && isWithin(entry.mountPoint, root))) return false;

		for (const protectedPath of probe.protectedPaths) {
			// Strict: missing paths resolve through their longest existing parent,
			// and any other resolution error denies via the catch below.
			const real = realSourcePath(protectedPath);
			if (isWithin(real, root) || isWithin(root, real)) return false;
			const location = filesystemLocation(entries, real);
			if (!location || location.device !== mount.device) continue;
			if (isWithin(location.location, mount.root) || isWithin(mount.root, location.location)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export function liveMaterialsProbe(): MaterialsProbe {
	return {
		root: SERVER_MATERIALS_ROOT,
		mountInfo: () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
		protectedPaths: [PATHS.data, path.dirname(AUTH_FILE), BACKUP_STAGING_DIR, os.homedir()],
		writeAccessError: () => {
			try { fs.accessSync(SERVER_MATERIALS_ROOT, fs.constants.W_OK); return undefined; }
			catch (error) { return (error as NodeJS.ErrnoException).code ?? "unknown"; }
		},
		expectedSource: MATERIALS_HOST_SOURCE,
	};
}

installServerFileReadiness(() => materialsReady());
