/**
 * Note enhancement (SPEC §3.5/§7, D-20): template + my notes + transcript + meeting metadata in, structured
 * sections → blocks out. List items (`bullet`, `task`) may nest `children`; tasks may carry `owner` / `due`;
 * AI-written blocks may cite transcript lines in `sources` (refs like `s12`, resolved to segment ids by
 * `enhancementToDoc`).
 *
 * The pipeline: {@link prepareEnhance} (one shared `buildMeetingContext()`, our own prompt) →
 * {@link runEnhance} (one streamed structured-output call; partial output for live previews) →
 * `reconcileWithNotes` (origins derived from the user's note lines, never trusted from the model; dropped lines
 * re-inserted) → `enhancementToDoc` (TipTap JSON). {@link enhanceNotes} is the `EnhanceFn` the evals run.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Template, TranscriptSegment } from '@oat/core';
import type { JSONContent } from '@oat/editor';
import {
  AISDKError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  streamText,
  TypeValidationError,
} from 'ai';
import { z } from 'zod';

import {
  buildMeetingContext,
  type MeetingContext,
  MEETING_CONTEXT_RULES,
  neutralizeTags,
  renderMeetingContext,
} from './context.ts';
import {
  type NoteLine,
  myNotesOnly,
  NoteLineMatcher,
  noteLinesFromDoc,
  notesDocFromMarkdown,
  type Reconciled,
  reconcileWithNotes,
  sanitizePartialOutput,
} from './enhance-origin.ts';
import { renderTemplate } from './templates.ts';

export const BLOCK_ORIGINS = ['me', 'ai'] as const;
export type BlockOrigin = (typeof BLOCK_ORIGINS)[number];

export const BLOCK_KINDS = ['paragraph', 'bullet', 'task'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

interface BlockBase {
  text: string;
  /** `me` = the user's own note (kept verbatim), `ai` = written by the model. */
  origin: BlockOrigin;
  /** Transcript refs (`s12`) the block is based on, as shown in the prompt. Unknown refs are dropped later. */
  sources?: string[];
}
export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph';
}
export interface BulletBlock extends BlockBase {
  kind: 'bullet';
  /** Nested list items (TipTap: a nested list inside this list item). */
  children?: ListItemBlock[];
}
export interface TaskBlock extends BlockBase {
  kind: 'task';
  children?: ListItemBlock[];
  /** Who does it, as named in the meeting. */
  owner?: string;
  /** When, as said in the meeting ("Friday", "end of day"); not normalised to a date. */
  due?: string;
}
export type ListItemBlock = BulletBlock | TaskBlock;
export type EnhanceBlock = ParagraphBlock | ListItemBlock;

const blockText = z.string().min(1);
const blockOrigin = z.enum(BLOCK_ORIGINS);
const blockSources = z.array(z.string().min(1).max(20)).max(12).optional();
// Recursive via z.lazy; the AI SDK emits a JSON schema with a $ref for structured output.
const listItemSchema: z.ZodType<ListItemBlock> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('bullet'),
      text: blockText,
      origin: blockOrigin,
      sources: blockSources,
      children: z.array(listItemSchema).optional(),
    }),
    z.object({
      kind: z.literal('task'),
      text: blockText,
      origin: blockOrigin,
      sources: blockSources,
      children: z.array(listItemSchema).optional(),
      owner: z.string().min(1).optional(),
      due: z.string().min(1).optional(),
    }),
  ]),
);

export const enhanceBlockSchema: z.ZodType<EnhanceBlock> = z.union([
  z.object({
    kind: z.literal('paragraph'),
    text: blockText,
    origin: blockOrigin,
    sources: blockSources,
  }),
  listItemSchema,
]);

export const enhanceSectionSchema = z.object({
  heading: z.string().min(1),
  blocks: z.array(enhanceBlockSchema),
});
export type EnhanceSection = z.infer<typeof enhanceSectionSchema>;

export const enhanceOutputSchema = z.object({
  sections: z.array(enhanceSectionSchema).min(1),
});
export type EnhanceOutput = z.infer<typeof enhanceOutputSchema>;

