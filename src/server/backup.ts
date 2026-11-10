/** Host-admin capture only. No HTTP route, model tool, scheduler or stop/start. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { captureProfile } from "../../scripts/backup/profile.cjs";
import { AUTH_FILE, BACKUP_STAGING_DIR, PATHS } from "../../config.ts";

export async function startBackupCapture(options: { dataDirectory: string; authDirectory: string; directory: string }) {
	const { directory } = options;
	fs.mkdirSync(directory, { mode: 0o700 });
	const socketPath = path.join(directory, "control.sock");
	let active = false;
	const server = net.createServer((socket) => {
		if (active) { socket.destroy(); return; }
		active = true;
		const destination = path.join(directory, `capture-${randomUUID()}`);
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			try { fs.rmSync(destination, { recursive: true, force: true }); }
			catch { console.error("Backup temporary-copy cleanup failed."); }
			active = false;
		};
		socket.on("error", () => {});
		try {
			// No await, worker or subprocess until this copy is complete. Web
			// credential writes and all data-store mutations are synchronous,
			// so both trees represent the same event-loop boundary.
			captureProfile({ ...options, destination });
			const archive = spawn("tar", ["-czf", "-", "-C", destination, "data", "auth", "manifest.json"], { stdio: ["ignore", "pipe", "ignore"] });
			archive.stdout.pipe(socket, { end: false });
			const timer = setTimeout(() => { archive.kill(); socket.destroy(); }, 60_000);
			socket.once("close", () => archive.kill());
			archive.once("error", () => { clearTimeout(timer); cleanup(); socket.destroy(); });
			archive.once("close", (code) => {
				clearTimeout(timer); cleanup();
				if (code === 0) socket.end(); else socket.destroy();
			});
		} catch {
			cleanup(); socket.destroy();
			console.error("Backup capture failed. No snapshot was published.");
		}
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
		fs.chmodSync(socketPath, 0o600);
	} catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
	const removePrivateDirectory = () => {
		try { fs.rmSync(directory, { recursive: true, force: true }); }
		catch { console.error("Backup temporary-copy cleanup failed."); }
	};
	process.once("exit", removePrivateDirectory);
	return { close: () => new Promise<void>((resolve, reject) => server.close((error) => {
		process.removeListener("exit", removePrivateDirectory);
		removePrivateDirectory();
		if (error) reject(error); else resolve();
	})) };
}

const key = Symbol.for("learnharness.backup-capture");
export async function registerServerBackup() {
	if (process.env.LH_SERVER_MODE !== "tailscale") return;
	const state = globalThis as typeof globalThis & { [key]?: ReturnType<typeof startBackupCapture> };
	await (state[key] ??= startBackupCapture({ dataDirectory: PATHS.data, authDirectory: path.dirname(AUTH_FILE), directory: BACKUP_STAGING_DIR }));
}
