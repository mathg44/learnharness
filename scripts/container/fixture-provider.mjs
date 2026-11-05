/** OpenAI-compatible synthetic transport. No outbound requests or real secrets. */
import assert from "node:assert/strict";
import http from "node:http";

http.createServer(async (req, res) => {
	try {
		assert.equal(req.headers.authorization, "Bearer synthetic-container-key");
		if (req.method === "GET" && req.url === "/v1/models") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "fixture-teacher", context_window: 65536, max_output_tokens: 4096 }] }));
			return;
		}
		assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
		let data = "";
		for await (const chunk of req) { data += chunk; assert(data.length < 2_000_000); }
		const body = JSON.parse(data);
		assert.equal(body.model, "fixture-teacher"); assert.equal(body.stream, true);
		const names = new Set(body.tools?.map((tool) => tool.function.name));
		let name, args, text;
		if (names.has("submit_findings")) {
			name = "submit_findings";
			args = { propositions: [{ id: "p1", name: "Mercury orbit", statement: "Mercury orbits closest to the Sun.", aliases: [] }], chains: [] };
		} else if (names.has("submit_review")) {
			name = "submit_review"; args = { links: [] };
		} else if (body.messages.some((message) => message.role === "tool")) {
			text = "Correct. Mercury is closest to the Sun.";
		} else {
			assert(names.has("probe"), "fixture expected a prober");
			name = "probe";
			args = {
				question: "Which planet is closest to the Sun?",
				options: [{ label: "Mercury", value: "mercury" }, { label: "Venus", value: "venus" }],
				explanation: "Mercury has the innermost orbit.", correctAnswer: "mercury",
			};
		}
		res.setHeader("content-type", "text/event-stream");
		const frame = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", model: "fixture-teacher", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
		frame({ role: "assistant", ...(name ? { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: text }) });
		frame({}, name ? "tool_calls" : "stop", { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 });
		res.end("data: [DONE]\n\n");
	} catch {
		// Never echo request headers, bodies, or credentials to diagnostics.
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Unexpected fixture request" } }));
	}
}).listen(3080, "0.0.0.0");
