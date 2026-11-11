// Container healthcheck: healthy only when the controller reports a passed
// sandbox self-test over its socket.
import * as http from "node:http";

const SOCKET_PATH = "/run/learnharness-demo/demo.sock";

const req = http.get({ socketPath: SOCKET_PATH, path: "/health", timeout: 4000 }, (res) => {
	res.resume();
	process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
