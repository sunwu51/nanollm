import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";

import {
  anthropicMessageRequestToChatParams,
  anthropicMessageRequestToResponsesRequest,
  anthropicMessageToChatCompletion,
  anthropicMessageToResponsesResponse,
  createSSEConverter,
  chatCompletionToResponsesResponse,
  chatCompletionToAnthropicMessage,
  chatParamsToAnthropicMessageRequest,
  chatParamsToResponsesRequest,
  responsesRequestToAnthropicMessageRequest,
  responsesRequestToChatParams,
  responsesResponseToAnthropicMessage,
  responsesResponseToChatCompletion,
} from "../src/converters/index.js";
import { getPublicModelNames, loadConfig, resolveFallbackModels } from "../src/config.js";
import { renderAdminConfigPage } from "../src/admin-config-page.js";
import { ConfigManager } from "../src/config-manager.js";
import { sortFallbackGroupMembers } from "../src/fallback.js";
import { getHTTPLogLevel, shouldEmitLog } from "../src/http-log.js";
import { passthroughRequest, passthroughStreamRequest } from "../src/proxy.js";
import { renderRecordPage } from "../src/record-page.js";
import { handleServerStartupError } from "../src/startup-error.js";
import {
  appendRecordedAttemptResponseBody,
  appendRecordedClientResponseBody,
  beginRecordedRequest,
  configureRecording,
  ensureRecordedAttempt,
  getRecordedRequest,
  getRecordSummary,
  setRecordedAttemptResponseBody,
  setRecordedAttemptResponseMeta,
  setRecordedClientResponseBody,
  setRecordedClientResponseMeta,
  setRecordedRequestError,
  startRecording,
  stopRecording,
} from "../src/record.js";
import { runWithRequestId } from "../src/request-context.js";
import { StatusStore, getHealthTone } from "../src/status.js";
import { shouldIgnoreStreamReadError } from "../src/stream-errors.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function runThrows(name: string, fn: () => void, expectedMessage: string) {
  run(name, () => {
    assert.throws(fn, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

async function runAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function withHTTPServer(
  handler: http.RequestListener,
  fn: (baseURL: string) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve test server address");
  }

  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function writeTempConfig(yaml: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), "nanollm-test-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, yaml);
  return file;
}

async function waitForCondition(check: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function parseSSEObjects(chunks: string[]): Array<{ event?: string; data: any }> {
  const text = chunks.join("");
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => block !== "data: [DONE]")
    .map((block) => {
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      return { event, data: JSON.parse(dataLines.join("\n")) };
    });
}

run("chat tool result becomes anthropic tool_result block", () => {
  const result = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Shanghai\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
  });

  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[2].role, "user");
  assert.equal((result.messages[2].content as Array<{ type: string }>)[0].type, "tool_result");
});

run("anthropic tool_result becomes chat tool message", () => {
  const result = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", caller: { type: "direct" }, name: "get_weather", input: { city: "Shanghai" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny" }] },
    ],
  });

  assert.equal(result.messages[2].role, "tool");
  assert.equal((result.messages[2] as { tool_call_id: string }).tool_call_id, "call_1");
});

run("anthropic messages request only keeps function tools and drops typed server/custom tools", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
      {
        name: "web_search",
        type: "web_search_20250305",
      },
      {
        name: "apply_patch",
        type: "custom",
        description: "Apply patch",
        input_schema: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    ],
    tool_choice: { type: "tool", name: "get_weather" },
  } as any);

  assert.equal(chat.tools?.length ?? 0, 1);
  assert.equal((chat.tools?.[0] as any).type, "function");
  assert.equal((chat.tools?.[0] as any).function.name, "get_weather");
  assert.deepEqual((chat as any).tool_choice, { type: "function", function: { name: "get_weather" } });
});

run("anthropic server tool history is downgraded to function-style chat history", () => {
  const result = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srv_1",
            caller: { type: "server" },
            name: "web_search",
            input: { query: "nanollm" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [
              {
                type: "web_search_result",
                title: "nanollm",
                url: "https://example.com/nanollm",
                encrypted_content: "enc_1",
                page_age: null,
              },
            ],
          },
        ],
      },
    ],
  } as any);

  assert.equal(result.messages[0].role, "assistant");
  assert.equal((result.messages[0].tool_calls?.[0] as any).type, "function");
  assert.equal((result.messages[0].tool_calls?.[0] as any).function.name, "web_search");
  assert.equal((result.messages[0].tool_calls?.[0] as any).function.arguments, "{\"query\":\"nanollm\"}");
  assert.equal(result.messages[1].role, "tool");
  assert.equal((result.messages[1] as any).tool_call_id, "srv_1");
  assert.match(String((result.messages[1] as any).content), /nanollm/);
  assert.match(String((result.messages[1] as any).content), /https:\/\/example\.com\/nanollm/);
});

run("responses tool output becomes anthropic tool_result block", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    input: [{ type: "function_call_output", call_id: "call_1", output: "Sunny" }],
  });

  assert.equal(result.messages[0].role, "user");
  assert.equal((result.messages[0].content as Array<{ type: string }>)[0].type, "tool_result");
});

run("responses namespace tools flatten to qualified function names", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: "hello",
    tools: [
      {
        type: "namespace",
        name: "mcp__mcpcenter__",
        description: "MCP Center tools",
        tools: [
          {
            type: "function",
            name: "calendar_get_events",
            description: "Get calendar events",
            parameters: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: "string" },
              },
              required: ["start", "end"],
            },
            strict: false,
          },
        ],
      },
    ],
  } as any);

  assert.equal(result.tools?.length ?? 0, 1);
  assert.equal((result.tools?.[0] as any).name, "mcp__mcpcenter__calendar_get_events");
});

run("responses non-mcp namespace tools stay unsupported in anthropic conversion", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: "hello",
    tools: [
      {
        type: "namespace",
        name: "crm",
        description: "CRM tools",
        tools: [
          {
            type: "function",
            name: "lookup_account",
            description: "Look up an account",
            parameters: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            strict: false,
          },
        ],
      },
    ],
  } as any);

  assert.equal(result.tools?.length ?? 0, 0);
});

run("responses namespace tool calls flatten to qualified function names", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        namespace: "mcp__mcpcenter__",
        name: "calendar_get_events",
        arguments: "{\"start\":\"2026-05-01\",\"end\":\"2026-05-02\"}",
      },
      { type: "function_call_output", call_id: "call_1", output: "[]" },
    ],
    tools: [
      {
        type: "namespace",
        name: "mcp__mcpcenter__",
        description: "MCP Center tools",
        tools: [
          {
            type: "function",
            name: "calendar_get_events",
            description: "Get calendar events",
            parameters: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: "string" },
              },
              required: ["start", "end"],
            },
            strict: false,
          },
        ],
      },
    ],
  } as any);

  assert.equal(result.messages[0].role, "assistant");
  assert.equal(((result.messages[0].content ?? []) as Array<{ type: string }>)[0].type, "tool_use");
  assert.equal(((result.messages[0].content ?? []) as Array<{ name?: string }>)[0].name, "mcp__mcpcenter__calendar_get_events");
});

run("anthropic qualified mcp tools become responses namespace tools", () => {
  const result = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "mcp__mcpcenter__calendar_get_events",
        description: "Get calendar events",
        input_schema: {
          type: "object",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
          },
          required: ["start", "end"],
        },
      },
    ],
  } as any);

  assert.equal((result.tools ?? []).length, 1);
  assert.equal((result.tools?.[0] as any).type, "namespace");
  assert.equal((result.tools?.[0] as any).name, "mcp__mcpcenter__");
  assert.equal(((result.tools?.[0] as any).tools ?? [])[0].name, "calendar_get_events");
});

run("anthropic qualified mcp tool use becomes responses namespaced function_call input", () => {
  const result = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            caller: { type: "direct" },
            name: "mcp__mcpcenter__calendar_get_events",
            input: { start: "2026-05-01", end: "2026-05-02" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "[]",
          },
        ],
      },
    ],
  } as any);

  const functionCall = ((result.input ?? []) as any[]).find((item) => item.type === "function_call");
  assert.ok(functionCall);
  assert.equal(functionCall.namespace, "mcp__mcpcenter__");
  assert.equal(functionCall.name, "calendar_get_events");
  assert.equal(functionCall.arguments, "{\"start\":\"2026-05-01\",\"end\":\"2026-05-02\"}");
});

run("responses anthropic conversion makes tool_use and tool_result adjacent", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: [
      { type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "*** Begin Patch\n*** End Patch\n" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "intermediate note",
          },
        ],
      },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "ok" },
    ],
  } as any);

  assert.equal(result.messages[0].role, "assistant");
  assert.equal(((result.messages[0].content ?? []) as Array<{ type: string }>)[0].type, "tool_use");
  assert.equal(result.messages[1].role, "user");
  assert.equal(((result.messages[1].content ?? []) as Array<{ type: string }>)[0].type, "tool_result");
  assert.equal(result.messages[2].role, "assistant");
  assert.equal(((result.messages[2].content ?? []) as Array<{ type: string; text?: string }>)[0].type, "text");
  assert.equal(((result.messages[2].content ?? []) as Array<{ type: string; text?: string }>)[0].text, "intermediate note");
  assert.equal(result.messages[3].role, "user");
  assert.equal(result.messages[3].content, "go on");
});

