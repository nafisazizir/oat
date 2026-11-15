/**
 * In-memory {@link AssistantData} for evals and unit tests: no database, deterministic retrieval with the same
 * feature-hashed vectors as the mock embedding model (one "chunk" per transcript segment and per top-level
 * note block). It applies the same read rule as `searchChunks` (members only, owner or not private, no trash,
 * no share tokens) so permission tests mean something here too.
 */
import { canReadDocument } from '@oat/core';
import { toMarkdown } from '@oat/editor/markdown';
import { hashEmbedding } from '../hash-embedding.ts';
import type {
  AssistantData,
  DocumentRecord,
  MeetingRecord,
  SearchHit,
  SegmentRecord,
} from './types.ts';

export interface MemoryDataInput {
  documents: readonly DocumentRecord[];
  meetings?: readonly MeetingRecord[];
  segments?: readonly SegmentRecord[];
}

const DIMS = 256;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // unit vectors
}

interface Chunk {
  documentId: string;
  text: string;
  ref: SearchHit['ref'];
  vector: number[];
}

export function createMemoryAssistantData(input: MemoryDataInput): AssistantData {
  const documents = new Map(input.documents.map((d) => [d.id, d]));
  const meetings = [...(input.meetings ?? [])];
  const segments = [...(input.segments ?? [])].sort((a, b) => a.startMs - b.startMs);

  function chunksOf(doc: DocumentRecord): Chunk[] {
    const out: Chunk[] = [];
    const blocks = ((doc.contentJson as { content?: unknown[] })?.content ?? []) as {
      attrs?: { id?: string };
    }[];
    for (const block of blocks) {
      const id = block.attrs?.id;
      if (!id) continue;
      const text = `${doc.title} › ${toMarkdown(block as never)}`;
      out.push({
        documentId: doc.id,
        text,
        ref: { source: 'notes', blockIds: [id] },
        vector: hashEmbedding(text, DIMS),
      });
    }
    const meeting = meetings.find((m) => m.documentId === doc.id);
    for (const s of segments.filter((s) => s.meetingId === meeting?.id)) {
      const text = `Transcript · ${doc.title}\n${s.text}`;
      out.push({
        documentId: doc.id,
        text: s.text,
        ref: { source: 'transcript', segmentIds: [s.id], startMs: s.startMs, endMs: s.endMs },
        vector: hashEmbedding(text, DIMS),
      });
    }
    return out;
  }

  return {
    async search(permissions, query, request) {
      const q = hashEmbedding(query, DIMS);
      const hits: SearchHit[] = [];
      for (const doc of documents.values()) {
        const inScope =
          'documentId' in request.scope
            ? doc.id === request.scope.documentId
            : doc.workspaceId === request.scope.workspaceId;
        const readable =
          doc.deletedAt === null &&
          canReadDocument(
            { userId: permissions.userId, memberships: permissions.memberships },
            doc,
          );
        if (!inScope || !readable) continue;
        for (const chunk of chunksOf(doc)) {
          if (request.sources && !request.sources.includes(chunk.ref.source)) continue;
          hits.push({
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            documentTitle: doc.title,
            documentKind: doc.kind,
            text: chunk.text,
            ref: chunk.ref,
            score: cosine(q, chunk.vector),
          });
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, request.k);
    },

    async documents(ids) {
      return ids.flatMap((id) => {
        const doc = documents.get(id);
        return doc ? [doc] : [];
      });
    },

    async meeting(by) {
      return meetings.find((m) => ('id' in by ? m.id === by.id : m.documentId === by.documentId));
    },

    async segments(meetingId, range, limit) {
      return segments
        .filter(
          (s) =>
            s.meetingId === meetingId &&
            (range.fromMs === undefined || s.startMs >= range.fromMs) &&
            (range.toMs === undefined || s.startMs < range.toMs),
        )
        .slice(0, limit);
    },

    async segmentsByIds(ids) {
      const wanted = new Set(ids);
      return segments.filter((s) => wanted.has(s.id));
    },

    async listMeetings(permissions, filter) {
      const attendee = filter.attendee?.toLowerCase();
      return meetings
        .flatMap((meeting) => {
          const doc = documents.get(meeting.documentId);
          if (!doc || doc.workspaceId !== filter.workspaceId || doc.deletedAt !== null) return [];
          if (
            !canReadDocument(
              { userId: permissions.userId, memberships: permissions.memberships },
              doc,
            )
          ) {
            return [];
          }
          const when = meeting.startedAt ?? doc.createdAt;
          if (filter.from && when < filter.from) return [];
          if (filter.to && when >= filter.to) return [];
          if (filter.folderId && doc.folderId !== filter.folderId) return [];
          if (
            attendee &&
            !meeting.participants.some(
              (p) =>
                p.name.toLowerCase().includes(attendee) ||
                p.email?.toLowerCase().includes(attendee),
            )
          ) {
            return [];
          }
          const { contentJson: _content, ...rest } = doc;
          return [{ document: rest, meeting, when }];
        })
        .sort((a, b) => b.when.getTime() - a.when.getTime())
        .slice(0, filter.limit)
        .map(({ document, meeting }) => ({ document, meeting }));
    },
  };
}
