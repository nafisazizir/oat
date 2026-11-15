import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHAT_SCOPES,
  ChatMessageSchema,
  ChatThreadSchema,
  DOCUMENT_KINDS,
  DOCUMENT_VISIBILITIES,
  DocumentSchema,
  FOLDER_VISIBILITIES,
  FolderSchema,
  InviteSchema,
  MeetingSchema,
  MembershipSchema,
  PARTICIPANT_SOURCES,
  ParticipantSchema,
  ROLES,
  RoleSchema,
  TemplateSchema,
  TRANSCRIPT_SOURCES,
  TranscriptSegmentSchema,
  UserSchema,
  WORKSPACE_KINDS,
  WorkspaceSchema,
  type Document,
  type Role,
} from './types.ts';

const NOW = '2026-11-14T10:00:00.000Z';

const validDocument = {
  id: 'doc_1',
  workspaceId: 'ws_1',
  folderId: null,
  ownerId: 'user_1',
  kind: 'meeting',
  title: 'Weekly sync',
  contentJson: { type: 'doc', content: [] },
  contentMd: '',
  visibility: 'link',
  shareToken: 'Zx3_k9-QpL2mN8vR4tY6wA',
  version: 3,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

describe('enums', () => {
  it('exposes the SPEC §6 values', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(WORKSPACE_KINDS).toEqual(['personal', 'team']);
    expect(FOLDER_VISIBILITIES).toEqual(['private', 'workspace']);
    expect(DOCUMENT_VISIBILITIES).toEqual(['private', 'workspace', 'link']);
    expect(DOCUMENT_KINDS).toEqual(['meeting', 'page']);
    expect(TRANSCRIPT_SOURCES).toEqual(['mic', 'system']);
    expect(PARTICIPANT_SOURCES).toEqual(['calendar', 'manual']);
    expect(CHAT_SCOPES).toEqual(['document', 'workspace']);
  });

  it('schemas accept exactly the tuple values', () => {
    expect(RoleSchema.options).toEqual([...ROLES]);
    expect(RoleSchema.safeParse('superuser').success).toBe(false);
    expectTypeOf<Role>().toEqualTypeOf<'owner' | 'admin' | 'member' | 'viewer'>();
  });
});

describe('DocumentSchema', () => {
  it('parses a JSON payload and coerces timestamps', () => {
    const doc = DocumentSchema.parse(validDocument);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.createdAt.toISOString()).toBe(NOW);
    expectTypeOf(doc).toEqualTypeOf<Document>();
  });

  it.each([
    ['unknown visibility', { visibility: 'public' }],
    ['empty id', { id: '' }],
    ['missing nullable field', { deletedAt: undefined }],
    ['empty share token', { shareToken: '' }],
    ['short share token (21 chars)', { shareToken: 'Zx3_k9-QpL2mN8vR4tY6w' }],
    ['non-base64url share token', { shareToken: 'Zx3_k9+QpL2mN8vR4tY6wA' }],
    ['negative version', { version: -1 }],
    ['fractional version', { version: 1.5 }],
    ['invalid date', { updatedAt: 'not a date' }],
  ])('rejects %s', (_label, patch) => {
    expect(DocumentSchema.safeParse({ ...validDocument, ...patch }).success).toBe(false);
  });
});

describe('other entities', () => {
  it('parse valid values', () => {
    expect(() =>
      UserSchema.parse({ id: 'u', email: 'a@b.co', name: null, image: null, createdAt: NOW }),
    ).not.toThrow();
    expect(() =>
      WorkspaceSchema.parse({
        id: 'w',
        name: 'Personal',
        kind: 'personal',
        createdBy: 'u',
        createdAt: NOW,
      }),
    ).not.toThrow();
    expect(() =>
      MembershipSchema.parse({ workspaceId: 'w', userId: 'u', role: 'viewer' }),
    ).not.toThrow();
    expect(() =>
      InviteSchema.parse({
        id: 'i',
        workspaceId: 'w',
        email: 'x@y.co',
        role: 'member',
        token: 't',
        expiresAt: NOW,
        acceptedAt: null,
      }),
    ).not.toThrow();
    expect(() =>
      FolderSchema.parse({
        id: 'f',
        workspaceId: 'w',
        parentId: null,
        name: 'Clients',
        visibility: 'private',
        ownerId: 'u',
      }),
    ).not.toThrow();
    expect(() =>
      MeetingSchema.parse({
        id: 'm',
        documentId: 'd',
        calendarEventId: null,
        startedAt: NOW,
        endedAt: null,
        platform: 'zoom',
        templateId: null,
      }),
    ).not.toThrow();
    expect(() =>
      ParticipantSchema.parse({ meetingId: 'm', name: 'Sam', email: null, source: 'calendar' }),
    ).not.toThrow();
    expect(() =>
      TemplateSchema.parse({
        id: 't',
        workspaceId: null,
        name: '1:1',
        instructions: '',
        sections: [{ heading: 'Action items', instructions: 'Owner + due date' }],
        isBuiltin: true,
      }),
    ).not.toThrow();
    expect(() =>
      ChatMessageSchema.parse({
        id: 'c',
        threadId: 't',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi' }],
        createdAt: NOW,
      }),
    ).not.toThrow();
  });

  it('rejects a link-less folder visibility', () => {
    expect(
      FolderSchema.safeParse({
        id: 'f',
        workspaceId: 'w',
        parentId: null,
        name: 'x',
        visibility: 'link',
        ownerId: 'u',
      }).success,
    ).toBe(false);
  });
});

describe('TranscriptSegmentSchema', () => {
  const seg = {
    id: 's',
    meetingId: 'm',
    source: 'mic',
    speakerLabel: null,
    startMs: 1000,
    endMs: 2500,
    text: 'hello',
    isFinal: true,
    createdAt: NOW,
  };

  it('accepts a valid segment', () => {
    expect(TranscriptSegmentSchema.parse(seg).source).toBe('mic');
  });

  it.each([
    ['end before start', { endMs: 999 }],
    ['negative start', { startMs: -1 }],
    ['unknown source', { source: 'speaker' }],
  ])('rejects %s', (_label, patch) => {
    expect(TranscriptSegmentSchema.safeParse({ ...seg, ...patch }).success).toBe(false);
  });
});

describe('ChatThreadSchema', () => {
  const thread = { id: 't', workspaceId: 'w', userId: 'u', title: '' };

  it('requires documentId exactly for document scope', () => {
    expect(
      ChatThreadSchema.safeParse({ ...thread, scope: 'document', documentId: 'd' }).success,
    ).toBe(true);
    expect(
      ChatThreadSchema.safeParse({ ...thread, scope: 'workspace', documentId: null }).success,
    ).toBe(true);
    expect(
      ChatThreadSchema.safeParse({ ...thread, scope: 'document', documentId: null }).success,
    ).toBe(false);
    expect(
      ChatThreadSchema.safeParse({ ...thread, scope: 'workspace', documentId: 'd' }).success,
    ).toBe(false);
  });
});