run("responses anthropic conversion appends empty user turn when input ends with assistant", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "assistant tail" }],
      },
    ],
  } as any);

  assert.equal(result.messages[0].role, "assistant");
  assert.equal(((result.messages[0].content ?? []) as Array<{ type: string; text?: string }>)[0].type, "text");
  assert.equal(((result.messages[0].content ?? []) as Array<{ type: string; text?: string }>)[0].text, "assistant tail");
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[1].content, "go on");
});

run("responses image tool output becomes anthropic image tool_result block", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    input: [{ type: "function_call_output", call_id: "call_img", output: [{ type: "input_image", image_url: "https://example.com/tool.png" }] }],
  } as any);

  const toolResult = (result.messages[0].content as Array<{ type: string; content: Array<{ type: string; source?: { url?: string } }> }>)[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.content[0].type, "image");
  assert.equal(toolResult.content[0].source?.url, "https://example.com/tool.png");
});

run("responses file tool output becomes anthropic document tool_result block", () => {
  const result = responsesRequestToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    input: [{ type: "function_call_output", call_id: "call_file", output: [{ type: "input_file", file_url: "https://example.com/tool.pdf", filename: "tool.pdf" }] }],
  } as any);

  const toolResult = (result.messages[0].content as Array<{ type: string; content: Array<{ type: string; title?: string; source?: { url?: string } }> }>)[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.content[0].type, "document");
  assert.equal(toolResult.content[0].title, "tool.pdf");
  assert.equal(toolResult.content[0].source?.url, "https://example.com/tool.pdf");
});

run("string content survives chat to responses to chat", () => {
  const responses = chatParamsToResponsesRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  });

  const chat = responsesRequestToChatParams(responses);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages[0].content, "hello");
});

run("responses instructions developer role becomes chat system role", () => {
  const chat = responsesRequestToChatParams({
    model: "gpt-5",
    instructions: "be terse",
    input: "hello",
  } as any);

  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "be terse");
});

run("responses developer input message becomes chat system role", () => {
  const chat = responsesRequestToChatParams({
    model: "gpt-5",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "legacy provider compatible" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
  } as any);

  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "legacy provider compatible");
  assert.equal(chat.messages[1].role, "user");
});

run("unsupported request fields are ignored instead of failing", () => {
  const chatToResponses = chatParamsToResponsesRequest({
    model: "gpt-4o-mini",
    frequency_penalty: 0.5,
    messages: [{ role: "user", content: "hello" }],
  } as any);
  assert.equal(chatToResponses.model, "gpt-4o-mini");

  const responsesToChat = responsesRequestToChatParams({
    model: "gpt-5",
    background: true,
    input: "hello",
  } as any);
  assert.equal(responsesToChat.model, "gpt-5");

  const anthropicToChat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    top_k: 5,
    messages: [{ role: "user", content: "hello" }],
  } as any);
  assert.equal(anthropicToChat.model, "claude-sonnet-4-5");
});

run("built-in tools are ignored instead of failing", () => {
  const chatToResponses = chatParamsToResponsesRequest({
    model: "gpt-5",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "web_search_preview" }],
    tool_choice: "auto",
  } as any);
  assert.equal(chatToResponses.tools?.length ?? 0, 0);

  const responsesToChat = responsesRequestToChatParams({
    model: "gpt-5",
    input: "hello",
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
  } as any);
  assert.equal(responsesToChat.tools?.length ?? 0, 0);
  assert.equal((responsesToChat as any).tool_choice, undefined);
});

run("responses custom tool call input is downgraded to function call with JSON arguments", () => {
  const chat = responsesRequestToChatParams({
    model: "gpt-5",
    input: [
      { type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "*** Begin Patch\n*** End Patch\n" },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "ok" },
    ],
  } as any);

  assert.equal(chat.messages[0].role, "assistant");
  assert.equal((chat.messages[0].tool_calls?.[0] as any).type, "function");
  assert.equal((chat.messages[0].tool_calls?.[0] as any).function.name, "apply_patch");
  assert.equal((chat.messages[0].tool_calls?.[0] as any).function.arguments, "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}");
  assert.equal(chat.messages[1].role, "tool");
  assert.equal((chat.messages[1] as any).tool_call_id, "call_custom");
});

run("chat custom tools are still ignored during normalization", () => {
  const chatToResponses = chatParamsToResponsesRequest({
    model: "gpt-5",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "custom", custom: { name: "apply_patch", description: "patch", format: { type: "grammar" } } },
      { type: "customer", custom: { name: "bad_tool", description: "bad", format: { type: "grammar" } } },
    ],
    tool_choice: { type: "custom", custom: { name: "apply_patch" } },
  } as any);
  assert.equal(chatToResponses.tools?.length ?? 0, 0);
  assert.equal((chatToResponses as any).tool_choice, undefined);
});

run("responses custom tools are converted to function tools during normalization", () => {
  const responsesToChat = responsesRequestToChatParams({
    model: "gpt-5",
    input: "hello",
    tools: [
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: /(.*)/" } },
      { type: "customer", name: "bad_tool", description: "bad", format: { type: "grammar" } },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
  } as any);
  assert.equal(responsesToChat.tools?.length ?? 0, 1);
  assert.equal((responsesToChat.tools?.[0] as any).type, "function");
  assert.equal((responsesToChat.tools?.[0] as any).function.name, "apply_patch");
  assert.deepEqual((responsesToChat.tools?.[0] as any).function.parameters, {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "lark grammar:\nstart: /(.*)/"},
    },
    required: ["content"],
  });
  assert.deepEqual((responsesToChat as any).tool_choice, { type: "function", function: { name: "apply_patch" } });
});

run("responses custom tool response is downgraded to function tool call", () => {
  const result = responsesResponseToChatCompletion({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-5",
    output: [{ type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "*** Begin Patch\n*** End Patch\n" }],
    tools: [],
    parallel_tool_calls: false,
    text: { format: { type: "text" } },
  } as any);

  assert.equal(result.choices[0].message.tool_calls?.[0].type, "function");
  assert.equal((result.choices[0].message.tool_calls?.[0] as any).function.arguments, "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}");
});

