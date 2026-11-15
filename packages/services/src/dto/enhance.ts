/**
 * Enhance API contract (task 4.4, D-20), shared by the route handlers and the browser.
 *
 * | Method | Path                              | Body / headers                                   | Result |
 * |--------|-----------------------------------|--------------------------------------------------|--------|
 * | POST   | /api/documents/:id/enhance        | `{ idempotencyKey, templateId?, timeZone? }`     | 201 `StartEnhanceResult` (new job) · 200 (same key, or a job already running for the note) |
 * | GET    | /api/documents/:id/enhance        | –                                                | `{ latest: EnhancementDto \| null }` |
 * | GET    | /api/enhancements/:id/stream      | `Last-Event-ID` (or `?lastEventId=`) to resume   | `text/event-stream` of {@link EnhanceEvent}s |
 *
 * | GET    | /api/documents/:id/enhancements   | –                                                | {@link EnhancementVersionList} (4.5) |
 * | GET    | /api/enhancements/:id             | – (a run id or a snapshot id)                    | {@link EnhancementDetail} (4.5) |
 * | POST   | /api/enhancements/:id/restore     | {@link RestoreEnhancementInput}                  | {@link RestoreEnhancementResult} (4.5) |
 *
 * Starting, restoring and reading versions (history, original notes) need edit access to a live meeting
 * note — earlier versions can hold text an editor removed before sharing; the latest run and its stream need
 * read access. Anything the caller can't read is 404. Errors use the shared API shape (`ApiErrorBody`).
 * Restore is a normal body write (D-19): a stale `baseVersion` is 409 `stale_version` with the server copy,
 * and it is refused (409 `enhance_busy`) while a run is writing the note.
 *
 * Stream events (`event:` = `type`, `data:` = JSON, `id:` = resume point): `preview` (the whole output so far,
 * origins already derived; each one replaces the previous), then exactly one of `completed` or `failed`, after
 * which the server closes the stream. A reader that attaches late gets the newest preview first.
 */
import type { EnhanceOutput } from '@oat/ai/enhance';
import type { JSONContent } from '@oat/editor';

import type { DocumentDetail } from './api-types.ts';

export type EnhancementStatus = 'generating' | 'completed' | 'failed';

export type EnhanceErrorCode =
  /** The model call failed (provider error, rate limit, …). */
  | 'model_error'
  /** The model's answer didn't match the output schema. */
  | 'invalid_output'
  /** Took longer than the job timeout. */
  | 'timeout'
  /** No progress within the staleness window (e.g. the server restarted mid-run). */
  | 'stale'
  /** Another run holds this note's lock. */
  | 'busy'
  /** Anything else on our side. */
  | 'internal';

export type EnhancementDto = {
  id: string;
  documentId: string;
  templateId: string | null;
  status: EnhancementStatus;
  model: string;
  startedAt: string;
  completedAt: string | null;
  /**
   * Completed runs: whether the output became the note body. `false` when the note was edited while the AI
   * was writing — the body was kept and the output saved alongside it (`doc` on the completed event).
   */
  applied: boolean | null;
  /** The note's version after the output was applied. */
  documentVersion: number | null;
  error: { code: EnhanceErrorCode; message: string } | null;
};

export type StartEnhanceInput = {
  /** Client-generated; repeating a request with the same key returns the same run. */
  idempotencyKey: string;
  /** Built-in or a custom template of the note's workspace. Default: the meeting's template, else General. */
  templateId?: string;
  /** IANA zone for dates in the notes, e.g. "Europe/Berlin". Default UTC. */
  timeZone?: string;
};

export type StartEnhanceResult = {
  enhancement: EnhancementDto;
  /** `true` when this request attached to a run that already existed (same key, or already running). */
  attached: boolean;
};

export type EnhanceEvent =
  | { type: 'preview'; output: EnhanceOutput }
  | { type: 'completed'; enhancement: EnhancementDto; doc: JSONContent }
  | { type: 'failed'; enhancement: EnhancementDto };

export const ENHANCE_EVENT_TYPES = ['preview', 'completed', 'failed'] as const;

// Versions, restore and undo (4.5) ---------------------------------------------------------------------

/** A completed run, as a version of the note. */
export type EnhancementVersionDto = EnhancementDto & {
  /** 1 = the oldest completed run of this note. */
  number: number;
  /** The template's name now (`null` if it was deleted). */
  templateName: string | null;
  /** The note body is exactly this run's output right now. */
  current: boolean;
};

/**
 * A body that was about to be replaced (by a regenerate, restore, undo or redo) and matched nothing stored:
 * the user's own edits, kept so no text is ever lost. Restorable like a version.
 */
export type NoteSnapshotDto = {
  id: string;
  createdAt: string;
  /** What replaced it. */
  reason: 'regenerate' | 'restore';
  /** The note version that body had. */
  documentVersion: number;
  /** The note body is exactly this snapshot right now. */
  current: boolean;
};

export type EnhancementVersionList = {
  /** Completed runs, newest first. */
  versions: EnhancementVersionDto[];
  /** Saved edited notes, newest first. */
  snapshots: NoteSnapshotDto[];
  body: {
    version: number;
    /**
     * The note has been enhanced and its body matches no stored output, input notes or snapshot: replacing it
     * now (regenerate / restore / undo) first saves it as a snapshot, and the UI asks before (D-20).
     */
    edited: boolean;
  };
};

export type EnhancementDetail =
  | {
      kind: 'version';
      enhancement: EnhancementVersionDto;
      /** The body this run produced. */
      doc: JSONContent;
      /** The user's own notes the run started from (`input_notes_json`). */
      notes: JSONContent;
    }
  | { kind: 'snapshot'; snapshot: NoteSnapshotDto; doc: JSONContent };

/**
 * `output`: a run's enhanced body (or a snapshot's saved body); `notes`: the user's notes a run started from
 * (undo). Snapshots only take `output`.
 */
export type RestoreTarget = 'output' | 'notes';

export type RestoreEnhancementInput = {
  /** The note version the client has (D-19). */
  baseVersion: number;
  target: RestoreTarget;
};

export type RestoreEnhancementResult = {
  document: DocumentDetail;
  /** The edited body this restore replaced, if it had to be saved first. */
  snapshot: NoteSnapshotDto | null;
};
