/**
 * Shared domain types for Oat (SPEC §6).
 *
 * Every entity is a zod schema plus its inferred TypeScript type. These are the contract the Postgres schema
 * (`@oat/db`), the desktop SQLite mirror, the API and the UI all agree on:
 *
 * - Field names are camelCase here; storage maps them to snake_case columns.
 * - IDs are opaque non-empty strings (the id scheme is chosen by `@oat/db`).
 * - Nullable columns are `.nullable()` (always present, possibly `null`), never `.optional()`.
 * - Timestamps are `Date`s; the schemas coerce ISO strings so they can parse JSON payloads directly.
 * - Every enum is also exported as a `readonly` tuple (`ROLES`, `DOCUMENT_VISIBILITIES`, …) so other
 *   packages can build their own enums from the same values and tests can assert they match.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------------

export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

const timestamp = z.coerce.date();
const nullableTimestamp = timestamp.nullable();

// ---------------------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------------------

/** Workspace roles, highest privilege first. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/**
 * How people who weren't invited get into a workspace (D-36): not at all, by asking (an owner/admin
 * approves), or straight in as a member. The last two only ever apply to verified emails on one of the
 * workspace's allowed domains.
 */
export const JOIN_POLICIES = ['invite_only', 'request', 'auto_join'] as const;
export const JoinPolicySchema = z.enum(JOIN_POLICIES);
export type JoinPolicy = z.infer<typeof JoinPolicySchema>;

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export const JoinRequestStatusSchema = z.enum(JOIN_REQUEST_STATUSES);
export type JoinRequestStatus = z.infer<typeof JoinRequestStatusSchema>;

export const FOLDER_VISIBILITIES = ['private', 'workspace'] as const;
export const FolderVisibilitySchema = z.enum(FOLDER_VISIBILITIES);
export type FolderVisibility = z.infer<typeof FolderVisibilitySchema>;

/** `link` = workspace visibility plus read-only access for anyone holding the share token. */
export const DOCUMENT_VISIBILITIES = ['private', 'workspace', 'link'] as const;
export const DocumentVisibilitySchema = z.enum(DOCUMENT_VISIBILITIES);
export type DocumentVisibility = z.infer<typeof DocumentVisibilitySchema>;

export const DOCUMENT_KINDS = ['meeting', 'page'] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** `mic` = me, `system` = them (everything the computer plays). */
export const TRANSCRIPT_SOURCES = ['mic', 'system'] as const;
export const TranscriptSourceSchema = z.enum(TRANSCRIPT_SOURCES);
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

export const PARTICIPANT_SOURCES = ['calendar', 'manual'] as const;
export const ParticipantSourceSchema = z.enum(PARTICIPANT_SOURCES);
export type ParticipantSource = z.infer<typeof ParticipantSourceSchema>;

export const CHAT_SCOPES = ['document', 'workspace'] as const;
export const ChatScopeSchema = z.enum(CHAT_SCOPES);
export type ChatScope = z.infer<typeof ChatScopeSchema>;

export const CHAT_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;
export const ChatMessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

// ---------------------------------------------------------------------------------------------------------
// Users, workspaces, membership
// ---------------------------------------------------------------------------------------------------------

export const UserSchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  createdAt: timestamp,
});
export type User = z.infer<typeof UserSchema>;

export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  createdBy: IdSchema,
  createdAt: timestamp,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const MembershipSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  role: RoleSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

export const InviteSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  email: z.email(),
  role: RoleSchema,
  token: z.string().min(1),
  expiresAt: timestamp,
  acceptedAt: nullableTimestamp,
});
export type Invite = z.infer<typeof InviteSchema>;

// ---------------------------------------------------------------------------------------------------------
// Folders and documents
// ---------------------------------------------------------------------------------------------------------

export const FolderSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  parentId: IdSchema.nullable(),
  name: z.string().min(1),
  visibility: FolderVisibilitySchema,
  ownerId: IdSchema,
});
export type Folder = z.infer<typeof FolderSchema>;

export const DocumentSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  folderId: IdSchema.nullable(),
  ownerId: IdSchema,
  kind: DocumentKindSchema,
  title: z.string(),
  /** TipTap JSON — canonical content. Its shape is owned by `@oat/editor`. */
  contentJson: z.unknown(),
  /** Markdown derived from `contentJson`. */
  contentMd: z.string(),
  visibility: DocumentVisibilitySchema,
  /**
   * Secret for `link` visibility: ≥ 22 base64url chars (≥ 128 bits). A fresh token is issued every time the
   * document enters `link` (`shouldRotateShareToken` in permissions.ts).
   */
  shareToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22,}$/, 'share token must be at least 22 base64url characters')
    .nullable(),
  /** Monotonic version for sync/optimistic concurrency. */
  version: z.int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
  /** Soft delete. Non-null = in trash. */
  deletedAt: nullableTimestamp,
});
export type Document = z.infer<typeof DocumentSchema>;

// ---------------------------------------------------------------------------------------------------------
// Meetings and transcripts
// ---------------------------------------------------------------------------------------------------------

export const MeetingSchema = z.object({
  id: IdSchema,
  documentId: IdSchema,
  calendarEventId: z.string().min(1).nullable(),
  startedAt: nullableTimestamp,
  endedAt: nullableTimestamp,
  /** Free-form app/platform label, e.g. "zoom". */
  platform: z.string().min(1).nullable(),
  templateId: IdSchema.nullable(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const ParticipantSchema = z.object({
  meetingId: IdSchema,
  name: z.string().min(1),
  email: z.email().nullable(),
  source: ParticipantSourceSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const TranscriptSegmentSchema = z
  .object({
    id: IdSchema,
    meetingId: IdSchema,
    source: TranscriptSourceSchema,
    speakerLabel: z.string().min(1).nullable(),
    /** Milliseconds on the recording's clock (shared with the local audio archive). */
    startMs: z.int().nonnegative(),
    endMs: z.int().nonnegative(),
    text: z.string(),
    /** `false` = interim result that may still be replaced. */
    isFinal: z.boolean(),
    createdAt: timestamp,
  })
  .refine((s) => s.endMs >= s.startMs, { message: 'endMs must be >= startMs', path: ['endMs'] });
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

// ---------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------

export const TemplateSectionSchema = z.object({
  heading: z.string().min(1),
  /** What the enhancer should put in this section. */
  instructions: z.string(),
});
export type TemplateSection = z.infer<typeof TemplateSectionSchema>;

export const TemplateSchema = z.object({
  id: IdSchema,
  /** `null` for built-in templates available everywhere. */
  workspaceId: IdSchema.nullable(),
  name: z.string().min(1),
  instructions: z.string(),
  sections: z.array(TemplateSectionSchema),
  isBuiltin: z.boolean(),
});
export type Template = z.infer<typeof TemplateSchema>;

// ---------------------------------------------------------------------------------------------------------
// Assistant chat (minimal; message parts are owned by `@oat/ai`)
// ---------------------------------------------------------------------------------------------------------

export const ChatThreadSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    userId: IdSchema,
    scope: ChatScopeSchema,
    documentId: IdSchema.nullable(),
    title: z.string(),
  })
  .refine((t) => (t.scope === 'document') === (t.documentId !== null), {
    message: 'documentId is required for document scope and must be null for workspace scope',
    path: ['documentId'],
  });
export type ChatThread = z.infer<typeof ChatThreadSchema>;

export const ChatMessageSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  role: ChatMessageRoleSchema,
  parts: z.array(z.unknown()),
  createdAt: timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
