/**
 * Note enhancement contract (SPEC §7, D-20): template + my notes + transcript + meeting metadata in, structured
 * sections → blocks out, each block marked `origin: me | ai`. List items (`bullet`, `task`) may nest `children`;
 * tasks may carry `owner` / `due`. The TipTap conversion (4.4) maps blocks to nodes and carries `origin` as an
 * attribute.
 *
 * `enhanceNotes` is a **placeholder** (task 4.2) so the eval harness has something real to run: one structured
 * `generateText` call with a minimal prompt. Task 4.4 replaces its body (prompt builder, section budget,
 * streaming job) but keeps the `EnhanceFn` signature, so `pnpm --filter @oat/ai eval` keeps working.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Template, TranscriptSegment } from '@oat/core';
import { generateText, Output } from 'ai';
import { z } from 'zod';

export const BLOCK_ORIGINS = ['me', 'ai'] as const;
export type BlockOrigin = (typeof BLOCK_ORIGINS)[number];

export const BLOCK_KINDS = ['paragraph', 'bullet', 'task'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

interface BlockBase {
  text: string;
  /** `me` = the user's own note (kept verbatim), `ai` = written by the model. */
  origin: BlockOrigin;
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
// Recursive via z.lazy; the AI SDK emits a JSON schema with a $ref for structured output.
const listItemSchema: z.ZodType<ListItemBlock> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('bullet'),
      text: blockText,
      origin: blockOrigin,
      children: z.array(listItemSchema).optional(),
    }),
    z.object({
      kind: z.literal('task'),
      text: blockText,
      origin: blockOrigin,
      children: z.array(listItemSchema).optional(),
      owner: z.string().min(1).optional(),
      due: z.string().min(1).optional(),
    }),
  ]),
);

export const enhanceBlockSchema: z.ZodType<EnhanceBlock> = z.union([
  z.object({ kind: z.literal('paragraph'), text: blockText, origin: blockOrigin }),
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

export type EnhanceSegment = Pick<TranscriptSegment, 'source' | 'startMs' | 'endMs' | 'text'>;

export interface MeetingMeta {
  title: string;
  /** ISO 8601. */
  startedAt: string;
  /** `me: true` marks the user (the `mic` source). `role`: free text, e.g. "manager", "candidate". */
  attendees: { name: string; me?: boolean; role?: string }[];
}

export interface EnhanceInput {
  meta: MeetingMeta;
  template: EnhanceTemplate;
  /** The user's rough notes, Markdown. */
  myNotes: string;
  transcript: EnhanceSegment[];
}

export interface EnhanceOptions {
  model: LanguageModelV4;
  abortSignal?: AbortSignal;
  /** Evals pass 0 for repeatability; models that don't support it ignore it (SDK warning). */
  temperature?: number;
  /** Output cap. Default `ENHANCE_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens?: number;
}

export const ENHANCE_MAX_OUTPUT_TOKENS = 4096;

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

/** Placeholder prompt (4.4 owns the real one). */
export function buildEnhancePrompt(input: EnhanceInput): { system: string; prompt: string } {
  const system = [
    'You write clean meeting notes from a person’s rough notes and the meeting transcript.',
    'Return one section per template section, in the given order, using the headings exactly as given.',
    'Keep every line of the person’s notes, word for word, as a block with origin "me" in the section it fits best.',
    'Add blocks with origin "ai" only for things actually said in the transcript; never invent names, numbers or dates.',
    'Use kind "task" for action items, with "owner" (and "due" when said). Nest supporting detail under a list item as "children".',
  ].join('\n');
  const sections = input.template.sections
    .map((s, i) => `${i + 1}. ${s.heading}${s.instructions ? ` — ${s.instructions}` : ''}`)
    .join('\n');
  const prompt = [
    renderMeta(input.meta),
    `Template: ${input.template.name}${input.template.instructions ? ` — ${input.template.instructions}` : ''}`,
    `Sections:\n${sections}`,
    `My notes:\n${input.myNotes.trim() || '(none)'}`,
    `Transcript:\n${formatTranscript(input.transcript, input.meta) || '(empty)'}`,
  ].join('\n\n');
  return { system, prompt };
}

/** Placeholder enhancer (see file header). Throws if the model's output doesn't match the schema. */
export const enhanceNotes: EnhanceFn = async (input, options) => {
  const { system, prompt } = buildEnhancePrompt(input);
  const { output } = await generateText({
    model: options.model,
    system,
    prompt,
    abortSignal: options.abortSignal,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens ?? ENHANCE_MAX_OUTPUT_TOKENS,
    output: Output.object({ schema: enhanceOutputSchema }),
  });
  return output;
};