run("responses custom tools round-trip back to custom tool calls in responses output", () => {
  runWithRequestId("req_custom_roundtrip", () => {
    responsesRequestToChatParams({
      model: "gpt-5",
      input: "hello",
      tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar" } }],
      tool_choice: { type: "custom", name: "apply_patch" },
    } as any);

    const result = chatCompletionToResponsesResponse({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          logprobs: null,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_custom",
                type: "function",
                function: { name: "apply_patch", arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as any);

    assert.equal(result.output[0].type, "custom_tool_call");
    assert.equal((result.output[0] as any).name, "apply_patch");
    assert.equal((result.output[0] as any).input, "*** Begin Patch\n*** End Patch\n");
  });
});

run("chat stream restores converted custom tools in responses events", () => {
  runWithRequestId("req_custom_stream", () => {
    responsesRequestToChatParams({
      model: "gpt-5",
      input: "hello",
      tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar" } }],
      tool_choice: { type: "custom", name: "apply_patch" },
    } as any);

    const converter = createSSEConverter("openai-chat", "openai-responses");
    const chunks = [
      ...converter.push(
        [
          {
            id: "resp_custom_stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: "resp_custom_stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_custom_stream",
                      type: "function",
                      function: { name: "apply_patch", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "resp_custom_stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      ),
      ...converter.flush(),
    ];

    const events = parseSSEObjects(chunks);
    const deltaEvent = events.find((event) => event.event === "response.custom_tool_call_input.delta");
    const completed = events.find((event) => event.event === "response.completed");

    assert.ok(deltaEvent);
    assert.equal(deltaEvent?.data.delta, "*** Begin Patch\n*** End Patch\n");
    assert.ok(completed);
    assert.equal(completed?.data.response.output[0].type, "custom_tool_call");
    assert.equal(completed?.data.response.output[0].input, "*** Begin Patch\n*** End Patch\n");
  });
});

run("responses custom tool stream preserves windows paths through chat arguments", () => {
  const converter = createSSEConverter("openai-responses", "openai-chat");
  const input = "*** Begin Patch\n*** Update File: C:\\temp\\docs\\file.md\n*** End Patch\n";
  const chunks = [
    ...converter.push(
      [
        { type: "response.created", response: { id: "resp_windows_path", object: "response", created_at: 1, model: "gpt-5.4", status: "in_progress", output: [], usage: null } },
        { type: "response.output_item.added", output_index: 0, item: { id: "item_windows_path", type: "custom_tool_call", status: "in_progress", call_id: "call_windows_path", name: "apply_patch", input: "" }, sequence_number: 1 },
        { type: "response.custom_tool_call_input.delta", item_id: "item_windows_path", output_index: 0, delta: "*** Begin Patch\n*** Update File: C:\\temp\\", sequence_number: 2 },
        { type: "response.custom_tool_call_input.delta", item_id: "item_windows_path", output_index: 0, delta: "docs\\file.md\n*** End Patch\n", sequence_number: 3 },
        { type: "response.custom_tool_call_input.done", item_id: "item_windows_path", output_index: 0, name: "apply_patch", input, sequence_number: 4 },
        { type: "response.completed", response: { id: "resp_windows_path", object: "response", created_at: 1, model: "gpt-5.4", status: "completed", output: [{ id: "item_windows_path", type: "custom_tool_call", status: "completed", call_id: "call_windows_path", name: "apply_patch", input }], usage: null }, sequence_number: 5 },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const toolArgChunks = events
    .flatMap((event) => event.data.choices ?? [])
    .flatMap((choice: any) => choice.delta?.tool_calls ?? [])
    .map((toolCall: any) => toolCall.function?.arguments ?? "")
    .filter(Boolean);
  const argumentsText = toolArgChunks.join("");

  assert.equal(JSON.parse(argumentsText).content, input);
});

run("responses stream namespaced mcp function calls become qualified chat tool names", () => {
  const converter = createSSEConverter("openai-responses", "openai-chat");
  const argumentsText = "{\"start\":\"2026-05-01\",\"end\":\"2026-05-02\"}";
  const chunks = [
    ...converter.push(
      [
        { type: "response.created", response: { id: "resp_ns_stream", object: "response", created_at: 1, model: "gpt-5.4", status: "in_progress", output: [], usage: null } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "item_ns_stream",
            type: "function_call",
            status: "in_progress",
            call_id: "call_ns_stream",
            namespace: "mcp__mcpcenter__",
            name: "calendar_get_events",
            arguments: "",
          },
          sequence_number: 1,
        },
        { type: "response.function_call_arguments.delta", item_id: "item_ns_stream", output_index: 0, delta: argumentsText, sequence_number: 2 },
        { type: "response.function_call_arguments.done", item_id: "item_ns_stream", output_index: 0, name: "calendar_get_events", arguments: argumentsText, sequence_number: 3 },
        {
          type: "response.completed",
          response: {
            id: "resp_ns_stream",
            object: "response",
            created_at: 1,
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                id: "item_ns_stream",
                type: "function_call",
                status: "completed",
                call_id: "call_ns_stream",
                namespace: "mcp__mcpcenter__",
                name: "calendar_get_events",
                arguments: argumentsText,
              },
            ],
            usage: null,
          },
          sequence_number: 4,
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const toolName = events
    .flatMap((event) => event.data.choices ?? [])
    .flatMap((choice: any) => choice.delta?.tool_calls ?? [])
    .map((toolCall: any) => toolCall.function?.name)
    .find(Boolean);

  assert.equal(toolName, "mcp__mcpcenter__calendar_get_events");
});

run("anthropic stream qualified mcp tool_use becomes responses namespaced function_call events", () => {
  const converter = createSSEConverter("anthropic", "openai-responses");
  const argumentsText = "{\"start\":\"2026-05-01\",\"end\":\"2026-05-02\"}";
  const chunks = [
    ...converter.push(
      [
        {
          type: "message_start",
          message: {
            id: "msg_ns_stream",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "call_ns_stream",
            name: "mcp__mcpcenter__calendar_get_events",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: argumentsText,
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const added = events.find((event) => event.event === "response.output_item.added");
  const done = events.find((event) => event.event === "response.function_call_arguments.done");
  const completed = events.find((event) => event.event === "response.completed");

  assert.ok(added);
  assert.equal(added?.data.item.namespace, "mcp__mcpcenter__");
  assert.equal(added?.data.item.name, "calendar_get_events");
  assert.ok(done);
  assert.equal(done?.data.name, "calendar_get_events");
  assert.ok(completed);
  assert.equal(completed?.data.response.output[0].namespace, "mcp__mcpcenter__");
  assert.equal(completed?.data.response.output[0].name, "calendar_get_events");
  assert.equal(completed?.data.response.output[0].arguments, argumentsText);
});

run("chat stream restores wrapped custom tool windows paths exactly", () => {
  runWithRequestId("req_custom_stream_windows_path", () => {
    responsesRequestToChatParams({
      model: "gpt-5",
      input: "hello",
      tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar" } }],
      tool_choice: { type: "custom", name: "apply_patch" },
    } as any);

    const input = "*** Begin Patch\n*** Update File: C:\\temp\\docs\\file.md\n*** End Patch\n";
    const converter = createSSEConverter("openai-chat", "openai-responses");
    const chunks = [
      ...converter.push(
        [
          {
            id: "resp_custom_stream_windows_path",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: "resp_custom_stream_windows_path",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_custom_stream_windows_path",
                      type: "function",
                      function: { name: "apply_patch", arguments: "{\"content\":\"" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "resp_custom_stream_windows_path",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: "*** Begin Patch\\n*** Update File: C:\\\\temp\\\\" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "resp_custom_stream_windows_path",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.4",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: "docs\\\\file.md\\n*** End Patch\\n\"}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      ),
      ...converter.flush(),
    ];

    const events = parseSSEObjects(chunks);
    const deltaEvents = events.filter((event) => event.event === "response.custom_tool_call_input.delta");
    const completed = events.find((event) => event.event === "response.completed");

    assert.deepEqual(
      deltaEvents.map((event) => event.data.delta),
      ["*** Begin Patch\n*** Update File: C:\\temp\\", "docs\\file.md\n*** End Patch\n"],
    );
    assert.ok(completed);
    assert.equal(completed?.data.response.output[0].input, input);
  });
});

run("chat verbosity survives chat to responses to chat", () => {
  const responses = chatParamsToResponsesRequest({
    model: "gpt-5",
    verbosity: "low",
    messages: [{ role: "user", content: "hello" }],
  } as any);

  assert.equal((responses.text as any).verbosity, "low");

  const chat = responsesRequestToChatParams(responses);
  assert.equal((chat as any).verbosity, "low");
});

run("object content survives anthropic to responses conversion for images", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
      },
    ],
  });

  const first = (responses.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0];
  assert.equal(first.content[0].type, "input_image");
  assert.equal(first.content[0].image_url, "https://example.com/a.png");
});

run("anthropic document user content degrades to chat text instead of failing", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "document", title: "report.pdf", source: { type: "url", url: "https://example.com/report.pdf" } }],
      },
    ],
  });

  assert.equal(chat.messages[0].role, "user");
  assert.match(String(chat.messages[0].content), /report\.pdf/);
  assert.match(String(chat.messages[0].content), /https:\/\/example\.com\/report\.pdf/);
});

run("anthropic image user content stays chat multimodal array when image is enabled", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    image: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "请解释这张图" },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
    ],
  } as any);

  const content = (chat.messages[0] as any).content;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content[0], { type: "text", text: "请解释这张图" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: undefined } });
});

run("anthropic image user content degrades to chat string when image is disabled", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    image: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "请解释这张图" },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
    ],
  } as any);

  assert.equal((chat.messages[0] as any).content, "请解释这张图\nAttached image: https://example.com/cat.png");
});

run("chat completion response with tool_calls becomes anthropic tool_use response", () => {
  const result = chatCompletionToAnthropicMessage({
    id: "chat_1",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Shanghai\"}" } }],
        },
      },
    ],
  } as any);

  assert.equal(result.content[0].type, "tool_use");
});

run("responses response with tool call becomes chat completion tool_calls", () => {
  const result = responsesResponseToChatCompletion({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-4o-mini",
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output: [{ id: "call_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Shanghai\"}", status: "completed" }],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    text: { format: { type: "text" } },
  } as any);

  assert.equal(result.choices[0].message.tool_calls?.[0].type, "function");
});

