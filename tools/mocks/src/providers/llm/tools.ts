/**
 * Scripted tool use for the mock LLM (6.2), so an assistant's tool loop runs end to end offline. Deterministic:
 *
 * 1. **Call a tool** when the request offers `tools` (and `tool_choice` isn't `"none"`) and no tool result has
 *    come back since the last user message:
 *    - a user message of the form `mock:tool <name> <json args>` calls exactly that tool (for exercising tools
 *      such as `updateDocument` from a UI or test);
 *    - `tool_choice: { type: 'function', function: { name } }` calls that tool;
 *    - otherwise the first offered tool with a string `query` parameter is called with the user's message as
 *      the query (a search).
 *    With no such tool, the reply is plain text as usual.
 * 2. **Answer from tool results** once results are present: up to three sentences, each the first sentence of
 *    an item `{ cite, text }` found anywhere in the tool output JSON (tags stripped), followed by its `cite`
 *    marker. Tool output without such items gets a fixed sentence.
 */
import { type ChatMessage, messageText, splitSentences } from './text.ts';

export interface OpenAiTool {
  type?: string;
  function?: { name?: string; parameters?: { properties?: Record<string, { type?: unknown }> } };
}

export type ToolPlan =
  { kind: 'call'; name: string; arguments: string } | { kind: 'answer'; content: string };

const DIRECTIVE = /^\s*mock:tool\s+([\w-]+)\s+(\{[\s\S]*\})\s*$/;
const MAX_QUERY = 500;
export const NO_CITATIONS_REPLY = 'Done. The tools returned nothing to quote.';

const toolName = (t: OpenAiTool) => t.function?.name;

function hasStringQuery(tool: OpenAiTool): boolean {
  const type = tool.function?.parameters?.properties?.query?.type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}

/** `{ cite, text }` items anywhere in a JSON value, in document order. */
export function citedItems(value: unknown, out: { cite: string; text: string }[] = []) {
  if (Array.isArray(value)) {
    for (const v of value) citedItems(v, out);
  } else if (value !== null && typeof value === 'object') {
    const { cite, text } = value as { cite?: unknown; text?: unknown };
    if (typeof cite === 'string' && typeof text === 'string') out.push({ cite, text });
    else for (const v of Object.values(value)) citedItems(v, out);
  }
  return out;
}

const stripTags = (text: string) =>
  text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What the mock does with a chat request that may involve tools; `undefined` = no tool behaviour. */
export function planToolTurn(
  messages: readonly ChatMessage[],
  tools: unknown,
  toolChoice: unknown,
): ToolPlan | undefined {
  const offered = Array.isArray(tools)
    ? (tools as OpenAiTool[]).filter((t) => typeof toolName(t) === 'string')
    : [];
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const results = messages.slice(lastUser + 1).filter((m) => m.role === 'tool');

  if (results.length > 0) {
    const items = results.flatMap((m) => citedItems(parseJson(messageText(m))));
    const sentences = items.slice(0, 3).flatMap(({ cite, text }) => {
      const first = splitSentences(stripTags(text))[0];
      return first ? [`${first.replace(/[.!?]*$/, '.')} ${cite}`] : [];
    });
    return { kind: 'answer', content: sentences.join(' ') || NO_CITATIONS_REPLY };
  }

  if (offered.length === 0 || toolChoice === 'none' || lastUser === -1) return undefined;
  const userText = messageText(messages[lastUser]!).trim();

  const directive = DIRECTIVE.exec(userText);
  if (directive && offered.some((t) => toolName(t) === directive[1])) {
    return {
      kind: 'call',
      name: directive[1]!,
      arguments: JSON.stringify(parseJson(directive[2]!)),
    };
  }
  const forced =
    toolChoice !== null && typeof toolChoice === 'object'
      ? (toolChoice as { function?: { name?: string } }).function?.name
      : undefined;
  if (forced && offered.some((t) => toolName(t) === forced)) {
    const tool = offered.find((t) => toolName(t) === forced)!;
    const args = hasStringQuery(tool) ? { query: userText.slice(0, MAX_QUERY) } : {};
    return { kind: 'call', name: forced, arguments: JSON.stringify(args) };
  }
  const search = offered.find(hasStringQuery);
  if (search && userText) {
    return {
      kind: 'call',
      name: toolName(search)!,
      arguments: JSON.stringify({ query: userText.slice(0, MAX_QUERY) }),
    };
  }
  return undefined;
}
