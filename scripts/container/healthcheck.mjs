/** Local HTTP liveness only. No providers, credentials, or persistent writes. */
try {
	const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/settings`, {
		signal: AbortSignal.timeout(4000),
	});
	if (!response.ok || !("settings" in await response.json())) process.exitCode = 1;
} catch {
	process.exitCode = 1;
}