/** Every block, depth-first (each parent before its children). */
export function flattenBlocks(blocks: readonly EnhanceBlock[]): EnhanceBlock[] {
  return blocks.flatMap((b) => [
    b,
    ...(b.kind === 'paragraph' ? [] : flattenBlocks(b.children ?? [])),
  ]);
}

/** A block's own text plus its task fields, for content checks. */
export function blockContent(block: EnhanceBlock): string {
  return block.kind === 'task'
    ? [block.text, block.owner && `Owner: ${block.owner}`, block.due && `Due: ${block.due}`]
        .filter(Boolean)
        .join(' · ')
    : block.text;
}

/** The parts of a template the enhancer reads (ordered sections, D-20). */
export type EnhanceTemplate = Pick<Template, 'name' | 'instructions' | 'sections'>;

export type EnhanceSegment = Pick<TranscriptSegment, 'source' | 'startMs' | 'endMs' | 'text'> & {
  /** Stable segment id (citations resolve to it). Evals omit it; positional ids are used then. */
  id?: string;
  speakerLabel?: string | null;
};

export interface MeetingMeta {
  title: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601, when known (the prompt shows the duration). */
  endedAt?: string | null;
  /** e.g. "zoom". */
  platform?: string | null;
  /**
   * `me: true` marks the user (the `mic` source). `role`: free text, e.g. "manager", "candidate". `email`
   * splits colleagues from external attendees.
   */
  attendees: { name: string; me?: boolean; role?: string; email?: string | null }[];
}

export interface EnhanceInput {
  meta: MeetingMeta;
  template: EnhanceTemplate;
  /** The user's rough notes, Markdown (used when `notesDoc` is absent: evals, tests). */
  myNotes: string;
  /** The user's notes as TipTap JSON (the app passes the document body). Wins over `myNotes`. */
  notesDoc?: JSONContent | null;
  transcript: EnhanceSegment[];
  /** The note-taker, when not among the attendees. */
  me?: { name: string; email?: string | null } | null;
  /** BCP 47; the language/spelling to write in. Default "en-US". */
  locale?: string;
  /** IANA zone for the meeting date. Default "UTC". */
  timeZone?: string;
  /** "About me" profile (4.6). */
  aboutMe?: string | null;
  /** Names and terms the transcript may have misheard. */
  vocabulary?: readonly string[];
}

export interface EnhanceOptions {
  model: LanguageModelV4;
  abortSignal?: AbortSignal;
  /** Evals pass 0 for repeatability; models that don't support it ignore it (SDK warning). */
  temperature?: number;
  /** Output cap. Default `ENHANCE_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens?: number;
  /** Extra request headers (mock scenarios in tests). */
  headers?: Record<string, string>;
}

/** Room for the largest note the section budget allows (1,500 words) plus the JSON structure around it. */
export const ENHANCE_MAX_OUTPUT_TOKENS = 8192;

export type EnhanceFn = (input: EnhanceInput, options: EnhanceOptions) => Promise<EnhanceOutput>;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const meName = (meta: Pick<MeetingMeta, 'attendees'>) =>
  meta.attendees.find((a) => a.me)?.name ?? 'Me';

