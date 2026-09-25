import { SSEParser, type StreamFormat } from "./converters/streams.js";

export const DEFAULT_MODEL_TEST_MESSAGE = "你只需要回复ok";

export function buildModelTestRequest(provider: StreamFormat, modelName: string, message: string): { path: string; body: Record<string, unknown> } {
  switch (provider) {
    case "openai-chat":
      return {
        path: "/v1/chat/completions",
        body: { model: modelName, messages: [{ role: "user", content: message }], stream: true },
      };
    case "openai-responses":
      return {
        path: "/v1/responses",
        body: {
          model: modelName,
          instructions: "You are a helpful assistant.",
          input: [{ role: "user", content: [{ type: "input_text", text: message }] }],
          store: false,
          stream: true,
        },
      };
    case "anthropic":
      return {
        path: "/v1/messages",
        body: { model: modelName, max_tokens: 1024, messages: [{ role: "user", content: message }], stream: true },
      };
    default:
      throw new Error(`Model test is not supported for provider '${provider}'`);
  }
}

function extractEventText(provider: StreamFormat, event: any): string {
  if (!event || typeof event !== "object") return "";
  if (provider === "openai-chat") {
    const content = event.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  }
  if (provider === "openai-responses") {
    return event.type === "response.output_text.delta" && typeof event.delta === "string" ? event.delta : "";
  }
  if (provider === "anthropic") {
    return event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string" ? event.delta.text : "";
  }
  return "";
}

/** Concatenate the assistant text deltas from a client-format SSE body. */
export function extractModelTestReply(provider: StreamFormat, sseText: string): string {
  const parser = new SSEParser();
  const events = [...parser.push(sseText), ...parser.flush()];
  let text = "";
  for (const event of events) {
    try {
      text += extractEventText(provider, JSON.parse(event.data));
    } catch {}
  }
  return text;
}
