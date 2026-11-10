"use strict";
// This runs in the app's single event loop. Do not make capture asynchronous:
// all persistent web-profile writers must finish in that same event loop.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = () => new Error("Backup profile is incomplete or invalid.");

function inventory(directory) {
	const files = [];
	function visit(relative) {
		const absolute = path.join(directory, relative);
		const stat = fs.lstatSync(absolute);
		if (stat.isSymbolicLink()) throw failure();
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
		} else if (stat.isFile()) {
			const bytes = fs.readFileSync(absolute);
			files.push({ path: relative.split(path.sep).join("/"), size: bytes.length, sha256: digest(bytes) });
		} else throw failure();
	}
	for (const name of ["auth", "data"]) {
		if (!fs.lstatSync(path.join(directory, name)).isDirectory()) throw failure();
		visit(name);
	}
	return files;
}

function captureProfile({ dataDirectory, authDirectory, destination }) {
	const roots = [dataDirectory, authDirectory];
	const target = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
	for (const root of roots) {
		if (!fs.lstatSync(root).isDirectory()) throw failure();
		const canonical = fs.realpathSync(root);
		const relative = path.relative(canonical, target);
		if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw failure();
	}
	fs.mkdirSync(destination, { mode: 0o700 });
	try {
		function copy(source, target) {
			const stat = fs.lstatSync(source);
			if (stat.isSymbolicLink()) throw failure();
			if (stat.isDirectory()) {
				fs.mkdirSync(target, { mode: 0o700 });
				for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name), path.join(target, name));
			} else if (stat.isFile()) {
				fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
				fs.chmodSync(target, 0o600);
			} else throw failure();
		}
		copy(dataDirectory, path.join(destination, "data"));
		copy(authDirectory, path.join(destination, "auth"));
		const manifest = { version: 1, createdAt: new Date().toISOString(), files: inventory(destination) };
		fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
		return manifest;
	} catch {
		fs.rmSync(destination, { recursive: true, force: true });
		throw failure();
	}
}

function verifyProfile(directory) {
	try {
		if (fs.lstatSync(directory).isSymbolicLink()) throw failure();
		if (fs.readdirSync(directory).sort().join(",") !== "auth,data,manifest.json") throw failure();
		const manifestPath = path.join(directory, "manifest.json");
		if (!fs.lstatSync(manifestPath).isFile()) throw failure();
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		if (manifest.version !== 1 || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files)) throw failure();
		if (JSON.stringify(manifest.files) !== JSON.stringify(inventory(directory))) throw failure();
		return manifest;
	} catch { throw failure(); }
}
module.exports = { captureProfile, verifyProfile };
