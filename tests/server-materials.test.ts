/**
 * Server learner files (#22): the files capability and every learner-file
 * read on a server are confined to the read-only /materials mount.
 *
 * Most cases use synthetic mount tables and directories. The "live mount"
 * block needs a real read-only bind of tests/fixtures/materials at
 * /materials, for example in a throwaway Node container:
 *
 *   docker run --rm --network none -e LH_TEST_MATERIALS=1 \
 *     -e LH_TEST_MATERIALS_SOURCE="$(realpath tests/fixtures/materials)" \
 *     -v "$PWD":/repo:ro -v "$PWD/tests/fixtures/materials":/materials:ro -w /repo node:26 \
 *     node_modules/.bin/tsx --test tests/server-materials.test.ts
 *
 * LH_TEST_MATERIALS_SOURCE is the fixture's path inside its host filesystem,
 * the mountinfo "root" field. realpath is right when the checkout's filesystem
 * is mounted at /. The variable exists only in this test.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-materials-")));
const home = path.join(profile, "home");
const data = path.join(profile, "data");
const auth = path.join(profile, "auth", "auth.json");
const priorEnv = Object.fromEntries(["HOME", "USERPROFILE", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_SERVER_MODE"].map((key) => [key, process.env[key]]));
fs.mkdirSync(path.join(home, "Notes"), { recursive: true });
fs.mkdirSync(path.dirname(auth), { recursive: true });
fs.writeFileSync(auth, "{}\n", { mode: 0o600 });
fs.writeFileSync(path.join(home, "Notes", "home-notes.md"), "HOME_ONLY_MARKER\n");
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_DATA_DIR: data, LH_AUTH_FILE: auth });
delete process.env.LH_SERVER_MODE;

const capabilities = await import("../src/core/server-capabilities.ts");
const { installServerEgressReadiness, installServerFileReadiness, isServerCapabilityAvailable, serverJobBlockReason, serverToolBlockReason } = capabilities;
const fileAccess = await import("../src/agent/tools/file-access.ts");
const { fileAccessPolicy, guardSourcePath, resolvePolicy, setFileAccessPolicy, SERVER_FILE_TOOLS_HELP, SERVER_MATERIALS_ROOT } = fileAccess;
const { resolveIssuedDownload, resolveSourcePath, sourceSearchRoots, walkFiles } = await import("../src/agent/tools/fs-shared.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { findTool } = await import("../src/agent/tools/find.ts");
const { grepTool } = await import("../src/agent/tools/grep.ts");
const { createShowImageTool } = await import("../src/agent/tools/show-image.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
// Importing the adapter installs the live check, as the server entry point does.
const { liveMaterialsProbe, MATERIALS_HOST_SOURCE, materialsReady, parseMountInfo } = await import("../src/server/materials.ts");
const liveReadiness = () => materialsReady();

after(() => {
	installServerFileReadiness(liveReadiness);
	installServerEgressReadiness(undefined);
	fs.rmSync(profile, { recursive: true, force: true });
	for (const [key, value] of Object.entries(priorEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterEach(() => {
	delete process.env.LH_SERVER_MODE;
	installServerFileReadiness(liveReadiness);
	installServerEgressReadiness(undefined);
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
});

const homeNotes = path.join(home, "Notes", "home-notes.md");
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");
const run = (tool: AgentTool<any>, params: unknown) => tool.execute!("call-1", params, undefined as never);
/** Refusals surface as either an error result or a thrown error; return the text either way. */
async function attempt(tool: AgentTool<any>, params: unknown): Promise<{ denied: boolean; text: string }> {
	try {
		const result = await run(tool, params);
		return { denied: result.isError === true, text: text(result) };
	} catch (error) {
		return { denied: true, text: error instanceof Error ? error.message : String(error) };
	}
}

