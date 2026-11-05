/** Host-controlled trial restrictions. Browser and session settings cannot override them. */
export function isServerTrialEnabled(): boolean {
	return process.env.LH_SERVER_TRIAL === "1";
}

export const SERVER_TRIAL_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
	"read", "ls", "find", "grep", "show_image",
	"research", "demo", "visual", "pdf",
	"web_search", "web_fetch", "web_fetch_pdf",
	"pdf_info", "pdf_extract", "pdf_search", "pdf_render",
]);

export const SERVER_TRIAL_BLOCKED_JOB_KINDS: ReadonlySet<string> = new Set([
	"research", "demo", "visual", "pdf",
]);

export function serverTrialToolBlockReason(toolName: string): string | null {
	if (!isServerTrialEnabled() || !SERVER_TRIAL_BLOCKED_TOOLS.has(toolName)) return null;
	return `The "${toolName}" tool is disabled in this server trial.`;
}

export function serverTrialJobBlockReason(kind: string): string | null {
	if (!isServerTrialEnabled() || !SERVER_TRIAL_BLOCKED_JOB_KINDS.has(kind)) return null;
	return `The "${kind}" job is disabled in this server trial.`;
}

/** Remove disabled declarations too, so agents do not plan around unavailable tools. */
export function filterServerTrialTools<T>(tools: Record<string, T>): Record<string, T> {
	if (!isServerTrialEnabled()) return tools;
	return Object.fromEntries(Object.entries(tools).filter(([name]) => !SERVER_TRIAL_BLOCKED_TOOLS.has(name)));
}
