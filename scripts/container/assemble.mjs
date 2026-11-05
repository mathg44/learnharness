/** Assemble web standalone assets without the desktop payload curation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".next/standalone");
for (const name of fs.readdirSync(root)) {
	assert(!/^(data|auth\.json|.*-credentials\.json.*|\.env.*|\.git|\.pi|tests)$/.test(name), "Private state or test records in standalone payload");
}
for (const asset of ["server.js", "src/agent/system-prompt.md", "src/agent/prompts/teacher/20-teaching.md", "src/agent/subagents/headless.ts", "src/agent/subagents/pdf-ops.ts"]) {
	assert(fs.existsSync(path.join(root, asset)), `Missing runtime asset: ${asset}`);
}
fs.cpSync("public", path.join(root, "public"), { recursive: true });
fs.cpSync(".next/static", path.join(root, ".next/static"), { recursive: true });
fs.mkdirSync(path.join(root, ".next/cache"), { recursive: true });
console.log("Web standalone assets assembled; no learner profile included.");
