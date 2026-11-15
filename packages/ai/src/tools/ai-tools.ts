/**
 * The assistant tools as an AI SDK tool set (6.2). Descriptions and schemas are ours; the behaviour lives in
 * `./tools.ts`. A document-scoped chat gets the tools that make sense for one note (no `listMeetings`).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { MAX_EDITS, MAX_FIND_CHARS, MAX_REPLACE_CHARS } from './edit.ts';
import {
  getDocument,
  getTranscript,
  listMeetings,
  searchMeetings,
  TOOL_LIMITS,
  updateDocument,
} from './tools.ts';
import type { ToolContext } from './types.ts';

const Id = z.string().min(1).max(100);

/** How transcript speakers are labelled (see `recorderLabels` in `./tools.ts`). */
const SPEAKERS =
  'Transcript lines from the user’s own microphone are labelled "Me"; in a meeting a teammate recorded, ' +
  'that teammate’s lines carry their name instead.';

export function createAssistantTools(ctx: ToolContext) {
  const documentScope = ctx.scope.kind === 'document';
  const tools = {
    searchMeetings: tool({
      description:
        'Semantic search over the meeting notes and transcripts this chat can see. Returns excerpts, each ' +
        'with the exact citation marker to copy into your answer. Search before answering factual questions.' +
        ' ' +
        SPEAKERS,
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('What to look for, in natural language.'),
        limit: z.number().int().min(1).max(TOOL_LIMITS.maxSearchResults).optional(),
        source: z
          .enum(['notes', 'transcript', 'all'])
          .optional()
          .describe('Only notes, only transcripts, or both (default).'),
        documentId: Id.optional().describe('Search inside one document only.'),
      }),
      execute: (input) => searchMeetings(ctx, input),
    }),
    getDocument: tool({
      description:
        'Read a document (meeting notes or page) as Markdown. Each block ends with <!-- id=… -->; cite a ' +
        'block as [[block:<id>]].',
      inputSchema: z.object({ documentId: Id }),
      execute: (input) => getDocument(ctx, input),
    }),
    getTranscript: tool({
      description:
        'Read a meeting transcript, optionally a time range (milliseconds from the start). Each line starts ' +
        'with its citation marker [[seg:<id>]].' +
        ' ' +
        SPEAKERS,
      inputSchema: z
        .object({
          meetingId: Id.optional(),
          documentId: Id.optional().describe(
            'The meeting note’s document id (instead of meetingId).',
          ),
          fromMs: z.number().int().min(0).optional(),
          toMs: z.number().int().min(0).optional(),
        })
        .refine((v) => v.meetingId !== undefined || v.documentId !== undefined, {
          message: 'pass meetingId or documentId',
        }),
      execute: (input) => getTranscript(ctx, input),
    }),
    updateDocument: tool({
      description:
        'Propose edits to a document as find/replace pairs. Each `find` must occur exactly once in the ' +
        'document text. Nothing is written: the user sees the change and approves or rejects it. Only use ' +
        'this when the user asks you to change a note.',
      inputSchema: z.object({
        documentId: Id,
        edits: z
          .array(
            z.object({
              find: z.string().min(1).max(MAX_FIND_CHARS),
              replace: z.string().max(MAX_REPLACE_CHARS),
            }),
          )
          .min(1)
          .max(MAX_EDITS),
        summary: z.string().max(300).optional().describe('One line describing the change.'),
      }),
      execute: (input) => updateDocument(ctx, input),
    }),
  };
  if (documentScope) return tools;
  return {
    ...tools,
    listMeetings: tool({
      description:
        'List meetings in this workspace, newest first, filtered by date range, attendee (name or email) ' +
        'or folder. Use it for questions like "what did I discuss with Dana last week?".',
      inputSchema: z.object({
        from: z.string().max(40).optional().describe('ISO 8601 date/time, inclusive.'),
        to: z.string().max(40).optional().describe('ISO 8601 date/time, exclusive.'),
        attendee: z.string().max(200).optional(),
        folderId: Id.optional(),
        limit: z.number().int().min(1).max(TOOL_LIMITS.maxMeetings).optional(),
      }),
      execute: (input) => listMeetings(ctx, input),
    }),
  };
}

export type AssistantTools = ReturnType<typeof createAssistantTools>;