/** A synthetic materials directory plus a matching mount table. */
function fixture(options: { line?: string; extra?: string[]; writeError?: string | undefined; protectedPaths?: string[] } = {}) {
	const root = fs.mkdtempSync(path.join(profile, "materials-"));
	const escaped = root.replace(/ /g, "\\040");
	const lines = [
		"20 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
		options.line ?? `90 20 8:1 /srv/materials ${escaped} ro,nosuid,nodev,relatime master:1 - ext4 /dev/sda1 rw`,
		...(options.extra ?? []),
	];
	return {
		root,
		mountInfo: () => lines.join("\n") + "\n",
		protectedPaths: options.protectedPaths ?? [data, path.dirname(auth), home],
		writeAccessError: () => "writeError" in options ? options.writeError : "EROFS",
		expectedSource: "/srv/materials",
	};
}

describe("materials mount readiness", () => {
	it("accepts only a read-only, unnested, kernel-enforced mount of the fixed root", () => {
		assert.equal(SERVER_MATERIALS_ROOT, "/materials");
		assert.equal(materialsReady(fixture()), true);
		const probe = fixture();
		assert.equal(materialsReady({ ...probe, mountInfo: () => probe.mountInfo().replace(" ro,", " rw,") }), false, "read-write mount");
		assert.equal(materialsReady({ ...probe, mountInfo: () => "20 1 8:1 / / rw - ext4 /dev/sda1 rw\n" }), false, "not its own mount");
		assert.equal(materialsReady({ ...probe, mountInfo: () => { throw new Error("no /proc"); } }), false, "unreadable mount table");
		assert.equal(materialsReady({ ...probe, mountInfo: () => "" }), false, "empty mount table");
		assert.equal(materialsReady(fixture({ writeError: undefined })), false, "writable root");
		assert.equal(materialsReady(fixture({ writeError: "EACCES" })), false, "only permissions, not a read-only filesystem");
		assert.equal(materialsReady({ ...probe, writeAccessError: () => { throw new Error("probe failed"); } }), false);
	});

	it("uses the topmost mount at the root and refuses nested mounts", () => {
		const base = fixture();
		const stacked = `91 90 8:1 /srv/materials ${base.root} rw,relatime - ext4 /dev/sda1 rw`;
		assert.equal(materialsReady({ ...base, mountInfo: () => base.mountInfo() + stacked + "\n" }), false);
		const nested = `92 90 0:60 / ${base.root}/data ro,relatime - tmpfs tmpfs ro`;
		assert.equal(materialsReady({ ...base, mountInfo: () => base.mountInfo() + nested + "\n" }), false);
	});

	it("refuses absent, symlinked and non-directory roots", () => {
		const base = fixture();
		assert.equal(materialsReady({ ...base, root: path.join(profile, "missing") }), false);
		const link = path.join(profile, "materials-link");
		fs.symlinkSync(base.root, link);
		assert.equal(materialsReady({ ...base, root: link, mountInfo: () => base.mountInfo().replaceAll(base.root, link) }), false);
		const file = path.join(profile, "materials-file");
		fs.writeFileSync(file, "x");
		assert.equal(materialsReady({ ...base, root: file, mountInfo: () => base.mountInfo().replaceAll(base.root, file) }), false);
	});

	it("refuses a root that overlaps app data, credentials or home, by path or by bind source", () => {
		const base = fixture();
		assert.equal(materialsReady({ ...base, protectedPaths: [path.join(base.root, "data")] }), false, "data inside materials");
		assert.equal(materialsReady({ ...base, protectedPaths: [path.dirname(base.root)] }), false, "materials inside a protected path");
		const dataMount = (source: string) => `93 20 8:1 ${source} ${data} rw,relatime - ext4 /dev/sda1 rw`;
		for (const source of ["/srv/materials/private", "/srv"]) {
			assert.equal(materialsReady({ ...base, mountInfo: () => base.mountInfo() + dataMount(source) + "\n" }), false, source);
		}
		assert.equal(materialsReady({ ...base, mountInfo: () => base.mountInfo() + dataMount("/srv/learnharness-data") + "\n" }), true, "sibling host directory");
		const otherDevice = `94 20 0:70 /srv/materials/private ${data} rw - ext4 /dev/sdb1 rw`;
		assert.equal(materialsReady({ ...base, mountInfo: () => base.mountInfo() + otherDevice + "\n" }), true, "different filesystem");
	});

	it("requires the fixed host source behind the mount", () => {
		assert.equal(MATERIALS_HOST_SOURCE, "/var/lib/learnharness-materials");
		assert.equal(liveMaterialsProbe().expectedSource, MATERIALS_HOST_SOURCE);
		assert.equal(liveMaterialsProbe().root, "/materials");
		const probe = fixture();
		for (const source of ["/srv/other", "/srv/materials/sub", "/srv", "/var/lib/learnharness-materials"]) {
			assert.equal(materialsReady({ ...probe, mountInfo: () => probe.mountInfo().replace(" /srv/materials ", ` ${source} `) }), false, source);
		}
		assert.equal(materialsReady({ ...probe, expectedSource: MATERIALS_HOST_SOURCE }), false, "unrelated read-only mount");
	});

	it("canonicalizes missing protected paths through symlinks and fails on other resolution errors", () => {
		const probe = fixture();
		const link = path.join(profile, "into-materials");
		fs.symlinkSync(probe.root, link);
		assert.equal(materialsReady({ ...probe, protectedPaths: [path.join(link, "auth", "auth.json")] }), false, "missing path under a link into materials");
		const loop = path.join(profile, "loop");
		fs.symlinkSync(loop, loop);
		assert.equal(materialsReady({ ...probe, protectedPaths: [path.join(loop, "data")] }), false, "unresolvable protected path");
		assert.equal(materialsReady({ ...probe, protectedPaths: [path.join(profile, "not-yet", "data")] }), true, "ordinary missing path");
	});

	it("decodes mountinfo escapes", () => {
		const [entry] = parseMountInfo("90 20 8:1 /srv/my\\040notes /materials ro - ext4 /dev/sda1 rw\n");
		assert.deepEqual(entry, { device: "8:1", root: "/srv/my notes", mountPoint: "/materials", options: ["ro"] });
		const spaced = fs.mkdtempSync(path.join(profile, "with space "));
		const probe = fixture();
		assert.equal(materialsReady({ ...probe, root: spaced, mountInfo: () => probe.mountInfo().replaceAll(probe.root, spaced.replace(/ /g, "\\040")) }), true);
	});
});

