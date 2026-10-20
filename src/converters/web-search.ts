import type {
  NormalizedCitation,
  NormalizedPart,
  NormalizedWebSearch,
  NormalizedWebSearchAction,
  NormalizedWebSearchSource,
  NormalizedWebSearchTool,
} from "./shared.js";

// Native web search conversion between Anthropic Messages and OpenAI Responses.
// Background and live-test results: docs/web-search-conversion-research.md.
//
// Each side's search history carries state only its own upstream can verify (Anthropic's
// encrypted_content / encrypted_index, OpenAI's server-side web_search_call). So a search is
// replayed exactly only to the protocol that ran it, using what the client echoes back:
// - Anthropic search shown to a Responses client: a visible web_search_call whose id is
//   ws_nanollm_<srvtoolu id>, plus a reasoning item whose encrypted_content carries the original
//   blocks (Responses clients send reasoning encrypted_content back verbatim).
// - Responses search shown to an Anthropic client: server_tool_use id srvtoolu_nanollm_<ws id>,
//   the action in its input, and marker encrypted_content on the results.
// Anywhere else a search degrades: a function call with a plaintext result (Responses) or a
// text note in the assistant's own voice (Anthropic, Chat). Claude disowns its earlier answer
// when the history shows a search without readable results, so the note says why.

export const WEB_SEARCH_TOOL_NAME = "web_search";
/** Function name used when a search from another protocol is replayed as a plain function call. */
export const WEB_SEARCH_HISTORY_TOOL_NAME = "web_search_history";

const CARRIER_PREFIX = "nanollm.websearch.v1:";
/** encrypted_content / encrypted_index placeholder on Anthropic blocks synthesized from a Responses search. */
export const WEB_SEARCH_MARKER = "nanollm.websearch.v1";
const ANTHROPIC_ID_PREFIX = "srvtoolu_nanollm_";
const RESPONSES_ID_PREFIX = "ws_nanollm_";

const RETENTION_NOTE = "(Full page contents were retrieved and read when this answer was written; only source metadata is kept in this conversation history.)";

const RESPONSES_WEB_SEARCH_TOOL_TYPES = new Set(["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"]);

// ─── Carrier ────────────────────────────────────────────────────────────────

export function isWebSearchCarrier(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CARRIER_PREFIX);
}

/** Encode original Anthropic search blocks for a Responses reasoning item's encrypted_content. */
export function encodeWebSearchCarrier(blocks: unknown[]): string {
  return CARRIER_PREFIX + Buffer.from(JSON.stringify({ blocks }), "utf8").toString("base64");
}

export function decodeWebSearchCarrier(value: unknown): unknown[] | undefined {
  if (!isWebSearchCarrier(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(CARRIER_PREFIX.length), "base64").toString("utf8"));
    return Array.isArray(parsed?.blocks) ? parsed.blocks : undefined;
  } catch {
    return undefined;
  }
}

export function toResponsesWebSearchId(anthropicId: string): string {
  return RESPONSES_ID_PREFIX + anthropicId;
}

export function toAnthropicWebSearchId(responsesId: string): string {
  return ANTHROPIC_ID_PREFIX + responsesId;
}

export function isSynthesizedAnthropicWebSearchId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(ANTHROPIC_ID_PREFIX);
}

export function isSynthesizedResponsesWebSearchId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(RESPONSES_ID_PREFIX);
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export function isResponsesWebSearchTool(tool: any): boolean {
  return RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type);
}

export function isAnthropicWebSearchTool(tool: any): boolean {
  return typeof tool?.type === "string" && tool.type.startsWith("web_search_") && tool.name === WEB_SEARCH_TOOL_NAME;
}

