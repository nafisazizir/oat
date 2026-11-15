/**
 * Enhance API contract (task 4.4, D-20), shared by the route handlers and the browser.
 *
 * | Method | Path                              | Body / headers                                   | Result |
 * |--------|-----------------------------------|--------------------------------------------------|--------|
 * | POST   | /api/documents/:id/enhance        | `{ idempotencyKey, templateId?, timeZone? }`     | 201 `StartEnhanceResult` (new job) · 200 (same key, or a job already running for the note) |
 * | GET    | /api/documents/:id/enhance        | –                                                | `{ latest: EnhancementDto \| null }` |
 * | GET    | /api/enhancements/:id/stream      | `Last-Event-ID` (or `?lastEventId=`) to resume   | `text/event-stream` of {@link EnhanceEvent}s |
 *
 * Starting needs edit access to a live meeting note; reading the latest run and streaming need read access.
 * Anything the caller can't read is 404. Errors use the shared API shape (`ApiErrorBody`).
 *
 * Stream events (`event:` = `type`, `data:` = JSON, `id:` = resume point): `preview` (the whole output so far,
 * origins already derived; each one replaces the previous), then exactly one of `completed` or `failed`, after
 * which the server closes the stream. A reader that attaches late gets the newest preview first.
 */
import type { EnhanceOutput } from '@oat/ai/enhance';
import type { JSONContent } from '@oat/editor';

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
