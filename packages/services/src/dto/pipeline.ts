/**
 * Post-meeting pipeline API contract (8.3, D-29), shared by the route handlers, the agents and the browser.
 *
 * | Method | Path                                 | Body | Result |
 * |--------|--------------------------------------|------|--------|
 * | GET    | /api/documents/:id/pipeline          | –    | {@link PipelineRunResponse} (read access) |
 * | POST   | /api/documents/:id/pipeline          | –    | {@link PipelineRunResponse}: start (meeting ended, none yet, or ended again) or retry a failed run (edit access) |
 * | GET    | /api/settings/pipeline?workspaceId=  | –    | {@link PipelineSettingsDto} (member) |
 * | PUT    | /api/settings/pipeline               | `{ workspaceId, autoEnhance?, autoSendToNotion? }` | {@link PipelineSettingsDto} |
 */

/** The steps, in order. */
export const PIPELINE_STEPS = ['enhance', 'index', 'notion'] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

/**
 * `waiting`: not handed to the background agents yet (they were unreachable; retried automatically) ·
 * `queued`: accepted, not started · `running` · `completed` · `failed` (retry possible).
 */
export type PipelineRunStatus = 'waiting' | 'queued' | 'running' | 'completed' | 'failed';

export type PipelineStepRecord = {
  step: PipelineStepName;
  /** `ran`: did work. `skipped`: nothing to do, or switched off / not configured (`reason`). */
  outcome: 'ran' | 'skipped';
  reason?: string;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
};

export type PipelineRunDto = {
  id: string;
  meetingId: string;
  documentId: string;
  status: PipelineRunStatus;
  /** 1, +1 per retry. */
  attempt: number;
  /** The step running now. */
  currentStep: PipelineStepName | null;
  steps: PipelineStepRecord[];
  /** Why it failed (user-facing; `failed` only). */
  error: string | null;
  /** A failed run a retry could fix (not, e.g., when the note's owner lost access to it). */
  retryable: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type PipelineRunResponse = {
  run: PipelineRunDto | null;
  /** The meeting has ended (a run can exist or be started). */
  meetingEnded: boolean;
  /** The caller may start / retry it (owner or editor of the note). */
  canRun: boolean;
};

export type PipelineSettingsDto = {
  workspaceId: string;
  /** Enhance the notes when a meeting ends (default on). */
  autoEnhance: boolean;
  /** Send the notes to Notion when a meeting ends (default off); `null`: Notion isn't connected. */
  autoSendToNotion: boolean | null;
};

export type UpdatePipelineSettingsInput = {
  workspaceId: string;
  autoEnhance?: boolean;
  autoSendToNotion?: boolean;
};

/** `error_code` of a failure no retry can fix: the note's owner (whom the pipeline acts as) lost access. */
export const OWNER_NO_ACCESS = 'owner_no_access';

/** `queued`/`running`/`waiting` are live: the client keeps polling. */
export const isLivePipelineStatus = (status: PipelineRunStatus) =>
  status === 'waiting' || status === 'queued' || status === 'running';
