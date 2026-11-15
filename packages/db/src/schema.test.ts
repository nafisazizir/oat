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
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.ts';

/** Every pg enum whose values are owned by `@oat/core`. */
const CORE_ENUMS = [
  [schema.roleEnum, ROLES],
  [schema.workspaceKindEnum, WORKSPACE_KINDS],
  [schema.folderVisibilityEnum, FOLDER_VISIBILITIES],
  [schema.documentVisibilityEnum, DOCUMENT_VISIBILITIES],
  [schema.documentKindEnum, DOCUMENT_KINDS],
  [schema.transcriptSourceEnum, TRANSCRIPT_SOURCES],
  [schema.participantSourceEnum, PARTICIPANT_SOURCES],
  [schema.chatScopeEnum, CHAT_SCOPES],
  [schema.chatMessageRoleEnum, CHAT_MESSAGE_ROLES],
] as const;

const tables = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable =>
  is(v, PgTable),
);

describe('schema', () => {
  it.each(CORE_ENUMS.map(([e, values]) => [e.enumName, e, values] as const))(
    'enum %s matches @oat/core',
    (_name, pgEnum, values) => {
      expect(pgEnum.enumValues).toEqual([...values]);
    },
  );

  it('has every SPEC §6 table plus Better Auth and sync tables', () => {
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(
      [
        'account',
        'action_item',
        'change_log',
        'chat_message',
        'chat_thread',
        'chunk',
        'document',
        'document_export',
        'document_snapshot',
        'enhancement',
        'folder',
        'integration',
        'invite',
        'meeting',
        'membership',
        'participant',
        'session',
        'sync_receipt',
        'template',
        'transcript_segment',
        'user',
        'user_profile',
        'verification',
        'workspace',
      ].sort(),
    );
  });

  it('uses snake_case column names and text ids everywhere', () => {
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        expect(column.name, `${getTableName(table)}.${column.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      const id = getTableColumns(table).id;
      if (id) expect(id.getSQLType(), getTableName(table)).toBe('text');
    }
  });

  it('timestamps are timestamptz', () => {
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.columnType === 'PgTimestamp') {
          expect(column.getSQLType(), `${getTableName(table)}.${column.name}`).toBe(
            'timestamp with time zone',
          );
        }
      }
    }
  });

  it('client-generated segment ids have no default (D-19)', () => {
    expect(schema.transcriptSegment.id.hasDefault).toBe(false);
    expect(schema.document.id.hasDefault).toBe(true);
  });
});
