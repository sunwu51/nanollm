import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createSSEConverter } from "../src/converters/index.js";
import { normalizeOpenAIResponsesRequest } from "../src/converters/requests.js";
import { SSEParser } from "../src/converters/streams.js";
import { forwardRequest, forwardStreamRequest } from "../src/proxy/proxy.js";
import { continuePausedAnthropicStream, mergePausedResponses, sumUsage } from "../src/proxy/pause-turn.js";

type Json = Record<string, any>;

const SEARCH_CALL = { type: "server_tool_use", id: "srvtoolu_01abc", name: "web_search", input: { query: "nobel 2026" } };
const SEARCH_RESULT = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_01abc",
  content: [{ type: "web_search_result", url: "https://nobelprize.org/2026", title: "Nobel 2026", encrypted_content: "ENC_A", page_age: null }],
};

/** Rounds the mock upstream answers in order; each is a full message, or an SSE stream when the request asks for one. */
function mockRounds(rounds: Json[][], usage = { input_tokens: 10, output_tokens: 4 }, pauseLast = false) {
  const requests: Json[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const round = requests.length - 1;
    const content = rounds[round];
    const last = round === rounds.length - 1 && !pauseLast;
    const message = { id: `msg_${round}`, type: "message", role: "assistant", model: "m", content, stop_reason: last ? "end_turn" : "pause_turn", stop_sequence: null, usage };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: Json) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
    content.forEach((block, index) => {
      if (block.type === "text") {
        send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else if (block.type === "server_tool_use") {
        send({ type: "content_block_start", index, content_block: { ...block, input: {} } });
        send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        send({ type: "content_block_start", index, content_block: block });
      }
      send({ type: "content_block_stop", index });
    });
    send({ type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: { output_tokens: usage.output_tokens } });
    send({ type: "message_stop" });
    res.end();
  });
  return { server, requests };
}

async function withMock(rounds: Json[][], fn: (baseURL: string, requests: Json[]) => Promise<void>, pauseLast = false) {
  const { server, requests } = mockRounds(rounds, undefined, pauseLast);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const config = (baseURL: string) => ({ name: "claude", provider: "anthropic" as const, base_url: baseURL, api_key: "k", model: "m" });
const request = () => normalizeOpenAIResponsesRequest({ model: "claude", input: "Who won?", tools: [{ type: "web_search" }] } as any);

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function sseEvents(text: string): Json[] {
  const parser = new SSEParser();
  return [...parser.push(text), ...parser.flush()].map((event) => JSON.parse(event.data));
}

test("a paused turn is resumed and returned as one response with summed usage", async () => {
  await withMock([[SEARCH_CALL], [SEARCH_RESULT, { type: "text", text: "Halzen won." }]], async (baseURL, requests) => {
    const { normalizedResponse, usage } = await forwardRequest(config(baseURL), request());

    // The second round carries the paused content back as the trailing assistant message, unchanged.
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.at(-1), { role: "assistant", content: [SEARCH_CALL] });
    assert.deepEqual(requests[1].messages.slice(0, -1), requests[0].messages);

    const parts = normalizedResponse.message.parts;
    assert.deepEqual(parts.map((part) => part.type), ["web_search", "text"]);
    const search = parts[0] as Json;
    assert.equal(search.status, "completed");
    assert.deepEqual(search.sources.map((source: Json) => source.url), ["https://nobelprize.org/2026"]);
    assert.equal(normalizedResponse.finishReason, "end_turn");
    assert.equal(usage?.outputTokens, 8);
  });
});

