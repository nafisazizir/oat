import type { DocumentKind, DocumentVisibility, TranscriptSource } from '@oat/core';

export const SEARCH_TYPES = ['all', 'notes', 'transcripts'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export type NoteHit = {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  title: string;
  visibility: DocumentVisibility;
  updatedAt: string;
  /** Safe HTML (only `<mark>`). */
  titleHtml: string;
  /** Safe HTML (only `<mark>`): body fragments around the matches. */
  snippetHtml: string;
};

export type TranscriptHit = {
  id: string;
  documentId: string;
  documentTitle: string;
  source: TranscriptSource;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  updatedAt: string;
  /** Safe HTML (only `<mark>`). */
  snippetHtml: string;
};

export type SearchSection<T> = { items: T[]; nextCursor: string | null };

/** `notes`/`transcripts` are present when requested (`type=all` → both). */
export type SearchResponse = {
  query: string;
  notes?: SearchSection<NoteHit>;
  transcripts?: SearchSection<TranscriptHit>;
};

export type SearchQuery = {
  q: string;
  type?: SearchType;
  workspaceId?: string;
  limit?: number;
  cursor?: string;
};