run("chat stream tool call with stop finish_reason becomes responses tool_calls completion", () => {
  const converter = createSSEConverter("openai-chat", "openai-responses");
  const chunks = [
    ...converter.push(
      [
        {
          id: "resp_stream_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "resp_stream_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { reasoning_content: "Need to run a command first." }, finish_reason: null }],
        },
        {
          id: "resp_stream_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { content: "先直接运行 `whoami`。" }, finish_reason: null }],
        },
        {
          id: "resp_stream_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_stream_1",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":"whoami"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "resp_stream_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const reasoningDelta = events.find((event) => event.event === "response.reasoning_summary_text.delta");
  const completed = events.find((event) => event.event === "response.completed");

  assert.ok(reasoningDelta);
  assert.equal(reasoningDelta?.data.delta, "Need to run a command first.");
  assert.ok(completed);
  assert.equal(completed?.data.response.status, "completed");
  assert.equal(completed?.data.response.output[0].type, "reasoning");
  assert.equal(completed?.data.response.output[1].type, "message");
  assert.equal(completed?.data.response.output[2].type, "function_call");
  assert.equal(completed?.data.response.output[2].call_id, "call_stream_1");
});

run("chat stream tool arguments preserve trailing spaces when converted to responses", () => {
  const converter = createSSEConverter("openai-chat", "openai-responses");
  const toolArguments = JSON.stringify({
    file_path: "C:\\Users\\sunwu\\Desktop\\code\\TabManager\\src\\api\\llm.js",
    old_string: '    name: "stash_in_browser",a',
    new_string: '    name: "stash_in_browser",a  ',
  });
  const chunks = [
    ...converter.push(
      [
        {
          id: "resp_stream_trailing_spaces",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "resp_stream_trailing_spaces",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_trailing_spaces",
                    type: "function",
                    function: { name: "Edit", arguments: toolArguments.slice(0, -3) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "resp_stream_trailing_spaces",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: toolArguments.slice(-3) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const completed = events.find((event) => event.event === "response.completed");
  const outputArguments = completed?.data.response.output[0].arguments;

  assert.equal(outputArguments, toolArguments);
  assert.equal(JSON.parse(outputArguments).new_string, '    name: "stash_in_browser",a  ');
});

run("chat stream reasoning field is treated like reasoning_content", () => {
  const converter = createSSEConverter("openai-chat", "openai-responses");
  const chunks = [
    ...converter.push(
      [
        {
          id: "resp_stream_reasoning_field",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "resp_stream_reasoning_field",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { reasoning: "Need to think first." }, finish_reason: null }],
        },
        {
          id: "resp_stream_reasoning_field",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { content: "Final answer." }, finish_reason: "stop" }],
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const reasoningDelta = events.find((event) => event.event === "response.reasoning_summary_text.delta");
  const completed = events.find((event) => event.event === "response.completed");

  assert.ok(reasoningDelta);
  assert.equal(reasoningDelta?.data.delta, "Need to think first.");
  assert.ok(completed);
  assert.equal(completed?.data.response.output[0].type, "reasoning");
  assert.equal(completed?.data.response.output[1].type, "message");
});

run("chat stream carries usage from separate tail chunk after finish_reason", () => {
  const converter = createSSEConverter("openai-chat", "openai-responses");
  const chunks = [
    ...converter.push(
      [
        {
          id: "resp_stream_usage_tail",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "resp_stream_usage_tail",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_stream_usage_tail",
                    type: "function",
                    function: { name: "bash", arguments: "{\"command\":\"whoami\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          id: "resp_stream_usage_tail",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [],
          usage: { prompt_tokens: 543, completion_tokens: 57, total_tokens: 600 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const completed = events.find((event) => event.event === "response.completed");

  assert.ok(completed);
  assert.deepEqual(completed?.data.response.usage, {
    input_tokens: 543,
    output_tokens: 57,
    total_tokens: 600,
  });
  assert.equal(completed?.data.response.output[0].type, "function_call");
});

run("chat stream usage-only tail infers tool_calls when supplier omits finish_reason", () => {
  const converter = createSSEConverter("openai-chat", "openai-responses");
  const chunks = [
    ...converter.push(
      [
        {
          id: "resp_stream_2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "resp_stream_2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_stream_2",
                    type: "function",
                    function: { name: "glob", arguments: "{\"pattern\":\"src/**/*\"}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "resp_stream_2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
    ...converter.flush(),
  ];

  const events = parseSSEObjects(chunks);
  const completed = events.find((event) => event.event === "response.completed");

  assert.ok(completed);
  assert.equal(completed?.data.response.status, "completed");
  assert.equal(completed?.data.response.output[0].type, "function_call");
  assert.equal(completed?.data.response.output[0].call_id, "call_stream_2");
});

run("anthropic response with tool_use becomes chat completion tool_calls", () => {
  const result = anthropicMessageToChatCompletion({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    container: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [{ type: "tool_use", id: "call_1", caller: { type: "direct" }, name: "get_weather", input: { city: "Shanghai" } }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      service_tier: null,
      server_tool_use: null,
    },
  } as any);

  assert.equal(result.choices[0].message.tool_calls?.[0].type, "function");
});

run("anthropic response qualified mcp tool_use becomes responses namespaced function_call", () => {
  const result = anthropicMessageToResponsesResponse({
    id: "msg_mcp_tool_use",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    container: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [
      {
        type: "tool_use",
        id: "call_1",
        caller: { type: "direct" },
        name: "mcp__mcpcenter__calendar_get_events",
        input: { start: "2026-05-01", end: "2026-05-02" },
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      service_tier: null,
      server_tool_use: null,
    },
  } as any);

  assert.equal((result.output as any[]).length, 1);
  assert.equal((result.output[0] as any).type, "function_call");
  assert.equal((result.output[0] as any).namespace, "mcp__mcpcenter__");
  assert.equal((result.output[0] as any).name, "calendar_get_events");
  assert.equal((result.output[0] as any).arguments, "{\"start\":\"2026-05-01\",\"end\":\"2026-05-02\"}");
});

run("anthropic tool_result block array becomes chat tool text", () => {
  const result = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "Sunny" }, { type: "text", text: "25C" }],
          },
        ],
      },
    ],
  });

  assert.equal(result.messages[0].role, "tool");
  assert.equal((result.messages[0] as { content: string }).content, "Sunny\n25C");
});

run("anthropic image tool_result becomes chat user multimodal fallback when image is enabled", () => {
  const result = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    image: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_img", caller: { type: "direct" }, name: "view_image", input: { path: "/tmp/a.png" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_img",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/tool.png" } }],
          },
        ],
      },
    ],
  } as any);

  const fallback = result.messages[1] as { role: string; content: Array<{ type: string; text?: string; image_url?: { url?: string } }> };
  assert.equal(fallback.role, "user");
  assert.equal(fallback.content[0].type, "text");
  assert.match(fallback.content[0].text ?? "", /Tool result for call_img/);
  assert.equal(fallback.content[1].type, "image_url");
  assert.equal(fallback.content[1].image_url?.url, "https://example.com/tool.png");
});

run("anthropic image tool_result becomes chat user string fallback when image is disabled", () => {
  const result = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    image: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_img", caller: { type: "direct" }, name: "view_image", input: { path: "/tmp/a.png" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_img",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/tool.png" } }],
          },
        ],
      },
    ],
  } as any);

  const fallback = result.messages[1] as { role: string; content: string };
  assert.equal(fallback.role, "user");
  assert.match(fallback.content, /Tool result for call_img/);
  assert.match(fallback.content, /Attached image: https:\/\/example\.com\/tool\.png/);
});

run("chat tool result round-trip through anthropic preserves tool id", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_roundtrip",
            type: "function",
            function: { name: "lookup", arguments: "{\"q\":\"weather\"}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_roundtrip",
        content: "result text",
      },
    ],
  });

  const chat = anthropicMessageRequestToChatParams(anthropic);
  assert.equal((chat.messages[0] as { tool_calls: Array<{ id: string }> }).tool_calls[0].id, "call_roundtrip");
  assert.equal((chat.messages[1] as { tool_call_id: string }).tool_call_id, "call_roundtrip");
});

run("responses function call output round-trip through anthropic preserves call id", () => {
  const anthropic = responsesRequestToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    input: [{ type: "function_call_output", call_id: "resp_call", output: "ok" }],
  });

  const responses = anthropicMessageRequestToResponsesRequest(anthropic);
  assert.equal((responses.input as Array<{ call_id: string }>)[0].call_id, "resp_call");
});

run("anthropic image tool_result becomes responses image tool output", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "img_resp",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/from-anthropic.png" } }],
          },
        ],
      },
    ],
  });

  const output = (responses.input as Array<{ type: string; output: Array<{ type: string; image_url?: string }> }>)[0];
  assert.equal(output.type, "function_call_output");
  assert.equal(output.output[0].type, "input_image");
  assert.equal(output.output[0].image_url, "https://example.com/from-anthropic.png");
});

run("anthropic document tool_result becomes responses file tool output", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "file_resp",
            content: [{ type: "document", title: "report.pdf", source: { type: "url", url: "https://example.com/report.pdf" } }],
          },
        ],
      },
    ],
  });

  const output = (responses.input as Array<{ type: string; output: Array<{ type: string; file_url?: string; filename?: string }> }>)[0];
  assert.equal(output.type, "function_call_output");
  assert.equal(output.output[0].type, "input_file");
  assert.equal(output.output[0].file_url, "https://example.com/report.pdf");
  assert.equal(output.output[0].filename, "report.pdf");
});

run("chat parallel_tool_calls false survives anthropic conversion without explicit tool_choice", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    parallel_tool_calls: false,
    messages: [{ role: "user", content: "weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ],
  });

  assert.equal((anthropic.tool_choice as any).type, "auto");
  assert.equal((anthropic.tool_choice as any).disable_parallel_tool_use, true);

  const chat = anthropicMessageRequestToChatParams(anthropic);
  assert.equal(chat.parallel_tool_calls, false);
});

run("anthropic request tools omit strict field", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, additionalProperties: false },
          strict: true,
        },
      },
    ],
  });

  assert.equal((anthropic.tools?.[0] as any).strict, undefined);
  assert.equal(((anthropic.tools?.[0] as any).input_schema ?? {}).additionalProperties, false);
});

run("anthropic disable_parallel_tool_use becomes responses parallel_tool_calls false", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [{ role: "user", content: "hi" }],
  } as any);

  assert.equal(responses.parallel_tool_calls, false);
});

