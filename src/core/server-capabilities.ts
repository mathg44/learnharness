/**
 * Server capability readiness. Outside server mode (LH_SERVER_MODE unset)
 * nothing here restricts anything: desktop and local development keep every
 * tool. Whenever LH_SERVER_MODE is set at all, including to an invalid value
 * that the access gate already refuses, each capability below is available
 * only once its `ready()` check returns true.
 *
 * Every check returns false until its restoration issue lands the required
 * protections. That PR changes the check (for example, to verify the egress
 * rules or learner-root mounts it depends on). Browser settings and session
 * toggles cannot widen this: registries filter after the settings filter.
 */
export type ServerCapability = "files" | "research" | "pdf" | "demo" | "visual";

interface CapabilityDefinition {
	/** Model-facing tool names this capability owns. */
	tools: readonly string[];
	/** Background job kinds this capability owns. */
	jobKinds: readonly string[];
	/** True only when every protection the capability needs is present. */
	ready: () => boolean;
}

export const SERVER_CAPABILITIES: Readonly<Record<ServerCapability, CapabilityDefinition>> = {
	// #22: learner-root policy and narrowly scoped mounts.
	files: { tools: ["read", "ls", "find", "grep", "show_image"], jobKinds: [], ready: () => false },
	// #23: public-only destination enforcement; #27: container egress.
	research: { tools: ["research", "web_search", "web_fetch"], jobKinds: ["research"], ready: () => false },
	// #24: public fetch for remote PDFs, app-owned download storage.
	pdf: {
		tools: ["pdf", "web_fetch_pdf", "pdf_info", "pdf_extract", "pdf_search", "pdf_render"],
		jobKinds: ["pdf"],
		ready: () => false,
	},
	// #25: isolated generated-code browser runtime.
	demo: { tools: ["demo"], jobKinds: ["demo"], ready: () => false },
	// #26: native rendering under the learner-file boundary.
	visual: { tools: ["visual"], jobKinds: ["visual"], ready: () => false },
};

const TOOL_CAPABILITY = new Map<string, ServerCapability>();
const JOB_CAPABILITY = new Map<string, ServerCapability>();
for (const [name, definition] of Object.entries(SERVER_CAPABILITIES) as [ServerCapability, CapabilityDefinition][]) {
	for (const tool of definition.tools) TOOL_CAPABILITY.set(tool, name);
	for (const kind of definition.jobKinds) JOB_CAPABILITY.set(kind, name);
}

/** Any value, even empty or unrecognized, restricts capabilities. */
export function isServerMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_SERVER_MODE !== undefined;
}

export function isServerCapabilityAvailable(capability: ServerCapability): boolean {
	return !isServerMode() || SERVER_CAPABILITIES[capability].ready();
}

export function serverToolBlockReason(toolName: string): string | null {
	const capability = TOOL_CAPABILITY.get(toolName);
	if (!capability || isServerCapabilityAvailable(capability)) return null;
	return `The "${toolName}" tool is not available on this server.`;
}

export function serverJobBlockReason(kind: string): string | null {
	const capability = JOB_CAPABILITY.get(kind);
	if (!capability || isServerCapabilityAvailable(capability)) return null;
	return `The "${kind}" job is not available on this server.`;
}

/** Remove unavailable declarations too, so agents do not plan around them. */
export function filterServerTools<T>(tools: Record<string, T>): Record<string, T> {
	if (!isServerMode()) return tools;
	return Object.fromEntries(Object.entries(tools).filter(([name]) => serverToolBlockReason(name) === null));
}
