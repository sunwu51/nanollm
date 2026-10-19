import assert from "node:assert/strict";
import { decodeReasoningCarrier, encodeReasoningCarrier } from "../src/converters/shared.js";
import {
  createSSEConverter,
  createStreamConverter,
  ResponsesStreamParser,
  SSEParser,
  type NormalizedStreamEvent,
  type StreamFormat,
} from "../src/converters/streams.js";

type Event = Record<string, any>;

function created(): Event {
  return { type: "response.created", response: { id: "resp_reasoning", model: "test-model", created_at: 1, status: "in_progress", output: [], usage: null } };
}

function reasoning(fields: Event = {}): Event {
  return { id: "rs_native", type: "reasoning", status: "completed", summary: [], ...fields };
}

function completed(output: Event[] = []): Event {
  return { type: "response.completed", response: { id: "resp_reasoning", model: "test-model", created_at: 1, status: "completed", output, usage: null } };
}

function convert(from: StreamFormat, to: StreamFormat, events: Event[]): Event[] {
  const converter = createStreamConverter(from, to);
  return [...events.flatMap((event) => converter.push(event)), ...converter.flush()] as Event[];
}

function parseResponses(events: Event[]): NormalizedStreamEvent[] {
  const parser = new ResponsesStreamParser();
  return [...events.flatMap((event) => parser.parse(event as never)), ...parser.finish()];
}

function thinkingBlocks(events: NormalizedStreamEvent[]): string[] {
  const blocks = new Map<number, string>();
  let openIndex: number | undefined;
  for (const event of events) {
    if (event.type === "content_start" && event.contentType === "thinking") {
      assert.equal(openIndex, undefined, "the previous thinking block must close before another starts");
      assert.equal(blocks.has(event.index), false, "a thinking block index must start only once");
      blocks.set(event.index, "");
      openIndex = event.index;
    } else if (event.type === "content_delta" && blocks.has(event.index)) {
      assert.equal(openIndex, event.index, "thinking deltas must belong to the currently open block");
      blocks.set(event.index, blocks.get(event.index)! + event.delta);
    } else if (event.type === "content_done" && blocks.has(event.index)) {
      assert.equal(openIndex, event.index, "only the open thinking block can stop");
      openIndex = undefined;
    } else if (event.type === "content_start" || event.type === "tool_start") {
      assert.equal(openIndex, undefined, "thinking must close before subsequent content or tools start");
    }
  }
  assert.equal(openIndex, undefined, "the final thinking block must close");
  for (const index of blocks.keys()) {
    assert.equal(events.filter((event) => event.type === "content_done" && event.index === index).length, 1, "each thinking block must close exactly once");
  }
  return [...blocks.values()];
}

function chatThinking(events: Event[]): string {
  return convert("openai-responses", "openai-chat", events)
    .flatMap((event) => event.choices ?? [])
    .map((choice: Event) => choice.delta?.reasoning_content ?? "")
    .join("");
}

function anthropicBlocks(events: Event[]): Event[] {
  const blocks = new Map<number, Event>();
  let openIndex: number | undefined;
  for (const event of events) {
    if (event.type === "content_block_start") {
      assert.equal(openIndex, undefined, "Anthropic content blocks must not overlap");
      assert.equal(blocks.has(event.index), false, "an Anthropic block index must start only once");
      blocks.set(event.index, { ...event.content_block });
      openIndex = event.index;
    } else if (event.type === "content_block_delta") {
      assert.equal(openIndex, event.index, "Anthropic deltas must belong to the currently open block");
      const block = blocks.get(event.index);
      assert.ok(block, "an Anthropic delta must have a corresponding block start");
      if (event.delta.type === "thinking_delta") block.thinking += event.delta.thinking;
      else if (event.delta.type === "signature_delta") block.signature += event.delta.signature;
      else if (event.delta.type === "text_delta") block.text += event.delta.text;
    } else if (event.type === "content_block_stop") {
      assert.equal(openIndex, event.index, "only the open Anthropic block can stop");
      openIndex = undefined;
    }
  }
  assert.equal(openIndex, undefined, "the final Anthropic content block must close");
  for (const index of blocks.keys()) {
    assert.equal(events.filter((event) => event.type === "content_block_stop" && event.index === index).length, 1, "each Anthropic block must close exactly once");
  }
  return [...blocks.values()];
}