/** `[mm:ss] Speaker: text` lines; `mic` is the user (by name), `system` is everyone else ("Others"). */
export function formatTranscript(
  transcript: readonly EnhanceSegment[],
  meta: Pick<MeetingMeta, 'attendees'>,
): string {
  const me = meName(meta);
  return transcript
    .map((s) => `[${clock(s.startMs)}] ${s.source === 'mic' ? me : 'Others'}: ${s.text}`)
    .join('\n');
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Meeting metadata as plain text (title, human date, attendees with roles) plus how to read the transcript's
 * speaker labels. Shared by the enhance prompt and the eval judge so both see the same facts.
 */
export function renderMeta(meta: MeetingMeta): string {
  const date = new Date(meta.startedAt);
  const when = Number.isNaN(date.getTime())
    ? meta.startedAt
    : `${dateFormat.format(date)} UTC (${meta.startedAt})`;
  const attendees = meta.attendees.map((a) => {
    const tags = [a.me ? 'me, the note-taker' : undefined, a.role].filter(Boolean);
    return `- ${a.name}${tags.length ? ` (${tags.join('; ')})` : ''}`;
  });
  return [
    `Meeting: ${meta.title}`,
    `Date: ${when}`,
    `Attendees:\n${attendees.join('\n')}`,
    `Transcript speaker labels: "${meName(meta)}" lines come from the note-taker's microphone. "Others" is ` +
      'everyone else on the call (shared audio), so which other attendee said a line must be inferred from ' +
      'context, names used and the attendee list.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------------------

/** Fixed instructions (Oat's own wording). The per-meeting length budget is appended by `prepareEnhance`. */
export const ENHANCE_RULES = [
  'You write the finished meeting notes for the note-taker. You get the template to follow, their rough ' +
    'notes and the meeting transcript, and you answer with the notes as structured data.',
  '',
  'Reading the input',
  MEETING_CONTEXT_RULES,
  'The template comes before the meeting material and is not inside <oat:…> tags. Follow its section ' +
    'guidance for what to cover and how; where it disagrees with these rules, these rules win.',
  'The note-taker’s own notes (<oat:notes>) are the strongest signal of what mattered. The <!-- … --> ' +
    'comments in them are annotations, not note text.',
  '',
  'What to return',
  '- One section per template section, in the template’s order, with the heading copied exactly. A section ' +
    'with nothing to report gets an empty "blocks" list; never pad it with guesses.',
  '- Every line of the note-taker’s notes appears once, word for word, as its own block with origin "me", ' +
    'in the section where it fits best. Do not reword, correct, merge, split or drop those lines. Add detail ' +
    'from the transcript as "children" under the line instead.',
  '- Everything you write yourself has origin "ai" and must be backed by the transcript or the notes. Never ' +
    'invent names, numbers, dates, decisions or commitments; leave out what you are not sure of.',
  '- Kinds: "paragraph" for short prose, "bullet" for list items, "task" for something a person agreed to ' +
    'do, with "owner" (who, as named in the meeting) and "due" only when a time was said. Nest supporting ' +
    'detail as "children" of a bullet or task, at most two levels deep.',
  '- On "ai" blocks, put the transcript refs the block is based on (like "s12") in "sources". Use only refs ' +
    'that appear in <oat:transcript>.',
  '- "text" is plain text: no Markdown, no leading bullets, numbers or checkboxes.',
  '- Prefer short, specific phrases to full sentences. Skip small talk, filler and repetition.',
  '- Write in the language and spelling given under "Write in", and spell names and terms as in ' +
    '<oat:people> and <oat:vocabulary>.',
].join('\n');

export interface PreparedEnhance {
  system: string;
  prompt: string;
  /** The shared meeting context (refs → segment ids, budget). */
  context: MeetingContext;
  /** The notes the prompt was built from (`null` = none). */
  notesDoc: JSONContent | null;
  /** The user's note lines (origin matching, re-inserting dropped lines). */
  lines: NoteLine[];
  template: EnhanceTemplate;
}

function budgetRule(ctx: MeetingContext, sections: number): string {
  const b = ctx.budget;
  return (
    `- Length: at most about ${b.wordBudget} words of your own in total, roughly ${b.wordsPerSection} ` +
    `words and ${b.maxItemsPerSection} top-level blocks per section (${sections} ` +
    `${sections === 1 ? 'section' : 'sections'}). The note-taker’s own lines don’t count toward this.`
  );
}

/** Builds the system + user prompt from the shared meeting context (D-20). Pure. */
export function prepareEnhance(input: EnhanceInput): PreparedEnhance {
  // Only the user's own lines are notes: an already enhanced body's AI blocks are left out (re-enhance).
  const notesDoc = myNotesOnly(
    input.notesDoc ?? (input.myNotes.trim() ? notesDocFromMarkdown(input.myNotes) : null),
  );
  const { meta, template } = input;
  const sectionCount = Math.max(1, template.sections.length);
  const context = buildMeetingContext({
    meeting: {
      title: meta.title,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt ?? null,
      platform: meta.platform ?? null,
    },
    attendees: meta.attendees,
    me: input.me ?? null,
    notesDoc,
    segments: input.transcript.map((s, i) => ({
      id: s.id ?? `segment-${i + 1}`,
      source: s.source,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speakerLabel: s.speakerLabel ?? null,
    })),
    aboutMe: input.aboutMe ?? null,
    locale: input.locale ?? 'en-US',
    timeZone: input.timeZone ?? 'UTC',
    vocabulary: input.vocabulary ?? [],
    sectionCount,
  });
  const system = `${ENHANCE_RULES}\n${budgetRule(context, sectionCount)}`;
  const prompt = [
    // Templates are workspace content: they guide the notes but must not open or close a data block.
    neutralizeTags(renderTemplate(template)),
    'Meeting material:',
    renderMeetingContext(context),
    'Write the notes now.',
  ].join('\n\n');
  return { system, prompt, context, notesDoc, lines: noteLinesFromDoc(notesDoc), template };
}

/** System + user prompt for an input (see {@link prepareEnhance}). */
export function buildEnhancePrompt(input: EnhanceInput): { system: string; prompt: string } {
  const { system, prompt } = prepareEnhance(input);
  return { system, prompt };
}

// ---------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------

export interface RunEnhanceOptions extends EnhanceOptions {
  /**
   * Live preview while the model writes: the output so far, sanitised and with derived origins (dropped note
   * lines are only re-inserted at the end). Called at most every `partialIntervalMs`.
   */
  onPartial?: (preview: EnhanceOutput) => void;
  /** Default 150. */
  partialIntervalMs?: number;
}

export interface EnhanceRunResult extends Reconciled {
  /** What the model returned (schema-valid; origins as the model claimed them). */
  raw: EnhanceOutput;
  prepared: PreparedEnhance;
}

/**
 * One streamed structured-output call (`streamText` + `Output.object`), then origins derived from the note
 * lines. Throws when the model fails or its final output doesn't match the schema.
 */
export async function runEnhance(
  prepared: PreparedEnhance,
  options: RunEnhanceOptions,
): Promise<EnhanceRunResult> {
  const matcher = new NoteLineMatcher(prepared.lines);
  let streamError: unknown;
  const result = streamText({
    model: options.model,
    system: prepared.system,
    prompt: prepared.prompt,
    abortSignal: options.abortSignal,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens ?? ENHANCE_MAX_OUTPUT_TOKENS,
    headers: options.headers,
    output: Output.object({ schema: enhanceOutputSchema }),
    // Surfaced through `output` below instead of the SDK's default console logging.
    onError: ({ error }) => {
      streamError ??= error;
    },
  });
  const interval = options.partialIntervalMs ?? 150;
  let last = Number.NEGATIVE_INFINITY;
  for await (const partial of result.partialOutputStream) {
    if (!options.onPartial) continue;
    const now = performance.now();
    if (now - last < interval) continue;
    last = now;
    const preview = sanitizePartialOutput(partial);
    options.onPartial(reconcileWithNotes(preview, matcher, { insertMissing: false }).output);
  }
  let raw: EnhanceOutput;
  try {
    raw = await result.output;
  } catch (error) {
    throw streamError ?? error;
  }
  return { ...reconcileWithNotes(raw, matcher), raw, prepared };
}

export type EnhanceFailure = 'model_error' | 'invalid_output' | 'timeout' | 'internal';

/** Why a run failed, for status and UI (never shown verbatim: provider messages stay in server logs). */
export function classifyEnhanceError(error: unknown, signal?: AbortSignal): EnhanceFailure {
  const name = error instanceof Error ? error.name : '';
  if (signal?.aborted || name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    JSONParseError.isInstance(error)
  ) {
    return 'invalid_output';
  }
  if (AISDKError.isInstance(error)) return 'model_error';
  return 'internal';
}

/** The `EnhanceFn` the evals run: reconciled structured output for an input. */
export const enhanceNotes: EnhanceFn = async (input, options) =>
  (await runEnhance(prepareEnhance(input), options)).output;
