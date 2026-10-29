import { formatSSE, SSEParser } from "../converters/streams.js";

// Claude pauses a long server-tool turn (a web search loop) with stop_reason "pause_turn" and
// continues it when the paused assistant content is sent back unchanged. An Anthropic client does
// that itself. Responses and Chat clients do not know the stop reason, so a paused turn would
// look like a finished one: for converted requests the proxy resumes it and returns one response.

export const MAX_PAUSE_TURN_CONTINUATIONS = 5;

type Json = Record<string, any>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPausedTurn(response: unknown): response is Json {
  return isPlainObject(response) && response.stop_reason === "pause_turn" && Array.isArray(response.content);
}

/** The request body for the next round: the whole assistant turn so far, as one trailing assistant message. */
export function withContinuation(body: unknown, content: unknown[]): unknown {
  const request = body as Json;
  return { ...request, messages: [...(Array.isArray(request.messages) ? request.messages : []), { role: "assistant", content }] };
}

/** Usage of consecutive rounds adds up: every round bills its own input and output. */
export function sumUsage(a: unknown, b: unknown): any {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (isPlainObject(a) && isPlainObject(b)) {
    const sum: Json = { ...b };
    for (const key of Object.keys(a)) sum[key] = key in b ? sumUsage(a[key], b[key]) : a[key];
    return sum;
  }
  return b ?? a;
}

/** Rounds of one paused turn as a single response: the contents in order, the last stop reason. */
export function mergePausedResponses(responses: Json[]): Json {
  const last = responses[responses.length - 1];
  return {
    ...last,
    id: responses[0].id,
    content: responses.flatMap((response) => response.content),
    usage: responses.map((response) => response.usage).reduce((total, usage) => sumUsage(total, usage)),
  };
}

/** Rebuilds the assistant content a stream is delivering, so it can be sent back when the turn pauses. */
class TurnAccumulator {
  private blocks: Json[] = [];
  private segment = new Map<number, Json>();

  startSegment() {
    this.segment.clear();
  }

  apply(event: Json) {
    if (event.type === "content_block_start") {
      const block = structuredClone(event.content_block);
      this.blocks.push(block);
      this.segment.set(event.index, block);
      return;
    }
    const block = this.segment.get(event.index);
    if (!block) return;
    if (event.type === "content_block_stop") {
      if (block._json !== undefined) {
        try {
          block.input = block._json ? JSON.parse(block._json) : {};
        } catch {
          block.input = {};
        }
        delete block._json;
      }
      return;
    }
    const delta = event.delta;
    if (delta?.type === "text_delta") block.text += delta.text;
    else if (delta?.type === "thinking_delta") block.thinking += delta.thinking;
    else if (delta?.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
    else if (delta?.type === "input_json_delta") block._json = (block._json ?? "") + delta.partial_json;
    else if (delta?.type === "citations_delta") block.citations = [...(block.citations ?? []), delta.citation];
  }

  content(): Json[] {
    return this.blocks;
  }
}

/**
 * Splices the rounds of a paused turn into one Anthropic stream: when a round ends with pause_turn the
 * next one is fetched and its blocks continue the numbering, its message_start is dropped, and the
 * final message_delta carries the summed usage.
 */
export function continuePausedAnthropicStream(
  first: ReadableStream<Uint8Array>,
  resume: (assistantContent: unknown[]) => Promise<ReadableStream<Uint8Array>>,
  maxContinuations = MAX_PAUSE_TURN_CONTINUATIONS,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader = first.getReader();
  let parser = new SSEParser();
  let continuations = 0;
  let offset = 0;
  let segmentEnd = 0;
  let usage: unknown;
  let switched = false;
  const turn = new TurnAccumulator();

  async function process(raw: { event?: string; data: string }): Promise<string[]> {
    let event: Json;
    try {
      event = JSON.parse(raw.data);
    } catch {
      return [`${raw.event ? `event: ${raw.event}\n` : ""}data: ${raw.data}\n\n`];
    }
    switch (event.type) {
      case "message_start":
        return continuations > 0 ? [] : [formatSSE(event, raw.event)];
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop":
        segmentEnd = Math.max(segmentEnd, event.index + 1);
        turn.apply(event);
        return [formatSSE({ ...event, index: event.index + offset }, raw.event)];
      case "message_delta": {
        if (event.delta?.stop_reason === "pause_turn" && continuations < maxContinuations) {
          usage = sumUsage(usage, event.usage);
          offset += segmentEnd;
          segmentEnd = 0;
          continuations += 1;
          const content = turn.content();
          turn.startSegment();
          // Only message_stop is left in the paused round.
          await reader.cancel().catch(() => {});
          reader = (await resume(content)).getReader();
          parser = new SSEParser();
          switched = true;
          return [];
        }
        return [formatSSE(usage === undefined ? event : { ...event, usage: sumUsage(usage, event.usage) }, raw.event)];
      }
      default:
        return [formatSSE(event, raw.event)];
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          switched = false;
          const { done, value } = await reader.read();
          const events = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
          let enqueued = false;
          for (const raw of events) {
            for (const chunk of await process(raw)) {
              controller.enqueue(encoder.encode(chunk));
              enqueued = true;
            }
            // The rest of a paused round is dropped.
            if (switched) break;
          }
          if (done && !switched) {
            controller.close();
            return;
          }
          if (enqueued) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
