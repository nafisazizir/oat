/** Builders for the chat eval worlds (synthetic, written for Oat). */
import type { DocumentRecord, SegmentRecord } from '../../src/tools/types.ts';

export const paragraph = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

export const heading = (id: string, text: string) => ({
  type: 'heading',
  attrs: { id, level: 2 },
  content: [{ type: 'text', text }],
});

export function doc(
  id: string,
  workspaceId: string,
  ownerId: string,
  title: string,
  blocks: unknown[],
  over: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    id,
    workspaceId,
    folderId: null,
    ownerId,
    kind: 'meeting',
    title,
    visibility: 'workspace',
    shareToken: null,
    deletedAt: null,
    version: 1,
    createdAt: new Date('2026-11-12T12:00:00Z'),
    updatedAt: new Date('2026-11-12T12:00:00Z'),
    contentJson: { type: 'doc', content: blocks },
    ...over,
  };
}

/** Transcript lines with ids `<prefix>-1…n` and plausible timings. */
export function lines(
  meetingId: string,
  prefix: string,
  rows: [source: 'mic' | 'system', speaker: string | null, text: string][],
): SegmentRecord[] {
  let at = 2_000;
  return rows.map(([source, speakerLabel, text], i) => {
    const startMs = at;
    const endMs = startMs + Math.max(2_000, text.split(' ').length * 400);
    at = endMs + 500;
    return { id: `${prefix}-${i + 1}`, meetingId, source, speakerLabel, startMs, endMs, text };
  });
}
