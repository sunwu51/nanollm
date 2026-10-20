import assert from "node:assert/strict";
import {
  anthropicMessageRequestToChatParams,
  anthropicMessageRequestToResponsesRequest,
  anthropicMessageToResponsesResponse,
  createStreamConverter,
  responsesRequestToAnthropicMessageRequest,
  responsesResponseToAnthropicMessage,
  responsesResponseToChatCompletion,
} from "../src/converters/index.js";
import { denormalizeToAnthropicRequest, denormalizeToOpenAIResponsesRequest, normalizeAnthropicRequest, normalizeOpenAIResponsesRequest } from "../src/converters/requests.js";
import {
  decodeWebSearchCarrier,
  degradeSynthesizedAnthropicWebSearch,
  degradeSynthesizedResponsesWebSearch,
  encodeWebSearchCarrier,
  splitTextByCitations,
  WEB_SEARCH_MARKER,
} from "../src/converters/web-search.js";

type Json = Record<string, any>;

const RETENTION = "(Full page contents were retrieved and read when this answer was written; only source metadata is kept in this conversation history.)";

function claudeSearch(id = "srvtoolu_01abc"): Json[] {
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query: "2026 Nobel physics" } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: [
        { type: "web_search_result", url: "https://nobelprize.org/2026", title: "Nobel Prize 2026", encrypted_content: "ENC_A", page_age: "14 days ago" },
        { type: "web_search_result", url: "https://news.example/halzen", title: "Halzen wins", encrypted_content: "ENC_B", page_age: null },
      ],
    },
  ];
}

function citedText(text: string, url: string, citedTextValue: string): Json {
  return { type: "text", text, citations: [{ type: "web_search_result_location", url, title: "Nobel Prize 2026", cited_text: citedTextValue, encrypted_index: "IDX_1" }] };
}

function gptSearch(id = "ws_0552abc"): Json {
  return {
    id,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "nobel 2026 physics", queries: ["nobel 2026 physics"], sources: [{ type: "url", url: "https://www.nsf.gov/nobel" }, { type: "url", url: "https://kva.se/2026" }] },
  };
}

function gptAnswer(): Json {
  const text = "Francis Halzen won. ([nsf.gov](https://www.nsf.gov/nobel))";
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://www.nsf.gov/nobel", title: "NSF: 2026 Nobel", start_index: 20, end_index: text.length }] }],
  };
}

