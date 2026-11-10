import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it } from "node:test";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { startBackupCapture } from "../src/server/backup.ts";
import { isSensitivePath, resolveSourcePath } from "../src/agent/tools/fs-shared.ts";
import { webCredentialFiles } from "../src/server/credential-files.ts";
const require = createRequire(import.meta.url);
const { captureProfile, verifyProfile } = require("../scripts/backup/profile.cjs");

it("refuses profile roots that are files or overlap the destination", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-roots-"));
	try {
		const data = path.join(root, "data"), auth = path.join(root, "auth");
		fs.mkdirSync(data); fs.writeFileSync(auth, "{}");
		assert.throws(() => captureProfile({ dataDirectory: data, authDirectory: auth, destination: path.join(root, "copy") }), /incomplete or invalid/);
		fs.rmSync(auth); fs.mkdirSync(auth);
		assert.throws(() => captureProfile({ dataDirectory: data, authDirectory: auth, destination: path.join(data, "copy") }), /incomplete or invalid/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("does not expose temporary recovery material to learner file tools", () => {
	assert.equal(isSensitivePath("/tmp/learnharness-backup/capture-one/auth/auth.json"), true);
	assert.throws(() => resolveSourcePath("/tmp/learnharness-backup/capture-one/data/chats/chat.json"), /Access denied/);
});

it("credential changes are complete at the same synchronous capture boundary", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-credentials-"));
	try {
		const data = path.join(root, "data"), auth = path.join(root, "auth");
		fs.mkdirSync(data); fs.mkdirSync(auth);
		const files = webCredentialFiles(auth);
		// Do not await either write. A capture at this boundary must see complete
		// credentials, not the partial files created by asynchronous IO.
		const chatgpt = files.chatgpt.write({ version: 1, hostId: "synthetic", activeId: null, registrations: [] });
		const xai = files.native.xai.write({ version: 1, allowBackgroundUse: false });
		const copy = path.join(root, "copy");
		captureProfile({ dataDirectory: data, authDirectory: auth, destination: copy });
		verifyProfile(copy);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy, "auth/xai-credentials.json"), "utf8")), { version: 1, allowBackgroundUse: false });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy, "auth/chatgpt-credentials.json"), "utf8")), { version: 1, hostId: "synthetic", activeId: null, registrations: [] });
		await Promise.all([chatgpt, xai]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("preserves safe credential-storage errors when the destination cannot be written", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-storage-error-"));
	try {
		const blocked = path.join(root, "blocked"); fs.writeFileSync(blocked, "not a directory");
		await assert.rejects(webCredentialFiles(blocked).chatgpt.write({ version: 1, hostId: "synthetic", activeId: null, registrations: [] }), (error: unknown) => {
			assert.equal((error as { code: string }).code, "storage");
			assert.equal((error as Error).message, "storage");
			return true;
		});
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("refuses incomplete, corrupt and linked recovery copies", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-invalid-"));
	try {
		const data = path.join(root, "live-data"), auth = path.join(root, "live-auth");
		fs.mkdirSync(data); fs.mkdirSync(auth); fs.writeFileSync(path.join(data, "settings.json"), "{}");
		for (const change of [
			(copy: string) => fs.unlinkSync(path.join(copy, "data/settings.json")),
			(copy: string) => fs.writeFileSync(path.join(copy, "data/settings.json"), "corrupt"),
			(copy: string) => fs.writeFileSync(path.join(copy, "data/extra.json"), "unlisted"),
			(copy: string) => { fs.rmSync(path.join(copy, "data"), { recursive: true }); fs.symlinkSync(data, path.join(copy, "data")); },
			(copy: string) => fs.writeFileSync(path.join(copy, "manifest.json"), "{"),
		]) {
			const copy = path.join(root, `copy-${fs.readdirSync(root).length}`);
			captureProfile({ dataDirectory: data, authDirectory: auth, destination: copy });
			change(copy);
			assert.throws(() => verifyProfile(copy), /incomplete or invalid/);
		}
		fs.symlinkSync(path.join(data, "settings.json"), path.join(auth, "secret-link"));
		const destination = path.join(root, "refused");
		assert.throws(() => captureProfile({ dataDirectory: data, authDirectory: auth, destination }), /incomplete or invalid/);
		assert.equal(fs.existsSync(destination), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("exports a consistent copy through a local socket while the server keeps running", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-socket-"));
	const data = path.join(root, "data"), auth = path.join(root, "auth"), directory = path.join(root, "private");
	fs.mkdirSync(data); fs.mkdirSync(auth); fs.writeFileSync(path.join(data, "settings.json"), '{"version":1}');
	const server = await startBackupCapture({ dataDirectory: data, authDirectory: auth, directory });
	try {
		const archive: Buffer[] = [];
		const socket = net.connect(path.join(directory, "control.sock"));
		for await (const chunk of socket) archive.push(chunk as Buffer);
		const restored = path.join(root, "read-copy"); fs.mkdirSync(restored);
		execFileSync("tar", ["-xzf", "-", "-C", restored], { input: Buffer.concat(archive) });
		verifyProfile(restored);
		assert.equal(fs.readFileSync(path.join(restored, "data/settings.json"), "utf8"), '{"version":1}');
		assert.equal(fs.statSync(path.join(directory, "control.sock")).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(directory), ["control.sock"]);
		fs.writeFileSync(path.join(data, "settings.json"), '{"version":1,"changed":true}');
		assert.equal(fs.readFileSync(path.join(restored, "data/settings.json"), "utf8"), '{"version":1}');
	} finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("does not mix files from concurrent synchronous profile mutations", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-writers-"));
	const data = path.join(root, "data"), auth = path.join(root, "auth"), directory = path.join(root, "private");
	fs.mkdirSync(data); fs.mkdirSync(auth);
	let revision = 0;
	const mutate = () => {
		const binding = String(revision++);
		fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ credentialBindingId: binding }));
		fs.writeFileSync(path.join(auth, "auth.json"), JSON.stringify({ id: binding }));
	};
	mutate();
	const server = await startBackupCapture({ dataDirectory: data, authDirectory: auth, directory });
	const writer = setInterval(mutate, 1);
	try {
		for (let n = 0; n < 4; n++) {
			const archive: Buffer[] = [];
			for await (const chunk of net.connect(path.join(directory, "control.sock"))) archive.push(chunk as Buffer);
			const copy = path.join(root, `copy-${n}`); fs.mkdirSync(copy);
			execFileSync("tar", ["-xzf", "-", "-C", copy], { input: Buffer.concat(archive) });
			verifyProfile(copy);
			const settings = JSON.parse(fs.readFileSync(path.join(copy, "data/settings.json"), "utf8"));
			const credentials = JSON.parse(fs.readFileSync(path.join(copy, "auth/auth.json"), "utf8"));
			assert.equal(settings.credentialBindingId, credentials.id, "the provider binding and credential must be from one capture boundary");
		}
		assert.ok(revision > 1, "the writers ran while backups were streamed");
	} finally { clearInterval(writer); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("failed captures release the hold and allow the next backup", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-retry-"));
	const data = path.join(root, "data"), auth = path.join(root, "auth"), directory = path.join(root, "private");
	fs.mkdirSync(data); fs.mkdirSync(auth);
	fs.symlinkSync(data, path.join(auth, "bad-link"));
	const server = await startBackupCapture({ dataDirectory: data, authDirectory: auth, directory });
	try {
		const refused: Buffer[] = [];
		for await (const chunk of net.connect(path.join(directory, "control.sock"))) refused.push(chunk as Buffer);
		assert.equal(Buffer.concat(refused).length, 0);
		assert.deepEqual(fs.readdirSync(directory), ["control.sock"]);
		fs.unlinkSync(path.join(auth, "bad-link"));
		const accepted: Buffer[] = [];
		for await (const chunk of net.connect(path.join(directory, "control.sock"))) accepted.push(chunk as Buffer);
		assert.equal(Buffer.concat(accepted).subarray(0, 2).toString("hex"), "1f8b");
	} finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("captures a private recovery copy of both stores without changing the originals", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-test-"));
	try {
		const data = path.join(root, "live-data"), auth = path.join(root, "live-auth"), copy = path.join(root, "copy");
		fs.mkdirSync(path.join(data, "chats"), { recursive: true }); fs.mkdirSync(auth);
		fs.writeFileSync(path.join(data, "chats", "chat.json"), '{"title":"Synthetic lesson","attachments":{"one":"processed"}}\n');
		fs.writeFileSync(path.join(auth, "auth.json"), '{"SYNTHETIC_KEY":"not-a-real-key"}\n');
		captureProfile({ dataDirectory: data, authDirectory: auth, destination: copy });
		const manifest = verifyProfile(copy);
		assert.deepEqual(manifest.files.map((f: { path: string }) => f.path), ["auth/auth.json", "data/chats/chat.json"]);
		assert.equal(fs.readFileSync(path.join(copy, "data/chats/chat.json"), "utf8"), '{"title":"Synthetic lesson","attachments":{"one":"processed"}}\n');
		assert.equal(fs.statSync(copy).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(copy, "auth/auth.json")).mode & 0o777, 0o600);
		fs.writeFileSync(path.join(copy, "auth/auth.json"), "changed copy");
		assert.equal(fs.readFileSync(path.join(auth, "auth.json"), "utf8"), '{"SYNTHETIC_KEY":"not-a-real-key"}\n');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