function anthropicMessage(contentEvents: Event[]): Event[] {
  return [
    { type: "message_start", message: { id: "msg_claude", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...contentEvents,
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}

export function runReasoningStreamTests(run: (name: string, fn: () => void) => void): void {
  run("reasoning streams recover raw or summary text from terminal-only response.completed", () => {
    for (const source of ["content", "summary"] as const) {
      const item = reasoning({ [source]: [{ type: source === "content" ? "reasoning_text" : "summary_text", text: "Terminal plan." }] });
      const events = [completed([item])];
      assert.deepEqual(thinkingBlocks(parseResponses(events)), ["Terminal plan."]);
      assert.equal(chatThinking(events), "Terminal plan.");
    }
  });

  run("reasoning streams recover standalone raw and summary text.done events at EOF", () => {
    for (const source of ["content", "summary"] as const) {
      const event = {
        type: source === "content" ? "response.reasoning_text.done" : "response.reasoning_summary_text.done",
        output_index: 4,
        item_id: "rs_done_only",
        [source === "content" ? "content_index" : "summary_index"]: 0,
        text: "Only the done event survived.",
      };
      const events = [created(), event];
      assert.deepEqual(thinkingBlocks(parseResponses(events)), [event.text]);
      assert.equal(chatThinking(events), event.text);
    }
  });

  run("reasoning streams append the missing done tail once across item and response completion", () => {
    const item = reasoning({ content: [{ type: "reasoning_text", text: "Check the complete plan." }], encrypted_content: "native-final-ciphertext" });
    const events = [
      created(),
      { type: "response.output_item.added", output_index: 0, item: reasoning({ status: "in_progress" }) },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Check the " },
      { type: "response.reasoning_text.done", output_index: 0, item_id: item.id, content_index: 0, text: "Check the complete plan." },
      { type: "response.content_part.done", output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      completed([item]),
    ];
    const normalized = parseResponses(events);
    assert.deepEqual(thinkingBlocks(normalized), ["Check the complete plan."]);
    assert.equal(chatThinking(events), "Check the complete plan.");
    assert.equal(normalized.filter((event) => event.type === "reasoning_metadata").length, 1);
  });

  run("reasoning streams preserve multiple text parts and sparse summary indexes", () => {
    const rawItem = reasoning({ content: [{ type: "reasoning_text", text: "First part." }, { type: "reasoning_text", text: "Second part." }] });
    const rawEvents = [
      created(),
      ...rawItem.content.map((part: Event, content_index: number) => ({ type: "response.reasoning_text.done", output_index: 0, item_id: rawItem.id, content_index, text: part.text })),
      { type: "response.output_item.done", output_index: 0, item: rawItem },
      completed([rawItem]),
    ];
    assert.deepEqual(thinkingBlocks(parseResponses(rawEvents)), ["First part.", "Second part."]);

    const sparseItem = reasoning({ summary: [null, null, null, { type: "summary_text", text: "Fourth summary part." }] });
    const sparseEvents = [
      created(),
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: sparseItem.id, summary_index: 3, delta: "Fourth " },
      { type: "response.reasoning_summary_part.done", output_index: 0, item_id: sparseItem.id, summary_index: 3, part: sparseItem.summary[3] },
      { type: "response.output_item.done", output_index: 0, item: sparseItem },
      completed([sparseItem]),
    ];
    assert.deepEqual(thinkingBlocks(parseResponses(sparseEvents)), ["Fourth summary part."]);
  });

  run("reasoning streams ignore empty summary deltas when choosing raw versus summary", () => {
    const item = reasoning({ summary: [{ type: "summary_text", text: "Unused summary." }], content: [{ type: "reasoning_text", text: "Actual raw thought." }] });
    const events = [
      created(),
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: item.id, summary_index: 0, delta: "" },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Actual raw thought." },
      { type: "response.output_item.done", output_index: 0, item },
      completed([item]),
    ];
    assert.deepEqual(thinkingBlocks(parseResponses(events)), ["Actual raw thought."]);
    assert.equal(chatThinking(events), "Actual raw thought.");
  });

  run("reasoning streams emit sequential Anthropic blocks for multiple raw or summary parts", () => {
    for (const source of ["content", "summary"] as const) {
      const partType = source === "content" ? "reasoning_text" : "summary_text";
      const deltaType = source === "content" ? "response.reasoning_text.delta" : "response.reasoning_summary_text.delta";
      const doneType = source === "content" ? "response.reasoning_text.done" : "response.reasoning_summary_text.done";
      const indexKey = source === "content" ? "content_index" : "summary_index";
      const parts = [{ type: partType, text: "First part." }, { type: partType, text: "Second part." }];
      const item = reasoning({ [source]: parts });
      const events = [
        created(),
        { type: "response.output_item.added", output_index: 0, item: reasoning({ status: "in_progress" }) },
        ...parts.flatMap((part, index) => [
          { type: deltaType, output_index: 0, item_id: item.id, [indexKey]: index, delta: part.text },
          { type: doneType, output_index: 0, item_id: item.id, [indexKey]: index, text: part.text },
        ]),
        { type: "response.output_item.done", output_index: 0, item },
        completed([item]),
      ];
      assert.deepEqual(thinkingBlocks(parseResponses(events)), parts.map((part) => part.text));
      assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), parts.map((part) => ({ type: "thinking", thinking: part.text, signature: "" })));
    }
  });

  run("reasoning streams recover incomplete terminal output and finish with length once", () => {
    const thought = "Partial thought reaches its terminal snapshot.";
    const item = reasoning({ status: "incomplete", content: [{ type: "reasoning_text", text: thought }] });
    const terminal = { type: "response.incomplete", response: { ...completed([item]).response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
    for (const delta of ["", "Partial thought "]) {
      const events = [created(), ...(delta ? [{ type: "response.reasoning_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta }] : []), terminal];
      const normalized = parseResponses(events);
      assert.deepEqual(thinkingBlocks(normalized), [thought]);
      assert.deepEqual(normalized.filter((event) => event.type === "end").map((event) => event.finishReason), ["length"]);
      const chat = convert("openai-responses", "openai-chat", events).flatMap((event) => event.choices ?? []);
      assert.equal(chat.map((choice: Event) => choice.delta?.reasoning_content ?? "").join(""), thought);
      assert.deepEqual(chat.map((choice: Event) => choice.finish_reason).filter(Boolean), ["length"]);
    }
  });

  run("reasoning streams recover failed terminal output and close before the error end", () => {
    const thought = "Reasoning produced before failure.";
    const item = reasoning({ status: "incomplete", summary: [{ type: "summary_text", text: thought }] });
    const terminal = { type: "response.failed", response: { ...completed([item]).response, status: "failed", error: { code: "server_error", message: "Upstream failure" } } };
    const events = [created(), { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: item.id, summary_index: 0, delta: "Reasoning " }, terminal];
    const normalized = parseResponses(events);
    assert.deepEqual(thinkingBlocks(normalized), [thought]);
    assert.deepEqual(normalized.filter((event) => event.type === "end").map((event) => event.finishReason), ["error"]);
    assert.equal(normalized.at(-1)?.type, "end");
    assert.equal(chatThinking(events), thought);
    assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), [{ type: "thinking", thinking: thought, signature: "" }]);
  });

  run("reasoning streams recover added-item text at EOF without trusting added ciphertext", () => {
    const added = { type: "response.output_item.added", output_index: 2, item: reasoning({ content: [{ type: "reasoning_text", text: "Snapshot thought." }], encrypted_content: "incomplete-added-ciphertext", status: "in_progress" }) };
    for (const tail of [[], [completed()]] as Event[][]) {
      const events = [created(), added, ...tail];
      const normalized = parseResponses(events);
      assert.deepEqual(thinkingBlocks(normalized), ["Snapshot thought."]);
      assert.equal(normalized.some((event) => event.type === "reasoning_metadata"), false);
      assert.equal(normalized.some((event) => event.type === "content_start" && event.contentType === "redacted_thinking"), false);
      const output = convert("openai-responses", "openai-responses", events);
      assert.equal(JSON.stringify(output).includes("incomplete-added-ciphertext"), false);
    }
  });

  run("reasoning streams keep native final encryption as metadata rather than a Claude signature", () => {
    const item = reasoning({ content: [{ type: "reasoning_text", text: "Readable native thought." }], encrypted_content: "native-final-ciphertext" });
    const events = [created(), { type: "response.output_item.added", output_index: 0, item: reasoning({ encrypted_content: "incomplete-added-ciphertext", status: "in_progress" }) }, { type: "response.output_item.done", output_index: 0, item }, completed([item])];
    const normalized = parseResponses(events);
    assert.deepEqual(normalized.filter((event) => event.type === "reasoning_metadata").map((event) => ({ id: event.id, encryptedContent: event.encryptedContent })), [{ id: item.id, encryptedContent: item.encrypted_content }]);
    assert.equal(normalized.some((event) => event.type === "signature_delta"), false);
    assert.equal(normalized.some((event) => event.type === "content_start" && event.contentType === "redacted_thinking"), false);
    assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), [{ type: "thinking", thinking: "Readable native thought.", signature: "" }]);
    const responseOutput = convert("openai-responses", "openai-responses", events);
    const done = responseOutput.filter((event) => event.type === "response.output_item.done" && event.item.type === "reasoning");
    assert.equal(done.length, 1);
    assert.equal(done[0].item.id, item.id);
    assert.equal(done[0].item.encrypted_content, item.encrypted_content);
  });

  run("reasoning streams preserve opaque-only native encryption without emitting Claude redacted thinking", () => {
    const item = reasoning({ encrypted_content: "native-opaque-only" });
    const events = [created(), completed([item])];
    assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), []);
    const output = convert("openai-responses", "openai-responses", events);
    const items = output.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, item.id);
    assert.equal(items[0].encrypted_content, item.encrypted_content);
    assert.equal(decodeReasoningCarrier(items[0].encrypted_content), undefined);
  });

  run("reasoning streams restore signed and empty signed carriers with summaries removed", () => {
    for (const thought of ["Restored Claude thought.", ""]) {
      const item = reasoning({ encrypted_content: encodeReasoningCarrier(thought, "claude-signature") });
      const events = [created(), { type: "response.output_item.done", output_index: 0, item }, completed([item])];
      assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), [{ type: "thinking", thinking: thought, signature: "claude-signature" }]);
    }
  });

  run("reasoning streams restore a carrier signature after partial thinking deltas without duplication", () => {
    const thought = "Think through the complete plan.";
    const item = reasoning({ summary: [{ type: "summary_text", text: thought }], encrypted_content: encodeReasoningCarrier(thought, "signed-complete-plan") });
    const events = [created(), { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: item.id, summary_index: 0, delta: "Think through " }, { type: "response.output_item.done", output_index: 0, item }, completed([item])];
    assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", events)), [{ type: "thinking", thinking: thought, signature: "signed-complete-plan" }]);
  });

  run("reasoning streams round-trip Claude redacted thinking including empty payloads", () => {
    for (const data of ["claude-encrypted-redacted", ""]) {
      const original = anthropicMessage([{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data } }, { type: "content_block_stop", index: 0 }]);
      const responses = convert("anthropic", "openai-responses", original);
      const done = responses.filter((event) => event.type === "response.output_item.done" && event.item.type === "reasoning");
      assert.equal(done.length, 1);
      assert.deepEqual(decodeReasoningCarrier(done[0].item.encrypted_content), { thinking: "", redactedThinking: data });
      assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", responses)), [{ type: "redacted_thinking", data }]);
    }
  });

  run("reasoning streams retain initial Claude thinking and signature alongside subsequent deltas", () => {
    const original = anthropicMessage([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Initial thought.", signature: "initial-" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " Follow-up thought." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "tail" } },
      { type: "content_block_stop", index: 0 },
    ]);
    const responses = convert("anthropic", "openai-responses", original);
    const done = responses.find((event) => event.type === "response.output_item.done" && event.item.type === "reasoning");
    assert.deepEqual(decodeReasoningCarrier(done?.item.encrypted_content), { thinking: "Initial thought. Follow-up thought.", signature: "initial-tail" });
    assert.deepEqual(anthropicBlocks(convert("openai-responses", "anthropic", responses)), [{ type: "thinking", thinking: "Initial thought. Follow-up thought.", signature: "initial-tail" }]);
  });

  run("reasoning SSE conversion handles split frames and final unterminated reasoning done events", () => {
    const converter = createSSEConverter("openai-responses", "openai-chat");
    const input = [created(), { type: "response.reasoning_summary_text.done", item_id: "rs_sse", output_index: 0, summary_index: 0, text: "Recovered across SSE chunks." }]
      .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}`)
      .join("\r\n\r\n");
    const cut = input.indexOf("Recovered") + 4;
    const chunks = [...converter.push(input.slice(0, cut)), ...converter.push(input.slice(cut)), ...converter.flush()];
    const parser = new SSEParser();
    const parsed = [...parser.push(chunks.join("")), ...parser.flush()]
      .filter((event) => event.data !== "[DONE]")
      .map((event) => JSON.parse(event.data));
    const text = parsed.flatMap((event) => event.choices ?? []).map((choice: Event) => choice.delta?.reasoning_content ?? "").join("");
    assert.equal(text, "Recovered across SSE chunks.");
  });
}
