/**
 * The assistant turn (6.2): history + scope → AI SDK tool loop (`streamText` with our tools, a step limit
 * and output caps) whose text is citation-filtered in-stream. The web route (`/api/chat`) turns the result
 * into a UI message stream and persists it; evals call the same function and read `result.text`.
 */
import { isBlockType } from '@oat/editor/blocks';
import {
  convertToModelMessages,
  isStepCount,
  type LanguageModel,
  streamText,
  type UIMessage,
} from 'ai';
import {
  buildMeetingContext,
  estimateTokens,
  type MeetingContext,
  type ProfileContextInput,
  renderMeetingContext,
  renderProfileContext,
} from '../context.ts';
import { createAssistantTools } from '../tools/ai-tools.ts';
import { canSee } from '../tools/tools.ts';
import type { EditProposal, ToolContext } from '../tools/types.ts';
import { citationTransform, CitationFilter, CitationRegistry, CitationStats } from './citations.ts';
import { buildChatInstructions } from './prompt.ts';

/** Defaults for one assistant turn. */
export const CHAT_LIMITS = {
  /** Model calls per turn (tool calls + the answer). */
  maxSteps: 6,
  maxOutputTokens: 2_000,
  /** Prior messages sent to the model (newest kept). */
  historyMessages: 24,
  historyTokens: 24_000,
  /** One user message. */
  userChars: 8_000,
  contextTranscriptTokens: 24_000,
  contextNotesTokens: 8_000,
} as const;

/** Keeps the newest messages within `maxMessages` / `maxTokens` (the last one always stays). */
export function trimHistory<M extends UIMessage>(
  messages: readonly M[],
  maxMessages: number = CHAT_LIMITS.historyMessages,
  maxTokens: number = CHAT_LIMITS.historyTokens,
): M[] {
  const kept: M[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const cost = estimateTokens(JSON.stringify(message.parts));
    if (kept.length > 0 && (kept.length >= maxMessages || used + cost > maxTokens)) break;
    kept.unshift(message);
    used += cost;
  }
  // Start on a user turn so the model never sees an orphaned answer first.
  while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift();
  return kept;
}

const FINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied']);

/**
 * Parts worth persisting: drops tool calls that never got a result (an aborted turn), which the next turn
 * couldn't send back to the model. (`streamAssistant` also ignores them in history, for rows saved before.)
 */
export function completeParts<P extends UIMessage['parts'][number]>(parts: readonly P[]): P[] {
  return parts.filter(
    (part) =>
      !(part.type.startsWith('tool-') || part.type === 'dynamic-tool') ||
      FINAL_TOOL_STATES.has((part as { state?: string }).state ?? ''),
  );
}

/** Allows the ids in earlier tool results of the thread (they were shown to the model). */
export function registerHistory(registry: CitationRegistry, messages: readonly UIMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type.startsWith('tool-') && 'output' in part && part.state === 'output-available') {
        registry.addFromOutput(part.output);
      }
    }
  }
}

/** Every block id in a TipTap document. */
function blockIds(doc: unknown, out: string[] = []): string[] {
  if (doc === null || typeof doc !== 'object') return out;
  const node = doc as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  if (isBlockType(node.type) && typeof node.attrs?.id === 'string') out.push(node.attrs.id);
  for (const child of node.content ?? []) blockIds(child, out);
  return out;
}

export interface DocumentContextOptions {
  /** The note-taker, as the context names them. */
  me: { name: string; email?: string | null };
  locale?: string;
  timeZone?: string;
  /** The user's "about me" profile and vocabulary (4.6), fenced as data like the rest. */
  aboutMe?: string | null;
  vocabulary?: readonly string[];
}

export interface DocumentContext {
  context: MeetingContext;
  rendered: string;
}

/**
 * The note's context for a document chat (D-20: the same `buildMeetingContext()` enhance uses), and the ids
 * it makes citable. `undefined` when the document isn't visible to the actor.
 */
export async function loadDocumentContext(
  ctx: ToolContext,
  registry: CitationRegistry,
  options: DocumentContextOptions,
): Promise<DocumentContext | undefined> {
  if (ctx.scope.kind !== 'document') return undefined;
  const [doc] = await ctx.data.documents([ctx.scope.documentId]);
  if (!doc || !canSee(ctx, doc)) return undefined;
  const meeting =
    doc.kind === 'meeting' ? await ctx.data.meeting({ documentId: doc.id }) : undefined;
  const segments = meeting ? await ctx.data.segments(meeting.id, {}, 5_000) : [];
  const context = buildMeetingContext({
    meeting: {
      title: doc.title,
      startedAt: meeting?.startedAt ?? null,
      endedAt: meeting?.endedAt ?? null,
      platform: meeting?.platform ?? null,
    },
    attendees: meeting?.participants ?? [],
    me: options.me,
    notesDoc: doc.contentJson as Parameters<typeof buildMeetingContext>[0]['notesDoc'],
    segments,
    aboutMe: options.aboutMe ?? null,
    vocabulary: options.vocabulary ?? [],
    locale: options.locale ?? 'en-US',
    timeZone: options.timeZone ?? 'UTC',
    maxTranscriptTokens: CHAT_LIMITS.contextTranscriptTokens,
    maxNotesTokens: CHAT_LIMITS.contextNotesTokens,
  });
  for (const id of blockIds(doc.contentJson)) registry.blocks.add(id);
  for (const s of context.transcript.segments) {
    registry.segmentRefs.set(s.ref, s.id);
    registry.segments.add(s.id);
  }
  return { context, rendered: renderMeetingContext(context) };
}

export interface StreamAssistantOptions {
  model: LanguageModel;
  /** Permissions, data and scope for the tools. `onProposal` is wrapped to also collect proposals. */
  tools: ToolContext;
  /** The conversation so far, ending with the new user message (already trimmed). */
  messages: UIMessage[];
  /** Pre-seeded (history, document context). A fresh one is created when omitted. */
  registry?: CitationRegistry;
  /** Document chats: the rendered context (see {@link loadDocumentContext}). */
  documentContext?: string;
  /**
   * Workspace chats: the user's profile (4.6), rendered with `renderProfileContext`. Document chats get it
   * inside `documentContext` instead (pass it to {@link loadDocumentContext}).
   */
  profile?: ProfileContextInput;
  now?: Date;
  timeZone?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export async function streamAssistant(options: StreamAssistantOptions) {
  const registry = options.registry ?? new CitationRegistry();
  const stats = new CitationStats();
  const filter = new CitationFilter(registry, stats);
  const proposals: EditProposal[] = [];
  const toolCtx: ToolContext = {
    ...options.tools,
    onProposal: (proposal) => {
      proposals.push(proposal);
      options.tools.onProposal?.(proposal);
    },
  };
  const tools = createAssistantTools(toolCtx);
  const context =
    options.documentContext ?? (options.profile ? renderProfileContext(options.profile) : '');
  const instructions = buildChatInstructions({
    scope: options.tools.scope.kind,
    now: options.now ?? new Date(),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(context ? { context } : {}),
  });
  const result = streamText({
    model: options.model,
    instructions,
    messages: await convertToModelMessages(options.messages, {
      tools,
      ignoreIncompleteToolCalls: true,
    }),
    tools,
    stopWhen: isStepCount(options.maxSteps ?? CHAT_LIMITS.maxSteps),
    maxOutputTokens: options.maxOutputTokens ?? CHAT_LIMITS.maxOutputTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    experimental_transform: citationTransform(filter),
  });
  return { result, tools, registry, citations: stats, proposals };
}
