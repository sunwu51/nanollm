import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { encodeReasoningCarrier } from "../src/converters/shared.js";
import { normalizeOpenAIResponsesRequest } from "../src/converters/requests.js";
import { forwardRequest, forwardStreamRequest, passthroughRequest } from "../src/proxy/proxy.js";
import { isThinkingBindingError, stripThinkingBlocks } from "../src/proxy/thinking-binding.js";

type Json = Record<string, any>;

const SIGNATURE = `${"A".repeat(120)}=`;
const BINDING_ERROR = { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\"." } };

const hasThinking = (body: Json) => (body.messages ?? []).some((message: Json) => Array.isArray(message.content) && message.content.some((block: Json) => block.type === "thinking" || block.type === "redacted_thinking"));

/** An upstream that rejects thinking as bound to another conversation, or fails with another 400 when asked to. */
async function withUpstream(fn: (baseURL: string, requests: Json[]) => Promise<void>, rejectWith: Json = BINDING_ERROR) {
  const requests: Json[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (hasThinking(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rejectWith));
      return;
    }
    const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const config = (baseURL: string) => ({ name: "claude", provider: "anthropic" as const, base_url: baseURL, api_key: "k", model: "claude-test" });

/** A Responses client's history: a signed Claude thinking block (kept in a carrier) before a tool call. */
const convertedRequest = () => normalizeOpenAIResponsesRequest({
  model: "claude",
  tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
  input: [
    { role: "user", content: "q" },
    { type: "reasoning", summary: [], encrypted_content: encodeReasoningCarrier("", SIGNATURE) },
    { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ],
} as any);

const blockTypes = (body: Json) => body.messages.map((message: Json) => typeof message.content === "string" ? "string" : message.content.map((block: Json) => block.type));

test("a converted request rejected for its thinking binding is retried once without thinking", async () => {
  await withUpstream(async (baseURL, requests) => {
    const { normalizedResponse } = await forwardRequest(config(baseURL), convertedRequest());
    assert.equal(requests.length, 2);
    assert.deepEqual(blockTypes(requests[0]), ["string", ["thinking", "tool_use"], ["tool_result"]]);
    assert.deepEqual(blockTypes(requests[1]), ["string", ["tool_use"], ["tool_result"]]);
    assert.equal(normalizedResponse.message.parts[0].type, "text");
  });
});

test("a converted stream rejected for its thinking binding is retried once without thinking", async () => {
  await withUpstream(async (baseURL, requests) => {
    const { body } = await forwardStreamRequest(config(baseURL), convertedRequest());
    const text = await new Response(body).text();
    assert.equal(requests.length, 2);
    assert.equal(hasThinking(requests[1]), false);
    assert.match(text, /message_stop/);
  });
});

test("a same-format request keeps its own error: only history nanollm rewrote is retried", async () => {
  const history = (assistant: Json[]) => ({ model: "claude", max_tokens: 100, messages: [{ role: "user", content: "q" }, { role: "assistant", content: assistant }, { role: "user", content: "next" }] });
  const thinking = { type: "thinking", thinking: "", signature: SIGNATURE };

  await withUpstream(async (baseURL, requests) => {
    await assert.rejects(passthroughRequest(config(baseURL), history([thinking, { type: "text", text: "answer" }])), (error: any) => error.status === 400);
    assert.equal(requests.length, 1);
  });

  await withUpstream(async (baseURL, requests) => {
    const synthesized = [
      thinking,
      { type: "server_tool_use", id: "srvtoolu_nanollm_ws_1", name: "web_search", input: { query: "nobel" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_nanollm_ws_1", content: [{ type: "web_search_result", url: "https://kva.se", title: "KVA", encrypted_content: "nanollm.websearch.v1", page_age: null }] },
      { type: "text", text: "answer" },
    ];
    await passthroughRequest(config(baseURL), history(synthesized));
    assert.equal(requests.length, 2);
    // The synthesized search was degraded to a note, and the thinking before it was dropped.
    assert.deepEqual(blockTypes(requests[1]), ["string", ["text", "text"], "string"]);
    assert.match(requests[1].messages[1].content[0].text, /^\[web_search\] query: nobel/);
  });
});

test("other upstream errors are not retried", async () => {
  await withUpstream(async (baseURL, requests) => {
    await assert.rejects(forwardRequest(config(baseURL), convertedRequest()), (error: any) => error.status === 400);
    assert.equal(requests.length, 1);
  }, { type: "error", error: { type: "invalid_request_error", message: "messages: roles must alternate" } });
});

test("stripThinkingBlocks removes thinking and redacted thinking and leaves everything else", () => {
  assert.equal(stripThinkingBlocks({ messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }] }), undefined);
  assert.equal(stripThinkingBlocks({ messages: [{ role: "user", content: "q" }] }), undefined);
  assert.deepEqual(stripThinkingBlocks({
    system: "s",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "tool_use", id: "t", name: "f", input: {} }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "d" }] },
    ],
  }), {
    system: "s",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] },
    ],
  });
  assert.equal(isThinkingBindingError(Object.assign(new Error("x"), { status: 400, upstream: JSON.stringify(BINDING_ERROR) })), true);
  assert.equal(isThinkingBindingError(Object.assign(new Error("x"), { status: 500, upstream: JSON.stringify(BINDING_ERROR) })), false);
  assert.equal(isThinkingBindingError(new Error("bound to a different conversation")), false);
});
