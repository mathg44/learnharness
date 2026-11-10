/** The backup runtime check's synthetic profile must be valid to the real
 * readers, or the Docker smoke would compare records the app ignores. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it } from "node:test";
import { CHAT_ID, CONTAINER_SCRIPT, CUSTOM_BASE, PROMPT_SEGMENT, SEED_SCRIPT, projection, readRequests, syntheticProfile } from "../scripts/backup/check-fixture.mjs";
import { customBindingMatches, parseCustomAuthBinding } from "../src/core/custom-provider-auth.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseSourceOrganization } from "../src/core/source-organization.ts";
import { danglingQuestionOf, hasUnresolvedQuestion, type LhMessage } from "../src/core/native-messages.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";

const require = createRequire(import.meta.url);
const chatgpt = require("../electron/chatgpt.cjs");
const subscriptions = require("../electron/subscription-store.cjs");

const options = { key: "synthetic-key-0123", bindingId: "0123456789abcdef0123456789abcdef", hostId: "urn:uuid:00000000-0000-4000-8000-000000000001" };
const profile = syntheticProfile(options);
const file = (root: string, relative: string) => {
	const entry = profile.files.find(([r, p]) => r === root && p === relative);
	assert.ok(entry, `${root}/${relative} is seeded`);
	return entry[2];
};

it("settings and auth.json carry one matching custom endpoint binding", () => {
	const settings = sanitizeUserSettings(JSON.parse(file("data", "settings.json")));
	const auth = JSON.parse(file("auth", "auth.json"));
	const binding = parseCustomAuthBinding(auth.__learnharness_custom_provider_binding);
	assert.equal(settings?.customProvider?.baseUrl, CUSTOM_BASE);
	assert.equal(customBindingMatches(settings?.customProvider, binding), true);
	assert.equal(binding?.fileKeyBaseUrl, CUSTOM_BASE);
	assert.equal(auth.CUSTOM_OPENAI_API_KEY, options.key);
	assert.equal(settings?.agent?.prompts?.[PROMPT_SEGMENT], true);
	assert.equal(isValidSegmentPath(PROMPT_SEGMENT), true);
});

it("the chat holds a pending question, processed attachments and a hashed snapshot", () => {
	const chat = JSON.parse(file("data", `chats/${CHAT_ID}.json`));
	const messages = chat.messages as LhMessage[];
	assert.equal(danglingQuestionOf(messages)?.tool, "ask_user_question");
	assert.equal(hasUnresolvedQuestion(messages), true);
	const snapshot = chat.imageSnapshots[profile.snapshotId];
	assert.equal(createHash("sha256").update(Buffer.from(snapshot.data, "base64")).digest("hex"), profile.snapshotId);
	assert.deepEqual(Object.values(chat.attachments).map((a) => (a as { kind: string }).kind).sort(), ["image", "pdf", "text"]);
	const job = JSON.parse(file("data", "jobs/job_backupcheck_0001.json"));
	assert.deepEqual(job.delivery, { kind: "result", status: "pending" });
	assert.ok(messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === job.toolCallId)));
});

it("source organization and credential sidecars pass their validators", () => {
	assert.doesNotThrow(() => parseSourceOrganization(JSON.parse(file("data", "graph/source-organization.json"))));
	assert.doesNotThrow(() => chatgpt.validateState(JSON.parse(file("auth", "chatgpt-credentials.json"))));
	for (const provider of ["github-copilot", "xai"]) {
		assert.doesNotThrow(() => subscriptions.validateState(provider, JSON.parse(file("auth", `${provider}-credentials.json`))));
	}
});

it("seeds empty roots privately, refuses a used root, and inventories without contents", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-seed-"));
	try {
		const data = path.join(root, "data"), auth = path.join(root, "auth");
		fs.mkdirSync(data); fs.mkdirSync(auth);
		const input = JSON.stringify(profile.files);
		assert.equal(execFileSync(process.execPath, ["-e", SEED_SCRIPT, data, auth], { input }).length, 0);
		assert.equal(fs.readFileSync(path.join(auth, "auth.json"), "utf8"), file("auth", "auth.json"));
		assert.equal(fs.statSync(path.join(data, "settings.json")).mode & 0o777, 0o600);
		assert.throws(() => execFileSync(process.execPath, ["-e", SEED_SCRIPT, data, auth], { input, stdio: ["pipe", "pipe", "ignore"] }));
		assert.match(CONTAINER_SCRIPT, /visit\("\/data", "data"\)/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("projections ignore etags and hash binary bodies", () => {
	const requests = readRequests(profile.snapshotId);
	const result = (name: string, body: Buffer, etag: string) => ({ name, status: 200, contentType: "application/json; charset=utf-8", etag, body: body.toString("base64") });
	const json = Buffer.from(JSON.stringify({ settings: { version: 1 } }));
	const image = Buffer.from([1, 2, 3]);
	type Projection = Record<string, { status: number; body: unknown }>;
	const a = projection([result("settings", json, '"a"'), result("attachment-image", image, "")], requests) as Projection;
	const b = projection([result("settings", json, '"b"'), result("attachment-image", image, "")], requests) as Projection;
	assert.deepEqual(a, b);
	assert.deepEqual(a["attachment-image"]!.body, { sha256: createHash("sha256").update(image).digest("hex"), size: 3 });
	assert.deepEqual(a.settings!.body, { settings: { version: 1 } });
});