run("chat response round-trip through anthropic preserves tool call name", () => {
  const anthropic = chatCompletionToAnthropicMessage({
    id: "chat_rt",
    object: "chat.completion",
    created: 2,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "calling tool" }],
          refusal: null,
          tool_calls: [
            {
              id: "call_resp_rt",
              type: "function",
              function: { name: "lookup", arguments: "{\"q\":\"weather\"}" },
            },
          ],
        },
      },
    ],
  } as any);

  const chat = anthropicMessageToChatCompletion(anthropic);
  assert.equal((chat.choices[0].message.tool_calls?.[0] as any).function.name, "lookup");
});

run("anthropic request thinking block is preserved in responses request without encrypted content", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should call the weather tool.",
            signature: "sig_1",
          },
          {
            type: "text",
            text: "Let me check.",
          },
        ],
      },
    ],
  });

  const input = responses.input as Array<{ type: string }>;
  assert.equal(input.length, 2);
  assert.equal(input[0].type, "reasoning");
  assert.deepEqual((input[0] as any).summary, [{ type: "summary_text", text: "I should call the weather tool." }]);
  assert.deepEqual((input[0] as any).content, [{ type: "reasoning_text", text: "I should call the weather tool." }]);
  assert.equal((input[0] as any).encrypted_content, undefined);
  assert.equal(input[1].type, "message");
  assert.equal((input[1] as any).content[0].text, "Let me check.");
});

run("anthropic response thinking block is preserved in responses response without encrypted content", () => {
  const responses = anthropicMessageToResponsesResponse({
    id: "msg_thinking",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "thinking",
        thinking: "Need to reason first.",
        signature: "sig_resp",
      },
      {
        type: "text",
        text: "final answer",
        citations: null,
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      service_tier: null,
      server_tool_use: null,
    },
  } as any);

  assert.equal((responses.output as any[]).length, 2);
  assert.equal((responses.output[0] as any).type, "reasoning");
  assert.deepEqual((responses.output[0] as any).summary, [{ type: "summary_text", text: "Need to reason first." }]);
  assert.deepEqual((responses.output[0] as any).content, [{ type: "reasoning_text", text: "Need to reason first." }]);
  assert.equal((responses.output[0] as any).encrypted_content, undefined);
  assert.equal((responses.output[1] as any).type, "message");
  assert.equal(((responses.output[1] as any).content[0] ?? {}).text, "final answer");
});

run("responses request reasoning block preserves plaintext and drops encrypted content in anthropic request", () => {
  const anthropic = responsesRequestToAnthropicMessageRequest({
    model: "gpt-5",
    input: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "internal summary" }],
        content: [{ type: "reasoning_text", text: "internal detail" }],
        encrypted_content: "enc_1",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible answer" }],
      },
    ],
  } as any);

  assert.equal((anthropic.messages as any[]).length, 2);
  assert.equal(((anthropic.messages[0] as any).content ?? [])[0].type, "thinking");
  assert.equal(((anthropic.messages[0] as any).content ?? [])[0].thinking, "internal summary");
  assert.equal(((anthropic.messages[0] as any).content ?? [])[1].type, "thinking");
  assert.equal(((anthropic.messages[0] as any).content ?? [])[1].thinking, "internal detail");
  assert.equal(((anthropic.messages[0] as any).content ?? [])[2].type, "text");
  assert.equal(((anthropic.messages[0] as any).content ?? [])[2].text, "visible answer");
  assert.equal((anthropic.messages[1] as any).role, "user");
  assert.equal((anthropic.messages[1] as any).content, "go on");
});

run("anthropic assistant thinking block becomes top-level chat reasoning fields", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal detail", signature: "sig_1" },
          { type: "text", text: "visible answer" },
        ],
      },
      { role: "user", content: "go on" },
    ],
  } as any);

  const assistant = chat.messages[0] as any;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "visible answer");
  assert.equal(assistant.thinking, "internal detail");
  assert.equal(assistant.reasoning, "internal detail");
  assert.equal(assistant.reasoning_content, "internal detail");
  assert.equal(assistant.tool_calls, null);
});

run("image disabled chat assistant without thinking gets empty reasoning_content placeholder", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    image: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
      },
      { role: "user", content: "go on" },
    ],
  } as any);

  const assistant = chat.messages[0] as any;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "visible answer");
  assert.equal(assistant.reasoning_content, "");
  assert.equal(assistant.thinking, "");
  assert.equal(assistant.reasoning, "");
});

run("chat assistant top-level reasoning fields survive anthropic round-trip", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: "visible answer",
        thinking: "internal detail",
        reasoning: "internal detail",
        reasoning_content: "internal detail",
      } as any,
      { role: "user", content: "go on" },
    ],
  });

  const assistant = (anthropic.messages as any[])[0];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content[0].type, "thinking");
  assert.equal(assistant.content[0].thinking, "internal detail");
  assert.equal(assistant.content[1].type, "text");
  assert.equal(assistant.content[1].text, "visible answer");
});

run("responses response reasoning block preserves plaintext and drops encrypted content in anthropic response", () => {
  const anthropic = responsesResponseToAnthropicMessage({
    id: "resp_reasoning",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-5",
    output: [
      {
        id: "reasoning_0",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "internal summary" }],
        content: [{ type: "reasoning_text", text: "internal detail" }],
        encrypted_content: "enc_1",
        status: "completed",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "visible answer", annotations: [] }],
      },
    ],
    tools: [],
    parallel_tool_calls: false,
    text: { format: { type: "text" } },
  } as any);

  assert.equal((anthropic.content as any[]).length, 3);
  assert.equal((anthropic.content[0] as any).type, "thinking");
  assert.equal((anthropic.content[0] as any).thinking, "internal detail");
  assert.equal((anthropic.content[1] as any).type, "thinking");
  assert.equal((anthropic.content[1] as any).thinking, "internal summary");
  assert.equal((anthropic.content[2] as any).type, "text");
  assert.equal((anthropic.content[2] as any).text, "visible answer");
});

run("anthropic response usage total includes cache read and write when converted to responses", () => {
  const responses = anthropicMessageToResponsesResponse({
    id: "msg_usage_total",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "text",
        text: "ok",
        citations: null,
      },
    ],
    usage: {
      input_tokens: 300,
      output_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 500,
      server_tool_use: null,
    },
  } as any);

  assert.deepEqual((responses as any).usage, {
    input_tokens: 1000,
    output_tokens: 100,
    total_tokens: 1100,
    input_tokens_details: { cached_tokens: 500 },
  });
});

run("openai chat usage keeps anthropic non-cache input separate when converted", () => {
  const anthropic = chatCompletionToAnthropicMessage({
    id: "chat_usage_total",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: "ok",
          refusal: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 600 },
      prompt_cache_hit_tokens: 600,
    },
  } as any);

  assert.deepEqual((anthropic as any).usage, {
    input_tokens: 400,
    output_tokens: 200,
    cache_read_input_tokens: 600,
    server_tool_use: null,
  });
});

run("anthropic thinking budget 4000 maps to chat medium reasoning_effort", () => {
  const chat = anthropicMessageRequestToChatParams({
    model: "claude-sonnet-4-5",
    max_tokens: 12000,
    thinking: { type: "enabled", budget_tokens: 4000 },
    messages: [{ role: "user", content: "hi" }],
  } as any);

  assert.equal(chat.reasoning_effort, "medium");
});

run("anthropic thinking budget 4000 maps to responses medium reasoning.effort", () => {
  const responses = anthropicMessageRequestToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 12000,
    thinking: { type: "enabled", budget_tokens: 4000 },
    messages: [{ role: "user", content: "hi" }],
  } as any);

  assert.deepEqual((responses as any).reasoning, { effort: "medium" });
});

run("chat medium reasoning maps to anthropic adaptive thinking", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    reasoning_effort: "medium",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(anthropic.max_tokens, 10240);
  assert.deepEqual((anthropic as any).thinking, { type: "adaptive" });
});