export function normalizeResponsesWebSearchTool(tool: any): NormalizedWebSearchTool {
  return compact<NormalizedWebSearchTool>({
    kind: "web_search",
    name: WEB_SEARCH_TOOL_NAME,
    allowedDomains: nonEmpty(tool.filters?.allowed_domains),
    blockedDomains: nonEmpty(tool.filters?.blocked_domains),
    userLocation: normalizeUserLocation(tool.user_location),
    searchContextSize: tool.search_context_size,
    externalWebAccess: typeof tool.external_web_access === "boolean" ? tool.external_web_access : undefined,
  });
}

export function normalizeAnthropicWebSearchTool(tool: any): NormalizedWebSearchTool {
  return compact<NormalizedWebSearchTool>({
    kind: "web_search",
    name: WEB_SEARCH_TOOL_NAME,
    allowedDomains: nonEmpty(tool.allowed_domains),
    blockedDomains: nonEmpty(tool.blocked_domains),
    userLocation: normalizeUserLocation(tool.user_location),
    maxUses: typeof tool.max_uses === "number" ? tool.max_uses : undefined,
  });
}

/**
 * Basic web search: the 2026 versions default to dynamic filtering, which runs searches inside code
 * execution and returns blocks with no Responses counterpart. Anthropic rejects allowed and blocked
 * domains together, so allowed wins.
 */
export function denormalizeAnthropicWebSearchTool(tool: NormalizedWebSearchTool): Record<string, unknown> | undefined {
  // Anthropic has no cache-only mode; dropping the tool keeps the "no live access" intent.
  if (tool.externalWebAccess === false) return undefined;
  return compact({
    type: "web_search_20250305",
    name: WEB_SEARCH_TOOL_NAME,
    max_uses: tool.maxUses,
    allowed_domains: tool.allowedDomains,
    blocked_domains: tool.allowedDomains ? undefined : tool.blockedDomains,
    user_location: tool.userLocation ? { type: "approximate", ...tool.userLocation } : undefined,
  });
}

/** max_uses has no reliable counterpart (max_tool_calls counts other actions too), so it is dropped. */
export function denormalizeResponsesWebSearchTool(tool: NormalizedWebSearchTool): Record<string, unknown> {
  const filters = compact({ allowed_domains: tool.allowedDomains, blocked_domains: tool.blockedDomains });
  return compact({
    type: "web_search",
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    user_location: tool.userLocation ? { type: "approximate", ...tool.userLocation } : undefined,
    search_context_size: tool.searchContextSize,
    external_web_access: tool.externalWebAccess,
  });
}

