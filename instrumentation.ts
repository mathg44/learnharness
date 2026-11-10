export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs" && process.env.LH_SERVER_MODE === "tailscale") {
		const { registerServerBackup } = await import("./src/server/backup.ts");
		await registerServerBackup();
	}
}
