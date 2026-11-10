// Invoked only by the host operator through docker exec. stdout is private data.
import net from "node:net";
import { once } from "node:events";
const socket = net.connect("/tmp/learnharness-backup/control.sock");
socket.setTimeout(60_000, () => socket.destroy(new Error("timeout")));
let prefix = Buffer.alloc(0);
try {
	for await (const chunk of socket) {
		if (prefix.length < 2) {
			prefix = Buffer.concat([prefix, chunk]);
			if (prefix.length < 2) continue;
			if (prefix[0] !== 0x1f || prefix[1] !== 0x8b) throw new Error("invalid archive");
			if (!process.stdout.write(prefix)) await once(process.stdout, "drain");
		} else if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
	}
	if (prefix.length < 2) throw new Error("empty capture");
} catch {
	socket.destroy();
	console.error("Backup capture is unavailable or incomplete.");
	process.exitCode = 1;
}