function normalizeUserLocation(location: any): NormalizedWebSearchTool["userLocation"] {
  if (!location || typeof location !== "object") return undefined;
  const normalized = compact({ city: location.city, region: location.region, country: location.country, timezone: location.timezone });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// ─── Normalizing history ────────────────────────────────────────────────────

/**
 * A search from Anthropic history: a server_tool_use with its web_search_tool_result. Either may be
 * missing (a search pending behind a client tool call, or a result that arrives in the next turn).
 */
export function normalizeAnthropicWebSearch(serverToolUse: any | undefined, result: any | undefined): NormalizedWebSearch {
  const id: string = serverToolUse?.id ?? result?.tool_use_id ?? "";
  const content = result?.content;
  const error = content && !Array.isArray(content) ? content : undefined;
  const results: any[] = Array.isArray(content) ? content : [];
  const sources = results.map((entry) => compact({ url: String(entry.url ?? ""), title: entry.title ?? null, pageAge: entry.page_age ?? null }));
  const status: NormalizedWebSearch["status"] = !result ? "in_progress" : error ? "failed" : "completed";

  if (isSynthesizedAnthropicWebSearchId(id)) {
    // Shown to this client by nanollm from a Responses search: rebuild that web_search_call.
    const responsesId = id.slice(ANTHROPIC_ID_PREFIX.length);
    const action = normalizeResponsesAction(serverToolUse?.input?.action) ?? searchAction(serverToolUse?.input?.query);
    return {
      type: "web_search",
      id: responsesId,
      origin: "openai-responses",
      action,
      status,
      sources,
      native: { item: { type: "web_search_call", id: responsesId, status: status === "failed" ? "failed" : "completed", action: denormalizeResponsesAction(action, sources) } },
    };
  }

  return compact<NormalizedWebSearch>({
    type: "web_search",
    id,
    origin: "anthropic",
    action: searchAction(serverToolUse?.input?.query),
    status,
    sources,
    errorCode: error?.error_code,
    native: { blocks: [serverToolUse, result].filter(Boolean) },
  });
}

/** A web_search_call item from Responses history. */
export function normalizeResponsesWebSearch(item: any): NormalizedWebSearch {
  const action = normalizeResponsesAction(item.action) ?? { type: "search" as const, queries: [] };
  const sources: NormalizedWebSearchSource[] = Array.isArray(item.action?.sources)
    ? item.action.sources.filter((source: any) => typeof source?.url === "string").map((source: any) => ({ url: source.url }))
    : [];
  const status: NormalizedWebSearch["status"] = item.status === "failed" || item.status === "incomplete" ? "failed" : item.status === "in_progress" || item.status === "searching" ? "in_progress" : "completed";

  if (isSynthesizedResponsesWebSearchId(item.id)) {
    // Shown to this client by nanollm from an Anthropic search. Its original blocks travel in a
    // separate carrier item; without one only this readable copy is left.
    return { type: "web_search", id: item.id.slice(RESPONSES_ID_PREFIX.length), origin: "anthropic", action, status, sources };
  }
  const { id, type, status: itemStatus, action: itemAction } = item;
  return { type: "web_search", id: String(id ?? ""), origin: "openai-responses", action, status, sources, native: { item: compact({ id, type, status: itemStatus, action: itemAction }) } };
}

/** Searches restored from a Responses reasoning carrier, with their original Anthropic blocks. */
export function normalizeWebSearchCarrier(value: unknown): NormalizedWebSearch[] | undefined {
  const blocks = decodeWebSearchCarrier(value);
  if (!blocks) return undefined;
  const searches: NormalizedWebSearch[] = [];
  const byId = new Map<string, number>();
  for (const block of blocks as any[]) {
    if (block?.type === "server_tool_use") {
      byId.set(block.id, searches.length);
      searches.push(normalizeAnthropicWebSearch(block, undefined));
    } else if (block?.type === "web_search_tool_result") {
      const index = byId.get(block.tool_use_id);
      const serverToolUse = index === undefined ? undefined : (searches[index].native as { blocks: unknown[] }).blocks[0];
      const search = normalizeAnthropicWebSearch(serverToolUse, block);
      if (index === undefined) searches.push({ ...search, continuation: true });
      else searches[index] = search;
    }
  }
  return searches;
}

/** Web searches seen so far in a request or response, so a later result block can complete its search. */
export type AnthropicSearchIndex = Map<string, { part: NormalizedWebSearch; serverToolUse: any }>;

/** A new search part from a server_tool_use block, registered so its result can find it. */
export function startAnthropicWebSearch(serverToolUse: any, searches: AnthropicSearchIndex, currentIds: Set<string>): NormalizedWebSearch {
  const part = normalizeAnthropicWebSearch(serverToolUse, undefined);
  searches.set(serverToolUse.id, { part, serverToolUse });
  currentIds.add(serverToolUse.id);
  return part;
}

/**
 * Attach a web_search_tool_result to its search. Within the same message the search gets both native
 * blocks. A result from a later message completes the earlier search's readable fields and keeps its
 * own block in place as a continuation, so a native replay restores the original block order. A result
 * whose search was never seen is a continuation too (stateless: the earlier turn belongs to the client).
 */
export function attachAnthropicWebSearchResult(result: any, searches: AnthropicSearchIndex, currentIds: Set<string>): NormalizedWebSearch | undefined {
  const entry = searches.get(result.tool_use_id);
  if (!entry) return { ...normalizeAnthropicWebSearch(undefined, result), continuation: true };
  const completed = normalizeAnthropicWebSearch(entry.serverToolUse, result);
  if (currentIds.has(result.tool_use_id)) {
    Object.assign(entry.part, completed);
    return undefined;
  }
  Object.assign(entry.part, { status: completed.status, sources: completed.sources, errorCode: completed.errorCode });
  return { ...completed, native: { blocks: [result] }, continuation: true };
}

export function normalizeAnthropicCitations(citations: unknown): NormalizedCitation[] | undefined {
  if (!Array.isArray(citations)) return undefined;
  const normalized = citations
    .filter((citation: any) => citation?.type === "web_search_result_location" && typeof citation.url === "string")
    .map((citation: any) => compact({ url: citation.url, title: citation.title ?? null, citedText: citation.cited_text, encryptedIndex: citation.encrypted_index }));
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeResponsesAnnotations(annotations: unknown): NormalizedCitation[] | undefined {
  if (!Array.isArray(annotations)) return undefined;
  const normalized = annotations
    .filter((annotation: any) => annotation?.type === "url_citation" && typeof annotation.url === "string")
    .map((annotation: any) => compact({ url: annotation.url, title: annotation.title ?? null, startIndex: annotation.start_index, endIndex: annotation.end_index }));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeResponsesAction(action: any): NormalizedWebSearchAction | undefined {
  if (!action || typeof action !== "object") return undefined;
  if (action.type === "open_page") return { type: "open_page", url: String(action.url ?? "") };
  if (action.type === "find_in_page") return { type: "find_in_page", url: String(action.url ?? ""), pattern: String(action.pattern ?? "") };
  if (action.type === "search") {
    const queries = Array.isArray(action.queries) && action.queries.length > 0 ? action.queries.map(String) : typeof action.query === "string" ? [action.query] : [];
    return { type: "search", queries };
  }
  return undefined;
}

function searchAction(query: unknown): NormalizedWebSearchAction {
  return { type: "search", queries: typeof query === "string" && query ? [query] : [] };
}

// ─── Denormalizing history ──────────────────────────────────────────────────

export function denormalizeResponsesAction(action: NormalizedWebSearchAction, sources: NormalizedWebSearchSource[] = []): Record<string, unknown> {
  if (action.type === "search") {
    return { type: "search", query: action.queries.join(" / "), queries: action.queries, ...(sources.length > 0 ? { sources: sources.map((source) => ({ type: "url", url: source.url })) } : {}) };
  }
  if (action.type === "open_page") return { type: "open_page", url: action.url };
  return { type: "find_in_page", url: action.url, pattern: action.pattern };
}

export function webSearchQueryText(action: NormalizedWebSearchAction): string {
  if (action.type === "search") return action.queries.join(" / ");
  if (action.type === "open_page") return `open_page: ${action.url}`;
  return `find_in_page: "${action.pattern}" in ${action.url}`;
}

/** Source quotes from the citations of a message's text parts, by URL. */
export function collectCitedSnippets(parts: NormalizedPart[]): Map<string, string[]> {
  const snippets = new Map<string, string[]>();
  for (const part of parts) {
    if (part.type !== "text") continue;
    for (const citation of part.citations ?? []) {
      if (!citation.citedText) continue;
      const list = snippets.get(citation.url) ?? [];
      if (!list.includes(citation.citedText)) list.push(citation.citedText);
      snippets.set(citation.url, list);
    }
  }
  return snippets;
}

/** Titles of cited URLs: Responses sources carry none, so annotations are the only titles there. */
export function collectCitationTitles(parts: NormalizedPart[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "text") continue;
    for (const citation of part.citations ?? []) {
      if (citation.title && !titles.has(citation.url)) titles.set(citation.url, citation.title);
    }
  }
  return titles;
}

/**
 * Plaintext result for a search replayed as a function call. Snippets are what GPT can still read of
 * an Anthropic search: titles, page ages and the cited quotes.
 */
export function webSearchResultText(search: NormalizedWebSearch, snippets: Map<string, string[]>, titles: Map<string, string> = new Map()): string {
  if (search.status === "failed") return `Search failed${search.errorCode ? ` (${search.errorCode})` : ""}.`;
  if (search.status === "in_progress") return "Search did not complete.";
  if (search.action.type === "open_page") return `Opened page: ${search.action.url}`;
  if (search.action.type === "find_in_page") return `Searched for "${search.action.pattern}" in ${search.action.url}`;
  if (search.sources.length === 0) return "Search returned no results.";
  return "Search results:\n" + search.sources.map((source) => sourceLine(source, titles, snippets)).join("\n");
}

/**
 * Text note for a search that can't be replayed natively, written in the assistant's voice. Claude
 * treats a tool_result as exactly what it saw and retracts answers built on unseen page content;
 * the same facts in its own voice, with the retention line, are accepted.
 */
export function webSearchNoteText(search: NormalizedWebSearch, titles: Map<string, string> = new Map()): string {
  const lines = [`[web_search] ${search.action.type === "search" ? "query" : "action"}: ${webSearchQueryText(search.action)}`];
  if (search.status === "failed") lines.push(`Search failed${search.errorCode ? ` (${search.errorCode})` : ""}.`);
  else if (search.status === "in_progress") lines.push("Search did not complete.");
  else if (search.action.type === "search" && search.sources.length === 0) lines.push("No results.");
  else {
    lines.push(RETENTION_NOTE);
    if (search.sources.length > 0) lines.push("Sources:", ...search.sources.map((source) => sourceLine(source, titles)));
  }
  return lines.join("\n");
}

function sourceLine(source: NormalizedWebSearchSource, titles: Map<string, string>, snippets?: Map<string, string[]>): string {
  const title = source.title || titles.get(source.url);
  let line = `- ${title ? `${title} — ` : ""}${source.url}${source.pageAge ? ` (${source.pageAge})` : ""}`;
  for (const snippet of snippets?.get(source.url) ?? []) line += `\n  > ${snippet}`;
  return line;
}

/** Native Anthropic blocks for a search, or undefined when it can't be replayed to Anthropic. */
export function anthropicWebSearchBlocks(search: NormalizedWebSearch): unknown[] | undefined {
  return search.origin === "anthropic" && search.native && "blocks" in search.native && search.native.blocks.length > 0 ? search.native.blocks : undefined;
}

/** The native Responses item for a search, or undefined when it can't be replayed to Responses. */
export function responsesWebSearchItem(search: NormalizedWebSearch): Record<string, unknown> | undefined {
  return search.origin === "openai-responses" && search.native && "item" in search.native ? search.native.item : undefined;
}

export function webSearchFunctionCallItems(search: NormalizedWebSearch, snippets: Map<string, string[]>, titles: Map<string, string>): Record<string, unknown>[] {
  return [
    { type: "function_call", call_id: search.id, name: WEB_SEARCH_HISTORY_TOOL_NAME, arguments: JSON.stringify({ query: webSearchQueryText(search.action) }) },
    { type: "function_call_output", call_id: search.id, output: webSearchResultText(search, snippets, titles) },
  ];
}

// ─── Responses (response side) ──────────────────────────────────────────────

let carrierCounter = 0;

/**
 * Output items for an Anthropic search shown to a Responses client: a visible web_search_call and a
 * reasoning item whose encrypted_content carries the original blocks (clients send that back verbatim).
 * A search with no result yet (a client tool was called in the same turn) is only carried: showing a
 * finished search that hasn't run would be false, and its result arrives in the next response.
 */
export function anthropicSearchToResponsesItems(search: NormalizedWebSearch): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (search.status !== "in_progress") {
    items.push({
      id: toResponsesWebSearchId(search.id),
      type: "web_search_call",
      status: search.status === "failed" ? "failed" : "completed",
      action: denormalizeResponsesAction(search.action, search.sources),
    });
  }
  const blocks = anthropicWebSearchBlocks(search);
  if (blocks) items.push({ id: `rs_ws_${++carrierCounter}`, type: "reasoning", status: "completed", summary: [], encrypted_content: encodeWebSearchCarrier(blocks) });
  return items;
}

/** The Responses output items for a search, whichever protocol ran it. */
export function webSearchToResponsesItems(search: NormalizedWebSearch): Record<string, unknown>[] {
  const native = responsesWebSearchItem(search);
  return native ? [native] : anthropicSearchToResponsesItems(search);
}

/** Annotations for a text part: Responses ranges as they are, Anthropic block citations covering the whole part. */
export function responsesAnnotations(text: string, citations: NormalizedCitation[] | undefined): Record<string, unknown>[] {
  const length = Array.from(text).length;
  return (citations ?? []).map((citation) => ({
    type: "url_citation",
    url: citation.url,
    title: citation.title ?? "",
    start_index: citation.startIndex ?? 0,
    end_index: citation.endIndex ?? length,
  }));
}

// ─── Anthropic (response side) ──────────────────────────────────────────────

/**
 * Blocks for a Responses search shown to an Anthropic client. The action rides in `input` (clients
 * echo it back verbatim) and results carry markers, so a later request can rebuild the web_search_call.
 */
export function responsesSearchToAnthropicBlocks(search: NormalizedWebSearch, titles: Map<string, string>): Record<string, unknown>[] {
  const id = toAnthropicWebSearchId(search.id);
  const content = search.status === "failed"
    ? { type: "web_search_tool_result_error", error_code: "unavailable" }
    : search.sources.map((source) => ({
        type: "web_search_result",
        url: source.url,
        title: source.title || titles.get(source.url) || source.url,
        encrypted_content: WEB_SEARCH_MARKER,
        page_age: source.pageAge ?? null,
      }));
  return [
    { type: "server_tool_use", id, name: WEB_SEARCH_TOOL_NAME, input: { query: webSearchQueryText(search.action), action: denormalizeResponsesAction(search.action) } },
    { type: "web_search_tool_result", tool_use_id: id, content },
  ];
}

/** Blocks for a search in an Anthropic response: the original ones, or the Responses search rebuilt. */
export function webSearchToAnthropicBlocks(search: NormalizedWebSearch, titles: Map<string, string>): Record<string, unknown>[] {
  if (search.origin === "anthropic") return (anthropicWebSearchBlocks(search) as Record<string, unknown>[] | undefined) ?? [{ type: "text", text: webSearchNoteText(search, titles), citations: null }];
  return responsesSearchToAnthropicBlocks(search, titles);
}

/**
 * Cut a text part into blocks at its citation ranges (Unicode code points): each cited stretch becomes
 * a block carrying the citations that cover it, with the stretch itself as cited_text.
 */
export function splitTextByCitations(text: string, citations: NormalizedCitation[] | undefined): Record<string, unknown>[] {
  const ranged = (citations ?? []).filter((citation) => citation.startIndex !== undefined && citation.endIndex !== undefined && citation.endIndex > citation.startIndex);
  if (ranged.length === 0) return text === "" ? [] : [{ type: "text", text, citations: null }];

  const chars = Array.from(text);
  const bounds = [...new Set([0, chars.length, ...ranged.flatMap((citation) => [citation.startIndex!, citation.endIndex!])])]
    .map((bound) => Math.min(Math.max(bound, 0), chars.length))
    .sort((a, b) => a - b);

  const blocks: Record<string, unknown>[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    if (end <= start) continue;
    const segment = chars.slice(start, end).join("");
    const covering = ranged.filter((citation) => citation.startIndex! <= start && citation.endIndex! >= end);
    blocks.push(covering.length === 0
      ? { type: "text", text: segment, citations: null }
      : {
          type: "text",
          text: segment,
          citations: covering.map((citation) => ({
            type: "web_search_result_location",
            url: citation.url,
            title: citation.title ?? null,
            // Only the answer's own words are known, not a quote from the source.
            cited_text: Array.from(segment).slice(0, 150).join(""),
            encrypted_index: WEB_SEARCH_MARKER,
          })),
        });
  }
  return blocks;
}

/** Searches that actually ran, for usage.server_tool_use.web_search_requests. */
export function countWebSearchRequests(parts: NormalizedPart[]): number {
  return parts.filter((part) => part.type === "web_search" && part.action.type === "search" && part.status !== "in_progress" && !part.continuation).length;
}

// ─── Same-format passthrough ────────────────────────────────────────────────
// Same-format requests skip conversion, but their history can still hold searches nanollm
// synthesized while an earlier turn ran on the other protocol. Those carry placeholders the
// upstream would reject, so they degrade here.

/** Responses input: carrier reasoning items and ws_nanollm_ calls become function calls. */
export function degradeSynthesizedResponsesWebSearch(input: unknown[]): unknown[] | undefined {
  let changed = false;
  const carried = new Set<string>();
  for (const item of input as any[]) {
    if (item?.type !== "reasoning") continue;
    for (const search of normalizeWebSearchCarrier(item.encrypted_content) ?? []) carried.add(search.id);
  }
  const output = (input as any[]).flatMap((item) => {
    if (item?.type === "reasoning" && isWebSearchCarrier(item.encrypted_content)) {
      changed = true;
      return (normalizeWebSearchCarrier(item.encrypted_content) ?? []).flatMap((search) => webSearchFunctionCallItems(search, new Map(), new Map()));
    }
    if (item?.type === "web_search_call" && isSynthesizedResponsesWebSearchId(item.id)) {
      changed = true;
      const search = normalizeResponsesWebSearch(item);
      return carried.has(search.id) ? [] : webSearchFunctionCallItems(search, new Map(), new Map());
    }
    return [item];
  });
  return changed ? output : undefined;
}

/** Anthropic messages: srvtoolu_nanollm_ pairs become text notes and marker citations are removed. */
export function degradeSynthesizedAnthropicWebSearch(messages: unknown[]): unknown[] | undefined {
  let changed = false;
  const output = (messages as any[]).map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    const results = new Map<string, any>();
    for (const block of message.content) {
      if (block?.type === "web_search_tool_result" && isSynthesizedAnthropicWebSearchId(block.tool_use_id)) results.set(block.tool_use_id, block);
    }
    let messageChanged = false;
    const content = message.content.flatMap((block: any) => {
      if (block?.type === "server_tool_use" && isSynthesizedAnthropicWebSearchId(block.id)) {
        messageChanged = true;
        return [{ type: "text", text: webSearchNoteText(normalizeAnthropicWebSearch(block, results.get(block.id))) }];
      }
      if (block?.type === "web_search_tool_result" && isSynthesizedAnthropicWebSearchId(block.tool_use_id)) {
        messageChanged = true;
        return [];
      }
      if (block?.type === "text" && Array.isArray(block.citations) && block.citations.some(isMarkerCitation)) {
        messageChanged = true;
        const citations = block.citations.filter((citation: any) => !isMarkerCitation(citation));
        return [{ ...block, citations: citations.length > 0 ? citations : null }];
      }
      return [block];
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? output : undefined;
}

function isMarkerCitation(citation: any): boolean {
  return typeof citation?.encrypted_index === "string" && citation.encrypted_index.startsWith(WEB_SEARCH_MARKER);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value.map(String) : undefined;
}

/** Drop undefined fields so converted objects only carry what the source had. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
