/**
 * Postgres enums. Values come from the `@oat/core` tuples so the database can never drift from the domain
 * contract; enums core doesn't define yet (storage/job states) are declared here.
 */
import {
  CHAT_MESSAGE_ROLES,
  CHAT_SCOPES,
  DOCUMENT_KINDS,
  DOCUMENT_VISIBILITIES,
  FOLDER_VISIBILITIES,
  PARTICIPANT_SOURCES,
  ROLES,
  TRANSCRIPT_SOURCES,
  WORKSPACE_KINDS,
} from '@oat/core';
import { pgEnum } from 'drizzle-orm/pg-core';

/** Better Auth organization-plugin invitation states (its `invitation.status`). */
export const INVITE_STATUSES = ['pending', 'accepted', 'rejected', 'canceled'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** D-20 enhancement job states. */
export const ENHANCEMENT_STATUSES = ['generating', 'completed', 'failed'] as const;
export type EnhancementStatus = (typeof ENHANCEMENT_STATUSES)[number];

/** SPEC §6 `integration.provider`. */
export const INTEGRATION_PROVIDERS = ['notion', 'google', 'slack'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** `change_log.op` (D-19): the row was inserted/updated, or hard-deleted. */
export const CHANGE_OPS = ['upsert', 'delete'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

/** What a retrieval chunk was cut from (6.1): the notes body (block ids) or the transcript (segment ids). */
export const CHUNK_SOURCES = ['notes', 'transcript'] as const;
export type ChunkSource = (typeof CHUNK_SOURCES)[number];

export const roleEnum = pgEnum('role', ROLES);
export const workspaceKindEnum = pgEnum('workspace_kind', WORKSPACE_KINDS);
export const inviteStatusEnum = pgEnum('invite_status', INVITE_STATUSES);
export const folderVisibilityEnum = pgEnum('folder_visibility', FOLDER_VISIBILITIES);
export const documentVisibilityEnum = pgEnum('document_visibility', DOCUMENT_VISIBILITIES);
export const documentKindEnum = pgEnum('document_kind', DOCUMENT_KINDS);
export const transcriptSourceEnum = pgEnum('transcript_source', TRANSCRIPT_SOURCES);
export const participantSourceEnum = pgEnum('participant_source', PARTICIPANT_SOURCES);
export const enhancementStatusEnum = pgEnum('enhancement_status', ENHANCEMENT_STATUSES);
export const chatScopeEnum = pgEnum('chat_scope', CHAT_SCOPES);
export const chatMessageRoleEnum = pgEnum('chat_message_role', CHAT_MESSAGE_ROLES);
export const integrationProviderEnum = pgEnum('integration_provider', INTEGRATION_PROVIDERS);
export const changeOpEnum = pgEnum('change_op', CHANGE_OPS);
export const chunkSourceEnum = pgEnum('chunk_source', CHUNK_SOURCES);

/** Post-meeting pipeline run states (8.3; lifecycle on `pipeline_run`). */
export const PIPELINE_RUN_STATUSES = [
  'waiting',
  'queued',
  'running',
  'completed',
  'failed',
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];
export const pipelineRunStatusEnum = pgEnum('pipeline_run_status', PIPELINE_RUN_STATUSES);