describe("server-mode resolver policy", () => {
	it("never falls back to the open default or browser settings while files are unavailable", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
		for (const check of [undefined, () => false, () => { throw new Error("broken"); }]) {
			installServerFileReadiness(check);
			assert.equal(isServerCapabilityAvailable("files"), false);
			assert.throws(() => fileAccessPolicy(), /not available on this server/);
			assert.throws(() => resolvePolicy(), /not available on this server/);
			assert.throws(() => resolveSourcePath(homeNotes), /not available on this server/);
			assert.throws(() => sourceSearchRoots(), /not available on this server/);
			await assert.rejects(walkFiles(home, () => false), /not available on this server/);
		}
	});

	it("confines reads to /materials when ready, whatever the settings say", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => true);
		for (const policy of [{ restricted: false, folders: [] }, { restricted: true, folders: [home] }]) {
			setFileAccessPolicy(() => policy);
			assert.deepEqual(fileAccessPolicy(), { restricted: true, folders: ["/materials"] });
			assert.throws(() => resolveSourcePath(homeNotes), /outside the allowed folders/);
			assert.throws(() => resolveSourcePath("Notes/home-notes.md"), /outside the allowed folders/);
			assert.throws(() => resolveSourcePath(auth));
		}
		for (const [tool, params] of [
			[readTool, { path: homeNotes }],
			[lsTool, { path: home }],
			[findTool, { pattern: "*.md", path: home }],
			[grepTool, { pattern: "HOME_ONLY_MARKER", path: home }],
		] as const) {
			const result = await attempt(tool, params);
			assert.equal(result.denied, true, tool.name);
			assert.doesNotMatch(result.text, /HOME_ONLY_MARKER/);
		}
	});

	it("refusals name the operator-managed /materials on a server and Settings on desktop", async () => {
		const noRoots = { restricted: true, folders: [], unavailable: ["Unavailable allowed folder: /materials"] };
		const materialsOnly = { restricted: true, folders: ["/materials"], unavailable: [] };
		const operator = /only allowed folder is \/materials.*server operator/;
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => true);
		// On a server the supplied policy is replaced by the /materials snapshot.
		assert.throws(() => guardSourcePath(homeNotes, materialsOnly), (error: Error) => operator.test(error.message) && /allowed folders/.test(error.message) && !/Settings/.test(error.message));
		const read = await attempt(readTool, { path: homeNotes });
		assert.match(read.text, operator);
		assert.doesNotMatch(read.text, /Settings/);
		delete process.env.LH_SERVER_MODE;
		assert.throws(() => sourceSearchRoots(undefined, noRoots), /Add or repair folders in Settings → Agent → Tools → File access\./);
		assert.throws(() => guardSourcePath(homeNotes, materialsOnly), /ask the learner to adjust File access in Settings → Agent → Tools\./);
	});

	it("caller-supplied policies cannot bypass the server root or readiness", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		const open = { restricted: false, folders: [], unavailable: [] };
		const widened = { restricted: true, folders: [home], unavailable: [] };
		for (const ready of [false, true]) {
			installServerFileReadiness(() => ready);
			const refused = ready ? /outside the allowed folders/ : /not available on this server/;
			for (const policy of [open, widened]) {
				assert.throws(() => guardSourcePath(homeNotes, policy), refused);
				assert.throws(() => resolveSourcePath(homeNotes, policy), refused);
				assert.throws(() => sourceSearchRoots(home, policy), refused);
				await assert.rejects(walkFiles(home, () => false, undefined, { policy }), refused);
			}
			if (ready) {
				assert.deepEqual(resolvePolicy({ restricted: false, folders: [] }).restricted, true);
				const snapshot = resolvePolicy();
				assert.throws(() => (snapshot.folders as string[]).push(home));
				assert.throws(() => { (snapshot as { restricted: boolean }).restricted = false; });
			} else {
				assert.throws(() => resolvePolicy({ restricted: false, folders: [] }), refused);
			}
		}
	});

	it("mutating the returned server policy cannot widen later calls", () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => true);
		const shared = fileAccessPolicy() as { restricted: boolean; folders: string[] };
		assert.throws(() => { shared.restricted = false; }, TypeError);
		assert.throws(() => shared.folders.push(home), TypeError);
		assert.throws(() => { shared.folders[0] = home; }, TypeError);
		assert.deepEqual(fileAccessPolicy(), { restricted: true, folders: ["/materials"] });
		const resolved = resolvePolicy();
		assert.equal(resolved.restricted, true);
		assert.ok(!resolved.folders.includes(home));
		assert.throws(() => resolveSourcePath(homeNotes), /outside the allowed folders/);
	});

	it("a recorded snapshot still re-checks files readiness on every use", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		let ready = true;
		installServerFileReadiness(() => ready);
		const snapshot = resolvePolicy();
		ready = false;
		assert.throws(() => guardSourcePath("/materials/notes.md", snapshot), /not available on this server/);
		assert.throws(() => resolveSourcePath("/materials/notes.md", snapshot), /not available on this server/);
		assert.throws(() => sourceSearchRoots(undefined, snapshot), /not available on this server/);
		await assert.rejects(walkFiles("/materials", () => false, undefined, { policy: snapshot }), /not available on this server/);
		installServerFileReadiness(undefined);
		assert.throws(() => guardSourcePath("/materials/notes.md", snapshot), /not available on this server/);
		installServerFileReadiness(() => { throw new Error("broken mount"); });
		assert.throws(() => guardSourcePath("/materials/notes.md", snapshot), /not available on this server/);
	});

	it("research downloads reopen through their own narrow check, not a supplied policy", () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => false);
		const job = fs.mkdtempSync(path.join(profile, "job-"));
		const file = path.join(job, "document.pdf");
		fs.writeFileSync(file, "%PDF");
		const issued = fs.lstatSync(file);
		assert.equal(resolveIssuedDownload(file, job, issued), file, "works while learner files are unavailable");
		assert.throws(() => resolveIssuedDownload(file, job, { dev: issued.dev, ino: issued.ino + 1 }), /not an issued download/);
		const other = fs.mkdtempSync(path.join(profile, "other-job-"));
		assert.throws(() => resolveIssuedDownload(file, other, issued), /not an issued download/);
		const link = path.join(job, "link.pdf");
		fs.symlinkSync(homeNotes, link);
		assert.throws(() => resolveIssuedDownload(link, job, fs.lstatSync(link)), /not an issued download/);
		const dotenv = path.join(job, ".env");
		fs.writeFileSync(dotenv, "SECRET=1");
		assert.throws(() => resolveIssuedDownload(dotenv, job, fs.lstatSync(dotenv)), /protected location/);
		assert.throws(() => resolveIssuedDownload(job, job, fs.lstatSync(job)), /not an issued download/);
	});

	it("a server without the mount lists no roots", async () => {
		if (fs.existsSync("/materials")) return;
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => true);
		assert.deepEqual(resolvePolicy().folders, []);
		const result = await attempt(lsTool, {});
		assert.equal(result.denied, true);
		assert.match(result.text, /no accessible allowed folders\. On this server the only allowed folder is \/materials, and the server operator must add or repair its mount\./);
		assert.doesNotMatch(result.text, /Settings/);
	});

	it("gates the file tools and local PDFs on the files check", () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(() => false);
		for (const tool of ["read", "ls", "find", "grep", "show_image"]) assert.ok(serverToolBlockReason(tool), tool);
		installServerFileReadiness(() => true);
		for (const tool of ["read", "ls", "find", "grep", "show_image"]) assert.equal(serverToolBlockReason(tool), null, tool);
		assert.ok(serverJobBlockReason("pdf"), "local PDFs also need PDF readiness");
		installServerEgressReadiness(() => true);
		assert.equal(serverJobBlockReason("pdf"), null);
		installServerFileReadiness(() => false);
		assert.ok(serverJobBlockReason("pdf"), "PDF readiness alone does not open local paths");
	});

	it("desktop never consults the materials check", async () => {
		let checks = 0;
		installServerFileReadiness(() => { checks++; return false; });
		const result = await run(readTool, { path: homeNotes });
		assert.match(text(result), /HOME_ONLY_MARKER/);
		assert.equal(isServerCapabilityAvailable("files"), true);
		assert.equal(checks, 0);
	});
});

