/** Install the process-wide readiness check for the offline browser worker.
 * Instrumentation awaits the initial probe before the app can recover jobs;
 * importing the server entry point also wires it for direct/test consumers. */
import { startServerDemoReadiness } from "../agent/server-demo.ts";
import { isServerMode } from "../core/server-capabilities.ts";

export async function registerServerDemo(): Promise<void> {
	await startServerDemoReadiness();
}

if (isServerMode()) {
	void registerServerDemo().catch(() => console.error("Demo worker readiness could not be initialized."));
}