export function runWebSearchTests(run: (name: string, fn: () => void) => void): void {
  run("web search carrier round-trips the original Anthropic blocks", () => {
    const blocks = claudeSearch();
    assert.deepEqual(decodeWebSearchCarrier(encodeWebSearchCarrier(blocks)), blocks);
    assert.equal(decodeWebSearchCarrier("nanollm.reasoning.v1:abc"), undefined);
  });

  run("responses web_search tool becomes anthropic basic web search; a forced choice becomes auto", () => {
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: "hi",
      tools: [{ type: "web_search", filters: { allowed_domains: ["nobelprize.org"], blocked_domains: ["reddit.com"] }, user_location: { country: "SG", city: "Singapore" }, search_context_size: "low" } as any],
      tool_choice: { type: "web_search" } as any,
    } as any);
    assert.deepEqual(result.tools, [{
      type: "web_search_20250305",
      name: "web_search",
      // Anthropic rejects allowed and blocked domains together.
      allowed_domains: ["nobelprize.org"],
      user_location: { type: "approximate", city: "Singapore", country: "SG" },
    }]);
    assert.equal((result.tool_choice as Json).type, "auto");
  });

  run("responses cache-only web search is dropped for anthropic", () => {
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: "hi",
      tools: [{ type: "web_search", external_web_access: false } as any],
      tool_choice: { type: "web_search" } as any,
    } as any);
    assert.deepEqual(result.tools, []);
    assert.equal(result.tool_choice, undefined);
  });

  run("anthropic web search tool becomes responses web_search with sources included", () => {
    const result = anthropicMessageRequestToResponsesRequest({
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3, blocked_domains: ["reddit.com"], allowed_callers: ["direct"] } as any],
      tool_choice: { type: "tool", name: "web_search" },
    } as any);
    // max_uses has no reliable Responses counterpart and is dropped.
    assert.deepEqual(result.tools, [{ type: "web_search", filters: { blocked_domains: ["reddit.com"] } }]);
    assert.deepEqual(result.include, ["web_search_call.action.sources"]);
    // Forcing web search makes GPT loop until max_messages.
    assert.equal(result.tool_choice, "auto");
  });

  run("anthropic web search tool and its forced choice are dropped for chat", () => {
    const chat = anthropicMessageRequestToChatParams({
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search" } as any],
      tool_choice: { type: "tool", name: "web_search" },
    } as any);
    assert.deepEqual(chat.tools, []);
    assert.equal(chat.tool_choice, undefined);
  });

  run("claude search history becomes a web_search_history function call for responses, in order", () => {
    const result = anthropicMessageRequestToResponsesRequest({
      model: "claude",
      max_tokens: 100,
      messages: [
        { role: "user", content: "Who won?" },
        { role: "assistant", content: [{ type: "text", text: "Let me search." }, ...claudeSearch(), citedText("Halzen won.", "https://nobelprize.org/2026", "Francis Halzen has laid the foundation...")] },
        { role: "user", content: "Source?" },
      ],
    } as any);
    const input = result.input as Json[];
    assert.deepEqual(input.map((item) => item.type ?? item.role), ["message", "message", "function_call", "function_call_output", "message", "message"]);
    assert.equal(input[1].content[0].text, "Let me search.");
    assert.deepEqual(input[2], { type: "function_call", call_id: "srvtoolu_01abc", name: "web_search_history", arguments: JSON.stringify({ query: "2026 Nobel physics" }) });
    assert.equal(input[3].call_id, "srvtoolu_01abc");
    assert.equal(
      input[3].output,
      "Search results:\n- Nobel Prize 2026 — https://nobelprize.org/2026 (14 days ago)\n  > Francis Halzen has laid the foundation...\n- Halzen wins — https://news.example/halzen",
    );
    // Claude citations have no range, so no annotations; the opaque blobs never reach OpenAI.
    assert.deepEqual(input[4].content, [{ type: "output_text", text: "Halzen won.", annotations: [] }]);
    assert.doesNotMatch(JSON.stringify(input), /ENC_A|IDX_1/);
  });

  run("a claude search whose result arrives after a client tool call is shown once, completed", () => {
    const request = {
      model: "claude",
      max_tokens: 100,
      tools: [{ name: "run", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
      messages: [
        { role: "user", content: "Search and run." },
        { role: "assistant", content: [claudeSearch()[0], { type: "tool_use", id: "toolu_1", name: "run", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        { role: "assistant", content: [claudeSearch()[1], { type: "text", text: "Done." }] },
      ],
    } as any;

    const input = anthropicMessageRequestToResponsesRequest(request).input as Json[];
    const searchCalls = input.filter((item) => item.type === "function_call" && item.name === "web_search_history");
    assert.equal(searchCalls.length, 1);
    const output = input.find((item) => item.type === "function_call_output" && item.call_id === "srvtoolu_01abc");
    assert.match(output?.output, /^Search results:\n- Nobel Prize 2026/);

    // Back to Anthropic the native blocks stay where they were.
    const anthropic = denormalizeToAnthropicRequest(normalizeAnthropicRequest(request));
    const blockTypes = anthropic.messages.map((message) => typeof message.content === "string" ? "string" : (message.content as Json[]).map((block) => block.type));
    assert.deepEqual(blockTypes, ["string", ["server_tool_use", "tool_use"], ["tool_result"], ["web_search_tool_result", "text"]]);
  });

  run("a responses search shown to an anthropic client is rebuilt natively for responses", () => {
    const result = anthropicMessageRequestToResponsesRequest({
      model: "claude",
      max_tokens: 100,
      messages: [
        { role: "user", content: "Who won?" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_nanollm_ws_0552abc", name: "web_search", input: { query: "nobel 2026 physics", action: { type: "search", queries: ["nobel 2026 physics"] } } },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_nanollm_ws_0552abc", content: [{ type: "web_search_result", url: "https://www.nsf.gov/nobel", title: "NSF", encrypted_content: WEB_SEARCH_MARKER, page_age: null }] },
            { type: "text", text: "Halzen won." },
          ],
        },
        { role: "user", content: "Source?" },
      ],
    } as any);
    const input = result.input as Json[];
    assert.deepEqual(input[1], {
      type: "web_search_call",
      id: "ws_0552abc",
      status: "completed",
      action: { type: "search", query: "nobel 2026 physics", queries: ["nobel 2026 physics"], sources: [{ type: "url", url: "https://www.nsf.gov/nobel" }] },
    });
    assert.equal(input[2].content[0].text, "Halzen won.");
  });

  run("gpt search history becomes an assistant-voice note for anthropic", () => {
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: [
        { role: "user", content: "Who won?" },
        gptSearch(),
        gptAnswer(),
        { role: "user", content: "Source?" },
      ],
    } as any);
    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    const blocks = assistant.content as Json[];
    assert.equal(blocks[0].type, "text");
    // The annotation title fills in the title the Responses source lacks.
    assert.equal(blocks[0].text, `[web_search] query: nobel 2026 physics\n${RETENTION}\nSources:\n- NSF: 2026 Nobel — https://www.nsf.gov/nobel\n- https://kva.se/2026`);
    assert.deepEqual(blocks[1], { type: "text", text: gptAnswer().content[0].text, citations: null });
    assert.doesNotMatch(JSON.stringify(result.messages), /server_tool_use|web_search_tool_result/);
  });

  run("a claude search carried through a responses client is replayed verbatim to anthropic", () => {
    const blocks = claudeSearch();
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: [
        { role: "user", content: "Who won?" },
        { type: "web_search_call", id: "ws_nanollm_srvtoolu_01abc", status: "completed", action: { type: "search", query: "2026 Nobel physics", sources: [] } },
        { type: "reasoning", summary: [], encrypted_content: encodeWebSearchCarrier(blocks) },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Halzen won.", annotations: [] }] },
        { role: "user", content: "Source?" },
      ],
    } as any);
    assert.deepEqual(result.messages[1].content, [...blocks, { type: "text", text: "Halzen won.", citations: null }]);
  });

  run("a claude search whose carrier the responses client dropped degrades to a note", () => {
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: [
        { role: "user", content: "Who won?" },
        { type: "web_search_call", id: "ws_nanollm_srvtoolu_01abc", status: "completed", action: { type: "search", query: "2026 Nobel physics", sources: [{ type: "url", url: "https://nobelprize.org/2026" }] } },
        { role: "user", content: "Source?" },
      ],
    } as any);
    assert.deepEqual(result.messages[1].content, [{ type: "text", text: `[web_search] query: 2026 Nobel physics\n${RETENTION}\nSources:\n- https://nobelprize.org/2026`, citations: null }]);
  });

  run("failed and page actions render as readable notes", () => {
    const result = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: [
        { role: "user", content: "Look." },
        { id: "ws_1", type: "web_search_call", status: "failed", action: { type: "search", queries: ["q"] } },
        { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://a.example" } },
        { role: "user", content: "Again." },
      ],
    } as any);
    const texts = (result.messages[1].content as Json[]).map((block) => block.text);
    assert.deepEqual(texts, ["[web_search] query: q\nSearch failed.", `[web_search] action: open_page: https://a.example\n${RETENTION}`]);
  });

  run("responses url_citation annotations survive normalization with their code-point range", () => {
    const normalized = normalizeOpenAIResponsesRequest({ model: "gpt", input: [{ role: "user", content: "q" }, gptAnswer(), { role: "user", content: "next" }] } as any);
    const answer = normalized.messages[1].parts[0];
    assert.equal(answer.type, "text");
    assert.deepEqual(answer.type === "text" ? answer.citations : undefined, [{ url: "https://www.nsf.gov/nobel", title: "NSF: 2026 Nobel", startIndex: 20, endIndex: gptAnswer().content[0].text.length }]);
    const responses = denormalizeToOpenAIResponsesRequest(normalized).input as Json[];
    assert.deepEqual(responses[1].content[0].annotations, gptAnswer().content[0].annotations);
  });

  run("same-format responses passthrough degrades nanollm search carriers into function calls", () => {
    const input = [
      { role: "user", content: "Who won?" },
      { type: "web_search_call", id: "ws_nanollm_srvtoolu_01abc", status: "completed", action: { type: "search", query: "2026 Nobel physics" } },
      { type: "reasoning", summary: [], encrypted_content: encodeWebSearchCarrier(claudeSearch()) },
      gptSearch(),
      { type: "reasoning", summary: [], encrypted_content: "gAAAA_native" },
    ];
    const degraded = degradeSynthesizedResponsesWebSearch(input) as Json[];
    assert.deepEqual(degraded.map((item) => item.type ?? item.role), ["user", "function_call", "function_call_output", "web_search_call", "reasoning"]);
    assert.equal(degraded[1].name, "web_search_history");
    assert.match(degraded[2].output, /- Nobel Prize 2026 — https:\/\/nobelprize.org\/2026 \(14 days ago\)/);
    // Native items are untouched.
    assert.equal(degraded[3], input[3]);
    assert.equal(degraded[4], input[4]);
    assert.equal(degradeSynthesizedResponsesWebSearch([gptSearch()]), undefined);
  });

  run("same-format anthropic passthrough degrades nanollm searches and marker citations", () => {
    const realSearch = claudeSearch("srvtoolu_01real");
    const messages = [
      { role: "user", content: "Who won?" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_nanollm_ws_1", name: "web_search", input: { query: "nobel", action: { type: "search", queries: ["nobel"] } } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_nanollm_ws_1", content: [{ type: "web_search_result", url: "https://kva.se", title: "KVA", encrypted_content: WEB_SEARCH_MARKER, page_age: null }] },
          { type: "text", text: "Halzen.", citations: [{ type: "web_search_result_location", url: "https://kva.se", title: "KVA", cited_text: "Halzen.", encrypted_index: WEB_SEARCH_MARKER }] },
          ...realSearch,
        ],
      },
    ];
    const degraded = degradeSynthesizedAnthropicWebSearch(messages) as Json[];
    assert.deepEqual(degraded[1].content, [
      { type: "text", text: `[web_search] query: nobel\n${RETENTION}\nSources:\n- KVA — https://kva.se` },
      { type: "text", text: "Halzen.", citations: null },
      ...realSearch,
    ]);
    assert.equal(degradeSynthesizedAnthropicWebSearch([{ role: "assistant", content: realSearch }]), undefined);
  });

  run("a claude search in a response becomes a web_search_call plus a carrier, and the text keeps its citations", () => {
    const blocks = claudeSearch();
    const response = anthropicMessageToResponsesResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [
        { type: "thinking", thinking: "", signature: "SIG_1" },
        { type: "text", text: "Let me search." },
        ...blocks,
        citedText("Halzen won.", "https://nobelprize.org/2026", "quote"),
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any);
    const output = response.output as Json[];
    assert.deepEqual(output.map((item) => item.type), ["reasoning", "message", "web_search_call", "reasoning", "message"]);
    assert.equal(output[1].content[0].text, "Let me search.");
    assert.deepEqual(output[2], {
      id: "ws_nanollm_srvtoolu_01abc",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "2026 Nobel physics",
        queries: ["2026 Nobel physics"],
        sources: [{ type: "url", url: "https://nobelprize.org/2026" }, { type: "url", url: "https://news.example/halzen" }],
      },
    });
    assert.deepEqual(decodeWebSearchCarrier(output[3].encrypted_content), blocks);
    assert.deepEqual(output[4].content, [{
      type: "output_text",
      text: "Halzen won.",
      annotations: [{ type: "url_citation", url: "https://nobelprize.org/2026", title: "Nobel Prize 2026", start_index: 0, end_index: 11 }],
    }]);
  });

  run("a claude search with a pending result is carried but not shown, and the result later appears once", () => {
    const [serverToolUse, result] = claudeSearch();
    const pending = anthropicMessageToResponsesResponse({
      id: "msg_1", type: "message", role: "assistant", model: "claude", stop_reason: "tool_use", stop_sequence: null,
      content: [serverToolUse, { type: "tool_use", id: "toolu_1", name: "run", input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any);
    const pendingOutput = pending.output as Json[];
    assert.deepEqual(pendingOutput.map((item) => item.type), ["reasoning", "function_call"]);
    assert.deepEqual(decodeWebSearchCarrier(pendingOutput[0].encrypted_content), [serverToolUse]);

    const resumed = anthropicMessageToResponsesResponse({
      id: "msg_2", type: "message", role: "assistant", model: "claude", stop_reason: "end_turn", stop_sequence: null,
      content: [result, { type: "text", text: "Done." }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any);
    const resumedOutput = resumed.output as Json[];
    assert.deepEqual(resumedOutput.map((item) => item.type), ["web_search_call", "reasoning", "message"]);
    assert.equal(resumedOutput[0].id, "ws_nanollm_srvtoolu_01abc");
    assert.deepEqual(decodeWebSearchCarrier(resumedOutput[1].encrypted_content), [result]);
  });

  run("a failed claude search is shown as a failed web_search_call", () => {
    const response = anthropicMessageToResponsesResponse({
      id: "msg_1", type: "message", role: "assistant", model: "claude", stop_reason: "end_turn", stop_sequence: null,
      content: [
        claudeSearch()[0],
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_01abc", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
        { type: "text", text: "Sorry." },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any);
    const output = response.output as Json[];
    assert.equal(output[0].status, "failed");
    assert.equal(output[0].action.sources, undefined);
  });

  run("a claude search round-trips through a responses client back to claude unchanged", () => {
    const blocks = claudeSearch();
    const text = citedText("Halzen won.", "https://nobelprize.org/2026", "quote");
    const response = anthropicMessageToResponsesResponse({
      id: "msg_1", type: "message", role: "assistant", model: "claude", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "thinking", thinking: "", signature: "SIG_1" }, ...blocks, text],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any);
    // What a Responses client keeps and sends back verbatim, minus its drops of annotations.
    const echoed = (response.output as Json[]).map((item) => item.type === "message" ? { ...item, content: item.content.map((part: Json) => ({ ...part, annotations: [] })) } : item);
    const replay = responsesRequestToAnthropicMessageRequest({
      model: "gpt",
      input: [{ role: "user", content: "Who won?" }, ...echoed, { role: "user", content: "Source?" }],
    } as any);
    assert.deepEqual(replay.messages[1].content, [
      { type: "thinking", thinking: "", signature: "SIG_1" },
      ...blocks,
      { type: "text", text: "Halzen won.", citations: null },
    ]);
  });

  run("a gpt search in a response becomes server_tool_use plus a result, and citation ranges split the text", () => {
    const text = "Francis Halzen won. ([nsf.gov](https://www.nsf.gov/nobel))";
    const response = responsesResponseToAnthropicMessage({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt",
      status: "completed",
      output: [
        { id: "msg_ack_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: " ", annotations: [] }] },
        gptSearch("ws_0552abc"),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://www.nsf.gov/nobel", title: "NSF: 2026 Nobel", start_index: 20, end_index: text.length }] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    } as any);
    const content = response.content as Json[];
    assert.deepEqual(content.map((block) => block.type), ["server_tool_use", "web_search_tool_result", "text", "text"]);
    assert.deepEqual(content[0], {
      type: "server_tool_use",
      id: "srvtoolu_nanollm_ws_0552abc",
      name: "web_search",
      input: { query: "nobel 2026 physics", action: { type: "search", query: "nobel 2026 physics", queries: ["nobel 2026 physics"] } },
    });
    assert.deepEqual(content[1].content, [
      { type: "web_search_result", url: "https://www.nsf.gov/nobel", title: "NSF: 2026 Nobel", encrypted_content: WEB_SEARCH_MARKER, page_age: null },
      { type: "web_search_result", url: "https://kva.se/2026", title: "https://kva.se/2026", encrypted_content: WEB_SEARCH_MARKER, page_age: null },
    ]);
    assert.deepEqual(content[2], { type: "text", text: "Francis Halzen won. ", citations: null });
    assert.equal(content[3].text, "([nsf.gov](https://www.nsf.gov/nobel))");
    assert.deepEqual(content[3].citations, [{ type: "web_search_result_location", url: "https://www.nsf.gov/nobel", title: "NSF: 2026 Nobel", cited_text: "([nsf.gov](https://www.nsf.gov/nobel))", encrypted_index: WEB_SEARCH_MARKER }]);
    assert.deepEqual((response.usage as Json).server_tool_use, { web_search_requests: 1, web_fetch_requests: 0 });
  });

  run("citation ranges count code points, overlap and clamp to the text", () => {
    const text = "\u{1F52D}\u{1F30C} abc def";
    const blocks = splitTextByCitations(text, [
      { url: "https://a.example", title: "A", startIndex: 0, endIndex: 6 },
      { url: "https://b.example", title: "B", startIndex: 3, endIndex: 99 },
    ]) as Json[];
    assert.deepEqual(blocks.map((block) => block.text), ["\u{1F52D}\u{1F30C} ", "abc", " def"]);
    assert.deepEqual(blocks.map((block) => block.citations?.map((citation: Json) => citation.title) ?? null), [["A"], ["A", "B"], ["B"]]);
    assert.deepEqual(splitTextByCitations("plain", undefined), [{ type: "text", text: "plain", citations: null }]);
  });

  run("a gpt search shown to an anthropic client comes back as the same web_search_call", () => {
    const response = responsesResponseToAnthropicMessage({
      id: "resp_1", object: "response", created_at: 1, model: "gpt", status: "completed",
      output: [gptSearch("ws_0552abc"), gptAnswer()],
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    } as any);
    // The client echoes the assistant turn; the request converter rebuilds the native item.
    const replay = anthropicMessageRequestToResponsesRequest({
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "Who won?" }, { role: "assistant", content: response.content }, { role: "user", content: "Source?" }],
    } as any);
    const input = replay.input as Json[];
    assert.deepEqual(input[1], gptSearch("ws_0552abc"));
  });

  run("a gpt search shown to a chat client leaves just the answer text", () => {
    const chat = responsesResponseToChatCompletion({
      id: "resp_1", object: "response", created_at: 1, model: "gpt", status: "completed",
      output: [gptSearch("ws_0552abc"), gptAnswer()],
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    } as any);
    assert.equal(chat.choices[0].message.tool_calls, null);
    assert.match(String((chat.choices[0].message.content as Json[])[0].text), /^Francis Halzen won\./);
  });

  run("a blank acknowledgement message ahead of other output is dropped", () => {
    const blank = { id: "msg_ack", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: " ", annotations: [] }] };
    const alone = responsesResponseToAnthropicMessage({ id: "r", object: "response", created_at: 1, model: "gpt", status: "completed", output: [blank] } as any);
    assert.equal((alone.content as Json[]).length, 1);
    const withOther = responsesResponseToAnthropicMessage({ id: "r", object: "response", created_at: 1, model: "gpt", status: "completed", output: [blank, gptAnswer()] } as any);
    // The answer's citation splits it in two; the blank message adds nothing.
    assert.deepEqual((withOther.content as Json[]).map((block) => block.text), ["Francis Halzen won. ", "([nsf.gov](https://www.nsf.gov/nobel))"]);
  });

  run("native web search blocks in a claude stream are skipped, not turned into function calls", () => {
    const converter = createStreamConverter("anthropic", "openai-responses");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: "claude", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_01abc", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"nobel\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_01abc", content: claudeSearch()[1].content } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Halzen won." } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const out = [...events.flatMap((event) => converter.push(event as never)), ...converter.flush()] as Json[];
    assert.equal(out.some((event) => event.type?.includes("function_call") || event.item?.type === "function_call"), false);
    assert.equal(out.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "Halzen won.");
    const completed = out.find((event) => event.type === "response.completed");
    assert.deepEqual(completed?.response.output.map((item: Json) => item.type), ["message"]);
  });
}