describe("file tool help text", () => {
	const tools = () => [readTool, lsTool, findTool, grepTool, createShowImageTool({ chatId: "c", chatStore: { saveImageSnapshot: () => {} } })];

	it("on a server names /materials as the only operator-managed root", () => {
		process.env.LH_SERVER_MODE = "tailscale";
		assert.match(SERVER_FILE_TOOLS_HELP, /only file root is \/materials, a read-only folder the server operator manages/);
		assert.match(SERVER_FILE_TOOLS_HELP, /absolute \/materials\/\.\.\. paths/);
		assert.match(SERVER_FILE_TOOLS_HELP, /ls without a path lists \/materials/);
		assert.match(SERVER_FILE_TOOLS_HELP, /settings cannot widen this/);
		for (const tool of tools()) {
			assert.ok(tool.description.includes(SERVER_FILE_TOOLS_HELP), tool.name);
			assert.ok({ ...tool }.description.includes(SERVER_FILE_TOOLS_HELP), `${tool.name} survives registry spreads`);
			assert.doesNotMatch(tool.description.replace(SERVER_FILE_TOOLS_HELP, ""), /File access settings|allowed folder paths when restriction|discover allowed/, tool.name);
		}
	});

	it("on desktop keeps the File access settings guidance and never mentions /materials", () => {
		for (const tool of tools()) {
			assert.doesNotMatch(tool.description, /\/materials|server operator/, tool.name);
		}
		assert.match(readTool.description, /File access settings and protected-location denials apply; use ls without a path to discover allowed folders when restricted\.$/);
		assert.match(lsTool.description, /^List directory contents, or list the allowed folder paths when restriction is enabled/);
		for (const tool of [findTool, grepTool]) assert.match(tool.description, /Use ls without a path to discover allowed roots\./);
		assert.match(tools()[4]!.description, /Local paths follow File access settings; use ls to discover allowed folders\.$/);
	});
});

