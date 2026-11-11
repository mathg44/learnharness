export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs" && process.env.LH_SERVER_MODE === "tailscale") {
		const { registerServerDemo } = await import("./src/server/demo.ts");
		await registerServerDemo();
		const { registerServerBackup } = await import("./src/server/backup.ts");
		await registerServerBackup();
	}
}
