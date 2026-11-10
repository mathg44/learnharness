/** Web credential writes share the data stores' synchronous write discipline.
 * An online backup can therefore copy both stores in one event-loop stretch.
 * Desktop continues to use its existing asynchronous credential stores.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { fileStore as chatGPTFileStore, validateState as validateChatGPT } from "../../electron/chatgpt.cjs";
import { fileStore as nativeFileStore, validateState as validateNative } from "../../electron/subscription-store.cjs";

export function webCredentialFiles(directory: string) {
	function synchronousWrite(file: string, validate: (state: unknown) => unknown) {
		return async (state: unknown) => {
			try {
				validate(state);
				fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				writeFileAtomicSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
				if (process.platform !== "win32") {
					const fd = fs.openSync(path.dirname(file), "r");
					try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
				}
			} catch { throw Object.assign(new Error("storage"), { code: "storage" }); }
		};
	}
	const chatGPTFile = path.join(directory, "chatgpt-credentials.json");
	const native = (provider: string) => {
		const file = path.join(directory, `${provider}-credentials.json`);
		return { ...nativeFileStore(file, provider), write: synchronousWrite(file, (state) => validateNative(provider, state)) };
	};
	return {
		chatgpt: { ...chatGPTFileStore(chatGPTFile), write: synchronousWrite(chatGPTFile, validateChatGPT) },
		native: { "github-copilot": native("github-copilot"), xai: native("xai") },
	};
}