run("chat high reasoning maps to anthropic adaptive thinking with explicit max_tokens", () => {
  const anthropic = chatParamsToAnthropicMessageRequest({
    model: "gpt-4o-mini",
    reasoning_effort: "high",
    max_completion_tokens: 5000,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(anthropic.max_tokens, 5000);
  assert.deepEqual((anthropic as any).thinking, { type: "adaptive" });
});

run("config uses default ttfb_timeout when server section is omitted", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  try {
    const config = loadConfig(configPath);
    assert.equal(config.port, 3000);
    assert.equal(config.ttfb_timeout, 5000);
    assert.equal(config.models[0].ttfb_timeout, 5000);
    assert.equal(config.models[0].image, true);
    assert.equal(config.record.max_size, 10);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("config respects model image flag", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
    image: false
`);

  try {
    const config = loadConfig(configPath);
    assert.equal(config.models[0].image, false);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("config applies server-level ttfb_timeout and model override", () => {
  const configPath = writeTempConfig(`
server:
  port: 3000
  ttfb_timeout: 1500

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta
    ttfb_timeout: 2500
`);

  try {
    const config = loadConfig(configPath);
    assert.equal(config.ttfb_timeout, 1500);
    assert.equal(config.models[0].ttfb_timeout, 1500);
    assert.equal(config.models[1].ttfb_timeout, 2500);
    assert.equal(config.record.max_size, 10);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("config allows overriding record max_size", () => {
  const configPath = writeTempConfig(`
record:
  max_size: 100

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  try {
    const config = loadConfig(configPath);
    assert.equal(config.record.max_size, 100);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("fallback group name is exposed as public model and resolves only by exact group name", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta
fallback:
  group-a:
    - alpha
    - beta
`);

  try {
    const config = loadConfig(configPath);
    assert.deepEqual(getPublicModelNames(config), ["group-a", "alpha", "beta"]);
    assert.deepEqual(resolveFallbackModels(config, "group-a"), ["alpha", "beta"]);
    assert.deepEqual(resolveFallbackModels(config, "alpha"), ["alpha"]);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("config allows the same model in multiple fallback groups", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta
  - name: gamma
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-gamma
fallback:
  group-a:
    - alpha
    - beta
  group-b:
    - beta
    - gamma
`);

  try {
    const config = loadConfig(configPath);
    assert.deepEqual(resolveFallbackModels(config, "group-a"), ["alpha", "beta"]);
    assert.deepEqual(resolveFallbackModels(config, "group-b"), ["beta", "gamma"]);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

runThrows("config rejects duplicate fallback group and model names", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
fallback:
  alpha:
    - alpha
`);

  try {
    loadConfig(configPath);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
}, "Duplicate public model name 'alpha'");

runThrows("config rejects duplicate model names inside the same fallback group", () => {
  const configPath = writeTempConfig(`
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta
fallback:
  group-a:
    - alpha
    - beta
    - alpha
`);

  try {
    loadConfig(configPath);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
}, "Fallback group 'group-a' contains duplicate model 'alpha'");

run("fallback group members prefer lower recent failure counts, then original order", () => {
  const ordered = sortFallbackGroupMembers(["alpha", "beta", "gamma", "delta"], (name) => {
    switch (name) {
      case "alpha":
        return 2;
      case "beta":
        return 5;
      case "gamma":
        return 5;
      case "delta":
        return 1;
      default:
        return 0;
    }
  });

  assert.deepEqual(ordered, ["delta", "alpha", "beta", "gamma"]);
});

run("fallback group members tolerate one failure before changing priority", () => {
  const ordered = sortFallbackGroupMembers(["alpha", "beta", "gamma", "delta"], (name) => {
    switch (name) {
      case "alpha":
        return 1;
      case "beta":
        return 0;
      case "gamma":
        return 2;
      case "delta":
        return 3;
      default:
        return 0;
    }
  });

  assert.deepEqual(ordered, ["alpha", "beta", "gamma", "delta"]);
});

runThrows("config rejects invalid ttfb_timeout values", () => {
  const configPath = writeTempConfig(`
server:
  ttfb_timeout: 0

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  try {
    loadConfig(configPath);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
}, "'server.ttfb_timeout' must be a positive number");

runThrows("config rejects invalid record.max_size values", () => {
  const configPath = writeTempConfig(`
record:
  max_size: 0

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  try {
    loadConfig(configPath);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
}, "'record.max_size' must be a positive integer");

run("config manager hot-reloads models, fallback, ttfb_timeout and record max_size while keeping port pending restart", () => {
  const configPath = writeTempConfig(`
server:
  port: 3000
  ttfb_timeout: 1500

record:
  max_size: 10

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha

fallback:
  primary:
    - alpha
`);

  const manager = new ConfigManager(configPath);
  try {
    const result = manager.applyText(`
server:
  port: 4000
  ttfb_timeout: 2600

record:
  max_size: 25

models:
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta

fallback:
  primary:
    - beta
`, "ui");

    assert.deepEqual(result.appliedFields, ["models", "fallback", "server.ttfb_timeout", "record.max_size"]);
    assert.deepEqual(result.requiresRestartFields, ["server.port"]);
    assert.equal(result.snapshot.effectiveConfig.port, 3000);
    assert.equal(result.snapshot.effectiveConfig.ttfb_timeout, 2600);
    assert.equal(result.snapshot.effectiveConfig.record.max_size, 25);
    assert.equal(result.snapshot.effectiveConfig.models[0].name, "beta");
    assert.equal(result.snapshot.effectiveConfig.models[0].ttfb_timeout, 2600);
    assert.deepEqual(result.snapshot.effectiveConfig.fallback, { primary: ["beta"] });
  } finally {
    manager.dispose();
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

run("config manager keeps last valid config when new text is invalid", () => {
  const configPath = writeTempConfig(`
server:
  port: 3000

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  const manager = new ConfigManager(configPath);
  try {
    assert.throws(() => {
      manager.applyText(`
models:
  - name: broken
    provider: invalid-provider
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-broken
`, "ui");
    }, /invalid provider/);

    const snapshot = manager.getActiveSnapshot();
    assert.equal(snapshot.effectiveConfig.models[0].name, "alpha");
    assert.match(snapshot.rawText, /invalid-provider/);
    assert.ok(snapshot.lastError);
    assert.match(snapshot.lastError?.message ?? "", /invalid provider/);
  } finally {
    manager.dispose();
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

runAsync("config manager watcher applies external file changes", async () => {
  const configPath = writeTempConfig(`
server:
  port: 3000

record:
  max_size: 10

models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-alpha
`);

  const manager = new ConfigManager(configPath);
  try {
    writeFileSync(configPath, `
server:
  port: 3010
  ttfb_timeout: 2200

record:
  max_size: 6

models:
  - name: beta
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: test-key
    model: upstream-beta
`, "utf-8");

    await waitForCondition(() => manager.getActiveSnapshot().version > 1);

    const snapshot = manager.getActiveSnapshot();
    assert.equal(snapshot.effectiveConfig.port, 3000);
    assert.equal(snapshot.effectiveConfig.ttfb_timeout, 2200);
    assert.equal(snapshot.effectiveConfig.record.max_size, 6);
    assert.equal(snapshot.effectiveConfig.models[0].name, "beta");
    assert.deepEqual(snapshot.requiresRestartFields, ["server.port"]);
  } finally {
    manager.dispose();
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

await runAsync("upstream request fails when first byte exceeds ttfb_timeout", async () => {
  await withHTTPServer(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseURL) => {
    await assert.rejects(
      passthroughRequest({
        name: "alpha",
        provider: "openai-chat",
        base_url: baseURL,
        api_key: "test-key",
        model: "upstream-alpha",
        ttfb_timeout: 30,
      }, {
        model: "alpha",
        messages: [{ role: "user", content: "hello" }],
      }),
      /Upstream TTFB timeout after 30ms/,
    );
  });
});

await runAsync("stream request only enforces ttfb_timeout until response starts", async () => {
  await withHTTPServer(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    res.end("data: done\n\n");
  }, async (baseURL) => {
    const startedAt = Date.now();
    const result = await passthroughStreamRequest({
      name: "alpha",
      provider: "openai-chat",
      base_url: baseURL,
      api_key: "test-key",
      model: "upstream-alpha",
      ttfb_timeout: 30,
    }, {
      model: "alpha",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    assert.ok(Date.now() - startedAt < 70);
    assert.ok(result.body);
    assert.ok(result.timing.ttfbMs >= 0);
    const reader = result.body.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) chunks.push(tail);
    } finally {
      reader.releaseLock();
    }

    assert.equal(chunks.join(""), "data: first\n\ndata: done\n\n");
  });
});

run("status store aggregates success rate and averages by five-minute bucket", () => {
  const store = new StatusStore();
  const bucketStart = Date.UTC(2026, 3, 19, 4, 0, 0);

  store.recordAttempt("alpha", bucketStart + 5_000);
  store.recordSuccess("alpha", 120, 40, {
    nonCacheInputTokens: 1200,
    cacheReadInputTokens: 300,
    outputTokens: 450,
  }, bucketStart + 5_000);
  store.recordAttempt("alpha", bucketStart + 60_000);
  store.recordFailure("alpha", 300, bucketStart + 60_000);

  const cell = store.getModelSeries("alpha", bucketStart + 60_000).at(-1);
  assert.ok(cell);
  assert.equal(cell.totalRequests, 2);
  assert.equal(cell.successRequests, 1);
  assert.equal(Math.round(cell.successRate), 50);
  assert.equal(cell.avgTtfbMs, 40);
  assert.equal(cell.avgDurationMs, 210);
  assert.equal(cell.nonCacheInputTokens, 1200);
  assert.equal(cell.cacheReadInputTokens, 300);
  assert.equal(cell.outputTokens, 450);
  assert.equal(getHealthTone(cell.successRate, cell.totalRequests), "orange");
});

run("status store keeps only the last 6 hours of buckets", () => {
  const store = new StatusStore();
  const now = Date.UTC(2026, 3, 19, 23, 55, 0);
  const expired = now - (6 * 60 * 60 * 1000) - (5 * 60 * 1000);

  store.recordAttempt("alpha", expired);
  store.recordSuccess("alpha", 100, 20, undefined, expired);
  store.recordAttempt("alpha", now);
  store.recordSuccess("alpha", 200, 30, undefined, now);

  const series = store.getModelSeries("alpha", now);
  assert.equal(series.length, 72);
  assert.equal(series.some((cell) => cell.bucketStart === expired && cell.totalRequests > 0), false);
  assert.equal(series.at(-1)?.totalRequests, 1);
});

run("record store resets on start and supports full request id lookup", () => {
  startRecording();
  const requestId = "abcdef12-3456-7890-abcd-ef1234567890";
  assert.equal(
    beginRecordedRequest({
      requestId,
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer top-secret", "X-Test": "ok", "User-Agent": "claude-cli/1.0" },
      body: { model: "alpha", messages: [{ role: "user", content: "hello" }] },
      stream: false,
    }),
    true,
  );
  ensureRecordedAttempt({
    requestId,
    index: 1,
    provider: "openai-chat",
    modelName: "alpha",
    url: "https://example.com/v1/chat/completions",
    requestHeaders: { Authorization: "Bearer top-secret" },
    requestBody: JSON.stringify({ model: "upstream-alpha", stream: false }),
  });
  setRecordedAttemptResponseMeta({
    requestId,
    index: 1,
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  setRecordedAttemptResponseBody({
    requestId,
    index: 1,
    body: JSON.stringify({ id: "chatcmpl_1", choices: [] }),
  });
  setRecordedClientResponseMeta({
    requestId,
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  setRecordedClientResponseBody({
    requestId,
    body: { id: "chatcmpl_1", choices: [] },
  });

  const record = getRecordedRequest(requestId);
  assert.ok(record);
  assert.equal(getRecordedRequest("abcdef")?.requestId, requestId);
  assert.equal(getRecordedRequest("requestId=abcdef")?.requestId, requestId);
  assert.equal(record?.clientRequest.headers.Authorization, "[REDACTED]");
  assert.equal(record?.attempts[0].request.headers?.Authorization, "[REDACTED]");
  assert.equal(record?.clientRequest.model, "alpha");
  assert.equal(record?.clientRequest.actualModel, "alpha");
  assert.equal(record?.clientRequest.source, "claudecode");
  assert.equal(record?.clientRequest.status, "success");
  assert.deepEqual(record?.attempts[0].request.body, { model: "upstream-alpha", stream: false });
  assert.deepEqual(record?.attempts[0].response.body, { id: "chatcmpl_1", choices: [] });

  const summary = getRecordSummary();
  assert.equal(summary.recentKeys[0]?.model, "alpha");
  assert.equal(summary.recentKeys[0]?.actualModel, "alpha");
  assert.equal(summary.recentKeys[0]?.source, "claudecode");
  assert.equal(summary.recentKeys[0]?.status, "success");

  stopRecording();
});

run("record summary keeps fallback actual model and failure status", () => {
  startRecording();
  const requestId = "fedcba98-7654-3210-abcd-ef1234567890";
  beginRecordedRequest({
    requestId,
    path: "/v1/responses",
    headers: { "User-Agent": "codex/1.0" },
    body: { model: "group-model", input: "hello" },
    stream: false,
  });
  ensureRecordedAttempt({
    requestId,
    index: 1,
    provider: "openai-responses",
    modelName: "fallback-alpha",
    url: "https://example.com/v1/responses",
    requestHeaders: {},
    requestBody: JSON.stringify({ model: "fallback-alpha", stream: false }),
  });
  setRecordedRequestError({ requestId, message: "boom" });

  const summary = getRecordSummary();
  assert.equal(summary.recentKeys[0]?.model, "group-model");
  assert.equal(summary.recentKeys[0]?.actualModel, "fallback-alpha");
  assert.equal(summary.recentKeys[0]?.source, "codex");
  assert.equal(summary.recentKeys[0]?.status, "failure");
  stopRecording();
});

run("record store only captures the first 10 requests by default", () => {
  startRecording();
  for (let index = 0; index < 11; index += 1) {
    beginRecordedRequest({
      requestId: `${String(index).padStart(6, "0")}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      path: "/v1/chat/completions",
      headers: {},
      body: { model: "alpha" },
      stream: false,
    });
  }
  assert.equal(getRecordSummary().capturedCount, 10);
  assert.equal(getRecordSummary().size, 10);
  assert.equal(getRecordedRequest("000000"), undefined);
  stopRecording();
});

run("record store allows overriding max size when starting", () => {
  startRecording({ maxSize: 100 });
  for (let index = 0; index < 101; index += 1) {
    beginRecordedRequest({
      requestId: `${String(index).padStart(6, "0")}-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee`,
      path: "/v1/chat/completions",
      headers: {},
      body: { model: "alpha" },
      stream: false,
    });
  }
  assert.equal(getRecordSummary().capturedCount, 100);
  assert.equal(getRecordSummary().size, 100);
  assert.equal(getRecordedRequest("000000"), undefined);
  stopRecording();
});

run("record page renders query UI and JSON tree viewer", () => {
  const html = renderRecordPage({
    enabled: true,
    capturedCount: 3,
    limit: 100,
    sessionStartedAt: Date.UTC(2026, 3, 20, 10, 0, 0),
    recentKeys: [{ key: "abcdef", requestId: "abcdef12-3456", path: "/v1/chat/completions", model: "claude-sonnet-4-6", actualModel: "claude-sonnet-4-6-lite", source: "claudecode", status: "success", createdAt: Date.UTC(2026, 3, 20, 10, 0, 1) }],
  });
  assert.match(html, /Request Record/);
  assert.match(html, /fetch\("\/record\/summary"/);
  assert.match(html, /createValueNode/);
  assert.match(html, /createCollapsibleSection/);
  assert.match(html, /createStringNode/);
  assert.match(html, /parseStreamEvents/);
  assert.match(html, /renderStreamBody/);
  assert.match(html, /createCopyButton/);
  assert.match(html, /复制合并 JSON/);
  assert.match(html, /box-actions/);
  assert.match(html, /setInterval\(\(\) =>/);
  assert.match(html, /fetch\("\/record\/summary"/);
  assert.match(html, /normalizeRequestIdInput/);
  assert.match(html, /id="record-panel"/);
  assert.match(html, /class="panel recording"/);
  assert.match(html, /\.panel::before/);
  assert.match(html, /repeating-linear-gradient\(90deg, var\(--recording\) 0 8px, transparent 8px 14px\)/);
  assert.match(html, /record-border-crawl/);
  assert.match(html, /background-position:/);
  assert.doesNotMatch(html, /recording-border/);
  assert.match(html, /classList\.toggle\("recording", true\)/);
  assert.match(html, /list="request-id-options"/);
  assert.match(html, /placeholder="例如 6dfae2"/);
  assert.match(html, /grid-template-columns: 1fr/);
  assert.match(html, /recent-key/);
  assert.match(html, /recent-toggle/);
  assert.match(html, /recent-title-row/);
  assert.match(html, /recent-title/);
  assert.match(html, /recent-model-row/);
  assert.match(html, /recent-model/);
  assert.match(html, /source-badge/);
  assert.match(html, /source-badge\.claudecode/);
  assert.match(html, /source-badge\.codex/);
  assert.match(html, /source-badge\.opencode/);
  assert.match(html, /source-badge\.other/);
  assert.match(html, /status-badge/);
  assert.match(html, /width: 260px/);
  assert.match(html, /color: #2f5cb8/);
  assert.match(html, /color: #1f1f1f/);
  assert.match(html, /getSourceBadgeLabel/);
  assert.match(html, /getStatusLabel/);
  assert.match(html, /return "CC"/);
  assert.match(html, /return "Codex"/);
  assert.match(html, /return "OpenCode"/);
  assert.match(html, /return "Other"/);
  assert.match(html, /return "成功"/);
  assert.match(html, /return "失败"/);
  assert.match(html, /return "请求中\.\.\."/);
  assert.match(html, /titleRow\.className = "recent-title-row"/);
  assert.match(html, /title\.className = "recent-title"/);
  assert.match(html, /sourceBadge\.className = "source-badge " \+ item\.source/);
  assert.match(html, /statusBadge\.className = getStatusBadgeClass\(item\)/);
  assert.match(html, /actualModel\.textContent = "-> " \+ \(item\.actualModel \|\| "-"\)/);
  assert.match(html, /meta\.textContent = item\.path \+ " · " \+ new Date\(item\.createdAt\)\.toLocaleTimeString\("zh-CN"\)/);
  assert.match(html, /renderRecentList/);
  assert.match(html, /items\.slice\(0, 10\)/);
  assert.match(html, /model\.textContent = item\.model \|\| "-"/);
  assert.match(html, /more\.textContent = "\.\.\."/);
  assert.match(html, /collapse\.textContent = "<"/);
  assert.match(html, /function flushEvent\(/);
  assert.match(html, /const lines = normalized\.split\("\\n"\)/);
  assert.match(html, /currentDataLines\[currentDataLines\.length - 1\] \+= "\\n" \+ line/);
  assert.doesNotMatch(html, /const blocks = normalized\.split\(/);
  assert.doesNotMatch(html, /开始采样/);
  assert.doesNotMatch(html, /停止采样/);
});

run("record page stream parser keeps data-like text inside JSON payloads", () => {
  const html = renderRecordPage({
    enabled: true,
    capturedCount: 1,
    limit: 100,
    sessionStartedAt: Date.UTC(2026, 3, 20, 10, 0, 0),
    recentKeys: [],
  });
  assert.match(html, /let currentDataLines = \[\]/);
  assert.match(html, /for \(let index = 0; index < lines\.length; index \+= 1\)/);
  assert.match(html, /if \(line === ""\) \{\n            flushEvent\(\);/);
  assert.match(html, /currentDataLines\.push\(line\.slice\(5\)\.trimStart\(\)\)/);
  assert.match(html, /currentDataLines\[currentDataLines\.length - 1\] \+= "\\n" \+ line/);
});

run("http log level only keeps /v1 lifecycle logs at info", () => {
  assert.equal(getHTTPLogLevel("/v1/chat/completions"), "info");
  assert.equal(getHTTPLogLevel("/v1/models"), "info");
  assert.equal(getHTTPLogLevel("/record"), "debug");
  assert.equal(getHTTPLogLevel("/status"), "debug");
});

run("debug logs are hidden by default and can be enabled with LOG_LEVEL=debug", () => {
  const original = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  assert.equal(shouldEmitLog("debug"), false);
  assert.equal(shouldEmitLog("info"), true);

  process.env.LOG_LEVEL = "debug";
  assert.equal(shouldEmitLog("debug"), true);
  assert.equal(shouldEmitLog("info"), true);

  if (original == null) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = original;
  }
});

run("reader release errors are ignored only for cancelled or completed streams", () => {
  const releasedReaderError = Object.assign(new TypeError("Invalid state: Releasing reader"), {
    code: "ERR_INVALID_STATE",
  });

  assert.equal(shouldIgnoreStreamReadError(releasedReaderError, { cancelled: false, completed: true }), true);
  assert.equal(shouldIgnoreStreamReadError(releasedReaderError, { cancelled: true, completed: false }), true);
  assert.equal(shouldIgnoreStreamReadError(releasedReaderError, { cancelled: false, completed: false }), false);
  assert.equal(shouldIgnoreStreamReadError(new Error("socket hang up"), { cancelled: false, completed: true }), false);
});

await runAsync("passthrough request records upstream request and response", async () => {
  startRecording();
  const requestId = "12345678-1234-5678-9abc-def012345678";
  await withHTTPServer(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "secret=1" });
    res.end(JSON.stringify({ id: "resp_1", usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  }, async (baseURL) => {
    await runWithRequestId(requestId, async () => {
      beginRecordedRequest({
        requestId,
        path: "/v1/responses",
        headers: { Authorization: "Bearer top-secret" },
        body: { model: "alpha", input: "hello" },
        stream: false,
      });
      const result = await passthroughRequest({
        name: "alpha",
        provider: "openai-responses",
        base_url: baseURL,
        api_key: "test-key",
        model: "upstream-alpha",
      }, {
        model: "alpha",
        input: "hello",
      }, {
        attemptIndex: 1,
        modelName: "alpha",
      });
      setRecordedClientResponseMeta({ requestId, status: 200, headers: { "Content-Type": "application/json" } });
      setRecordedClientResponseBody({ requestId, body: result.json });
    });
  });

  const record = getRecordedRequest(requestId);
  assert.ok(record);
  assert.equal(record?.attempts[0].response.status, 200);
  assert.equal(record?.attempts[0].response.headers?.["content-type"], "application/json");
  assert.equal(record?.attempts[0].request.headers?.Authorization, "[REDACTED]");
  assert.deepEqual(record?.attempts[0].response.body, { id: "resp_1", usage: { prompt_tokens: 3, completion_tokens: 2 } });
  assert.deepEqual(record?.clientResponse.body, { id: "resp_1", usage: { prompt_tokens: 3, completion_tokens: 2 } });
  stopRecording();
});

run("record helpers append streaming provider and client chunks as text", () => {
  startRecording();
  const requestId = "654321ff-1234-5678-9abc-def012345678";
  beginRecordedRequest({
    requestId,
    path: "/v1/chat/completions",
    headers: {},
    body: { model: "alpha", stream: true },
    stream: true,
  });
  ensureRecordedAttempt({
    requestId,
    index: 1,
    provider: "openai-chat",
    modelName: "alpha",
    url: "https://example.com/v1/chat/completions",
    requestHeaders: {},
    requestBody: JSON.stringify({ model: "upstream-alpha", stream: true }),
  });
  setRecordedAttemptResponseMeta({
    requestId,
    index: 1,
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  setRecordedClientResponseMeta({
    requestId,
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  appendRecordedAttemptResponseBody({ requestId, index: 1, chunk: "data: raw-1\n\n" });
  appendRecordedAttemptResponseBody({ requestId, index: 1, chunk: "data: raw-2\n\n" });
  appendRecordedClientResponseBody({ requestId, chunk: "data: out-1\n\n" });
  appendRecordedClientResponseBody({ requestId, chunk: "data: out-2\n\n" });

  const record = getRecordedRequest(requestId);
  assert.equal(record?.attempts[0].response.body, "data: raw-1\n\ndata: raw-2\n\n");
  assert.equal(record?.clientResponse.body, "data: out-1\n\ndata: out-2\n\n");
  assert.equal(record?.attempts[0].response.truncated, false);
  assert.equal(record?.clientResponse.truncated, false);
  stopRecording();
});

run("record store can hot-update max_size without clearing all captured entries", () => {
  startRecording({ maxSize: 3 });
  beginRecordedRequest({
    requestId: "111111ff-1234-5678-9abc-def012345678",
    path: "/v1/chat/completions",
    headers: {},
    body: { model: "alpha" },
    stream: false,
  });
  beginRecordedRequest({
    requestId: "222222ff-1234-5678-9abc-def012345678",
    path: "/v1/chat/completions",
    headers: {},
    body: { model: "beta" },
    stream: false,
  });
  beginRecordedRequest({
    requestId: "333333ff-1234-5678-9abc-def012345678",
    path: "/v1/chat/completions",
    headers: {},
    body: { model: "gamma" },
    stream: false,
  });

  const summaryBefore = getRecordSummary();
  assert.equal(summaryBefore.limit, 3);
  assert.equal(summaryBefore.size, 3);

  configureRecording({ maxSize: 1 });
  const summaryAfter = getRecordSummary();
  assert.equal(summaryAfter.limit, 1);
  assert.equal(summaryAfter.size, 1);
  assert.deepEqual(summaryAfter.recentKeys.map((item) => item.key), ["333333"]);
  stopRecording();
});

run("record store keeps long text bodies without appending truncated marker", () => {
  startRecording();
  const requestId = "76543210-1234-5678-9abc-def012345678";
  beginRecordedRequest({
    requestId,
    path: "/v1/responses",
    headers: {},
    body: { model: "alpha", stream: true },
    stream: true,
  });
  ensureRecordedAttempt({
    requestId,
    index: 1,
    provider: "openai-responses",
    modelName: "alpha",
    url: "https://example.com/v1/responses",
    requestHeaders: {},
    requestBody: JSON.stringify({ model: "upstream-alpha", stream: true }),
  });

  const longChunk = "x".repeat(300000);
  appendRecordedAttemptResponseBody({ requestId, index: 1, chunk: longChunk });
  appendRecordedClientResponseBody({ requestId, chunk: longChunk });

  const record = getRecordedRequest(requestId);
  assert.equal((record?.attempts[0].response.body as string).length, longChunk.length);
  assert.equal((record?.clientResponse.body as string).length, longChunk.length);
  assert.doesNotMatch(record?.attempts[0].response.body as string, /\.\.\.\[truncated\]$/);
  assert.doesNotMatch(record?.clientResponse.body as string, /\.\.\.\[truncated\]$/);
  assert.equal(record?.attempts[0].response.truncated, false);
  assert.equal(record?.clientResponse.truncated, false);
  stopRecording();
});

run("admin page refreshes clean state after history restore", () => {
  const html = renderAdminConfigPage({
    version: 3,
    configPath: "config.yaml",
    effectiveConfig: {
      port: 4444,
      models: [],
      fallback: {},
      record: { max_size: 10 },
    },
    requiresRestartFields: [],
    form: {
      server: { port: "4444", ttfb_timeout: "" },
      record: { max_size: "10" },
      models: [],
      fallbackGroups: [],
    },
  });

  assert.match(html, /function isHistoryRestore\(event\)/);
  assert.match(html, /navigationEntry && navigationEntry\.type === "back_forward"/);
  assert.match(html, /if \(saving \|\| dirty \|\| !isHistoryRestore\(event\)\) return;/);
  assert.match(html, /window\.addEventListener\("pageshow", \(event\) => \{/);
  assert.match(html, /refreshFromServer\(\)\.catch\(\(error\) => \{/);
});

run("startup error disposes resources and exits on occupied port", () => {
  const logs: unknown[][] = [];
  const calls: string[] = [];

  handleServerStartupError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), {
    port: 3000,
    dispose() {
      calls.push("dispose");
    },
    log(...args) {
      logs.push(args);
    },
    exit(code) {
      calls.push(`exit:${code}`);
    },
  });

  assert.deepEqual(calls, ["dispose", "exit:1"]);
  assert.equal(logs[0]?.[0], "Failed to start nanollm: port 3000 is already in use.");
  assert.equal(logs[1]?.[0], "Use a different port in config.yaml, stop the other process, or set PORT.");
});