test("a turn that pauses again is resumed again with everything so far, up to the limit", async () => {
  const rounds = [[SEARCH_CALL], [SEARCH_RESULT], [{ type: "text", text: "Done." }]];
  await withMock(rounds, async (baseURL, requests) => {
    const { normalizedResponse } = await forwardRequest(config(baseURL), request());
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].messages.at(-1).content, [SEARCH_CALL, SEARCH_RESULT]);
    assert.deepEqual(normalizedResponse.message.parts.map((part) => part.type), ["web_search", "text"]);
  });

  // An upstream that never stops pausing ends after the limit and returns what it has.
  const endless = Array.from({ length: 8 }, () => [{ type: "text", text: "." }]);
  const { server, requests } = mockRounds(endless.slice(0, 7));
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    for await (const _ of req);
    requests.push({});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "." }], stop_reason: "pause_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { normalizedResponse } = await forwardRequest(config(`http://127.0.0.1:${(server.address() as { port: number }).port}`), request());
    assert.equal(requests.length, 6);
    assert.equal(normalizedResponse.finishReason, "pause_turn");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an anthropic client's paused turn is left to the client", async () => {
  // Same-format requests are passthrough and never reach forwardRequest; the stop reason is only
  // resumed for converted requests, so a request already in Anthropic form is not touched.
  await withMock([[SEARCH_CALL]], async (baseURL, requests) => {
    const { normalizedResponse } = await forwardRequest(config(baseURL), { ...request(), sourceFormat: "anthropic" });
    assert.equal(requests.length, 1);
    assert.equal(normalizedResponse.finishReason, "pause_turn");
  }, true);
});

test("a paused stream is spliced into one stream with continuous blocks and summed usage", async () => {
  await withMock([[{ type: "text", text: "Searching. " }, SEARCH_CALL], [SEARCH_RESULT, { type: "text", text: "Halzen won." }]], async (baseURL, requests) => {
    const { body, upstreamFormat } = await forwardStreamRequest(config(baseURL), request());
    assert.equal(upstreamFormat, "anthropic");
    const events = sseEvents(await readText(body));

    assert.equal(requests.length, 2);
    // The continuation carries the first round's blocks, with the streamed query parsed back into input.
    assert.deepEqual(requests[1].messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Searching. " }, SEARCH_CALL] });

    assert.deepEqual(events.map((event) => event.type).filter((type) => type !== "content_block_delta"), [
      "message_start",
      "content_block_start", "content_block_stop",
      "content_block_start", "content_block_stop",
      "content_block_start", "content_block_stop",
      "content_block_start", "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.deepEqual(events.filter((event) => event.type === "content_block_start").map((event) => event.index), [0, 1, 2, 3]);
    const end = events.find((event) => event.type === "message_delta");
    assert.equal(end?.delta.stop_reason, "end_turn");
    assert.equal(end?.usage.output_tokens, 8);
  });
});

test("a spliced stream converts to one responses stream with the search finished by the resumed round", async () => {
  await withMock([[SEARCH_CALL], [SEARCH_RESULT, { type: "text", text: "Halzen won." }]], async (baseURL) => {
    const { body } = await forwardStreamRequest(config(baseURL), request());
    const converter = createSSEConverter("anthropic", "openai-responses");
    const out = [...converter.push(await readText(body)), ...converter.flush()].join("");
    const events = sseEvents(out);
    const completed = events.find((event) => event.type === "response.completed");
    assert.deepEqual(completed?.response.output.map((item: Json) => item.type), ["web_search_call", "reasoning", "message"]);
    assert.equal(completed?.response.output[0].status, "completed");
    assert.equal(completed?.response.output[2].content[0].text, "Halzen won.");
  });
});

test("pause handling helpers", () => {
  assert.deepEqual(sumUsage({ input_tokens: 1, server_tool_use: { web_search_requests: 1 } }, { input_tokens: 2, server_tool_use: { web_search_requests: 2 }, service_tier: "standard" }), {
    input_tokens: 3,
    server_tool_use: { web_search_requests: 3 },
    service_tier: "standard",
  });
  const merged = mergePausedResponses([
    { id: "msg_1", content: [{ type: "text", text: "a" }], stop_reason: "pause_turn", usage: { output_tokens: 1 } },
    { id: "msg_2", content: [{ type: "text", text: "b" }], stop_reason: "end_turn", usage: { output_tokens: 2 } },
  ]);
  assert.deepEqual(merged, { id: "msg_1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], stop_reason: "end_turn", usage: { output_tokens: 3 } });
});

test("a failing continuation errors the stream instead of ending it as finished", async () => {
  const first = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: {} } })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 1 } })}\n\n`));
      controller.close();
    },
  });
  const stream = continuePausedAnthropicStream(first, async () => {
    throw new Error("resume failed");
  });
  await assert.rejects(readText(stream), /resume failed/);
});