const live = process.env.LH_TEST_MATERIALS === "1";
// Test-only: the fixture's filesystem path as mountinfo reports it. Production has no override.
const fixtureReadiness = () => materialsReady({ ...liveMaterialsProbe(), expectedSource: process.env.LH_TEST_MATERIALS_SOURCE ?? "" });
describe("live read-only /materials mount", { skip: !live && "set LH_TEST_MATERIALS=1 with tests/fixtures/materials mounted read-only at /materials" }, () => {
	it("the live probe verifies the real mount, and production refuses a fixture source", () => {
		process.env.LH_SERVER_MODE = "tailscale";
		assert.equal(materialsReady(), false, "the fixture is not /var/lib/learnharness-materials");
		assert.equal(isServerCapabilityAvailable("files"), false);
		installServerFileReadiness(fixtureReadiness);
		assert.equal(isServerCapabilityAvailable("files"), true);
	});

	it("tool calls read only inside /materials", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(fixtureReadiness);
		assert.match(text(await run(readTool, { path: "/materials/notes.md" })), /Synthetic materials fixture marker/);
		assert.match(text(await run(lsTool, {})), /\/materials/);
		assert.match(text(await run(lsTool, { path: "/materials" })), /notes\.md/);
		assert.match(text(await run(findTool, { pattern: "*.md" })), /notes\.md/);
		assert.match(text(await run(grepTool, { pattern: "materials fixture" })), /notes\.md/);
		const image = await run(readTool, { path: "/materials/pixel.png" });
		assert.equal(image.content.some((part: { type: string }) => part.type === "image"), true);
		let snapshots = 0;
		const shown = await run(createShowImageTool({ chatId: "c", chatStore: { saveImageSnapshot: () => { snapshots++; } } }), { path: "/materials/pixel.png" });
		assert.notEqual(shown.isError, true);
		assert.equal(snapshots, 1);
		for (const outside of ["/materials/escape.md", homeNotes, "notes.md", "/proc/self/mountinfo", auth, "/etc/hostname"]) {
			assert.equal((await attempt(readTool, { path: outside })).denied, true, outside);
		}
		assert.throws(() => fs.writeFileSync("/materials/new.md", "x"), /EROFS|EACCES/);
	});

	it("local PDFs open only inside /materials", async () => {
		process.env.LH_SERVER_MODE = "tailscale";
		installServerFileReadiness(fixtureReadiness);
		installServerEgressReadiness(() => true);
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Read (p. 1). Pages consulted: 1")]),
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const result = await runPdfReaderAgent({ path: "/materials/sample.pdf", question: "?" }, { engine });
		assert.equal(result.path, "/materials/sample.pdf");
		assert.deepEqual(result.pagesConsulted, [1]);
		const outsidePdf = path.join(home, "outside.pdf");
		fs.copyFileSync("/materials/sample.pdf", outsidePdf);
		const denied = await runPdfReaderAgent({ path: outsidePdf, question: "?" }, { engine: { ...engine, streamFn: (() => { throw new Error("must not call"); }) as typeof faux.streamSimple } });
		assert.match(denied.brief, /^PDF failed: Access denied:/);
	});
});
