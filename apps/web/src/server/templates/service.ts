/**
 * Templates data access + authorization (task 4.3). Every function takes the database and the caller's
 * `@oat/core` permission context; route handlers (`api.ts`) and server pages call these, never the table
 * directly. Rules (see `src/lib/templates.ts`):
 *
 * - built-ins: readable by any signed-in user, never writable (`builtin_read_only`);
 * - custom: read = member of the template's workspace; create/edit/delete = `createInWorkspace`
 *   (owner/admin/member); anything in a workspace the caller isn't in is 404, not 403.
 */
import {
  BUILTIN_TEMPLATES,
  copyName,
  type TemplateInput,
  type TemplatePatch,
} from '@oat/ai/templates';
import {
  assertCan,
  canCreateInWorkspace,
  type PermissionContext,
  roleIn,
  type WorkspaceAccess,
} from '@oat/core';
import { type Db, template, type TemplateRow, upsertBuiltinTemplates, workspace } from '@oat/db';
import { and, asc, eq } from 'drizzle-orm';

import type { TemplateDetail, TemplateDto, TemplateList } from '@/lib/templates';

import { ApiError, notFound } from '../api/errors';

/** 403 for any write to a built-in. */
export const builtinReadOnly = () =>
  new ApiError(
    403,
    'builtin_read_only',
    'Built-in templates can’t be changed. Duplicate it to make your own version.',
  );

// ---------------------------------------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------------------------------------

const builtinsReady = new WeakMap<Db, Promise<void>>();

/**
 * Makes sure the built-ins exist (and match the code) in this database, once per process. The upsert is a
 * no-op when they're current, so a cold start costs one round trip. A failure is retried on the next call.
 */
export function ensureBuiltinTemplates(db: Db): Promise<void> {
  let ready = builtinsReady.get(db);
  if (!ready) {
    ready = upsertBuiltinTemplates(db, BUILTIN_TEMPLATES).then(
      () => undefined,
      (error: unknown) => {
        builtinsReady.delete(db);
        throw error;
      },
    );
    builtinsReady.set(db, ready);
  }
  return ready;
}

/** Display order of the built-ins (the order in `@oat/ai/templates`). */
const BUILTIN_ORDER = new Map(BUILTIN_TEMPLATES.map((t, i) => [t.id, i]));

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

export function toDto(row: TemplateRow): TemplateDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    instructions: row.instructions,
    sections: row.sectionsJson.map((s) => ({ heading: s.heading, instructions: s.instructions })),
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const isMember = (ctx: PermissionContext, workspaceId: string) =>
  roleIn(ctx, workspaceId) !== undefined;

/** The workspace's permission-relevant fields, or 404 when the caller isn't a member (or it's gone). */
async function memberWorkspace(
  db: Db,
  ctx: PermissionContext,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  if (!isMember(ctx, workspaceId)) throw notFound('Workspace');
  const [row] = await db
    .select({ id: workspace.id, kind: workspace.kind })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (!row) throw notFound('Workspace');
  return row;
}

async function findRow(db: Db, id: string): Promise<TemplateRow | undefined> {
  const [row] = await db.select().from(template).where(eq(template.id, id));
  return row;
}

/** A template the caller may read, or 404. */
async function readable(db: Db, ctx: PermissionContext, id: string): Promise<TemplateRow> {
  await ensureBuiltinTemplates(db);
  const row = await findRow(db, id);
  if (!row) throw notFound();
  if (row.isBuiltin) return row;
  if (row.workspaceId === null || !isMember(ctx, row.workspaceId)) throw notFound();
  return row;
}

/** A custom template the caller may edit: 404 if unreadable, 403 for built-ins and viewers. */
async function editable(db: Db, ctx: PermissionContext, id: string): Promise<TemplateRow> {
  const row = await readable(db, ctx, id);
  if (row.isBuiltin || row.workspaceId === null) throw builtinReadOnly();
  assertCan('createInWorkspace', ctx, await memberWorkspace(db, ctx, row.workspaceId));
  return row;
}

async function customNames(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ name: template.name })
    .from(template)
    .where(eq(template.workspaceId, workspaceId));
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------

/** Built-ins (in their fixed order) and the workspace's custom templates (by name). */
export async function listTemplates(
  db: Db,
  ctx: PermissionContext,
  workspaceId: string,
): Promise<TemplateList> {
  const ws = await memberWorkspace(db, ctx, workspaceId);
  await ensureBuiltinTemplates(db);
  const [builtins, custom] = await Promise.all([
    db.select().from(template).where(eq(template.isBuiltin, true)),
    db
      .select()
      .from(template)
      .where(and(eq(template.workspaceId, workspaceId), eq(template.isBuiltin, false)))
      .orderBy(asc(template.name), asc(template.createdAt)),
  ]);
  return {
    // Only the built-ins this release defines (a retired one stays in the DB for old references).
    builtins: builtins
      .filter((r) => BUILTIN_ORDER.has(r.id))
      .toSorted((a, b) => BUILTIN_ORDER.get(a.id)! - BUILTIN_ORDER.get(b.id)!)
      .map(toDto),
    custom: custom.map(toDto),
    canCreate: canCreateInWorkspace(ctx, ws),
  };
}

/**
 * One template. `workspaceId` is the workspace the caller is browsing from: for a built-in it decides
 * `canDuplicate` (a built-in has no workspace of its own).
 */
export async function getTemplate(
  db: Db,
  ctx: PermissionContext,
  id: string,
  options: { workspaceId?: string | null } = {},
): Promise<TemplateDetail> {
  const row = await readable(db, ctx, id);
  const own = row.workspaceId === null ? null : await memberWorkspace(db, ctx, row.workspaceId);
  const browsing =
    own ??
    (options.workspaceId && isMember(ctx, options.workspaceId)
      ? await memberWorkspace(db, ctx, options.workspaceId)
      : null);
  return {
    template: toDto(row),
    canEdit: !row.isBuiltin && own !== null && canCreateInWorkspace(ctx, own),
    canDuplicate: browsing !== null && canCreateInWorkspace(ctx, browsing),
  };
}

export async function createTemplate(
  db: Db,
  ctx: PermissionContext,
  workspaceId: string,
  input: TemplateInput,
): Promise<TemplateDetail> {
  assertCan('createInWorkspace', ctx, await memberWorkspace(db, ctx, workspaceId));
  const [row] = await db
    .insert(template)
    .values({
      workspaceId,
      name: input.name,
      instructions: input.instructions,
      sectionsJson: input.sections,
      isBuiltin: false,
    })
    .returning();
  return { template: toDto(row!), canEdit: true, canDuplicate: true };
}

/**
 * Copies a readable template (built-in or custom, from any workspace the caller is in) into `workspaceId`
 * as a new custom template named "<name> (copy)".
 */
export async function duplicateTemplate(
  db: Db,
  ctx: PermissionContext,
  workspaceId: string,
  fromTemplateId: string,
): Promise<TemplateDetail> {
  assertCan('createInWorkspace', ctx, await memberWorkspace(db, ctx, workspaceId));
  const source = await readable(db, ctx, fromTemplateId);
  const name = copyName(source.name, await customNames(db, workspaceId));
  return createTemplate(db, ctx, workspaceId, {
    name,
    instructions: source.instructions,
    sections: source.sectionsJson,
  });
}

export async function updateTemplate(
  db: Db,
  ctx: PermissionContext,
  id: string,
  patch: TemplatePatch,
): Promise<TemplateDetail> {
  await editable(db, ctx, id);
  const [row] = await db
    .update(template)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.instructions !== undefined && { instructions: patch.instructions }),
      ...(patch.sections !== undefined && { sectionsJson: patch.sections }),
    })
    .where(and(eq(template.id, id), eq(template.isBuiltin, false)))
    .returning();
  if (!row) throw notFound();
  return { template: toDto(row), canEdit: true, canDuplicate: true };
}

/** Deletes a custom template. Meetings that used it keep their notes; their `template_id` becomes null. */
export async function deleteTemplate(db: Db, ctx: PermissionContext, id: string): Promise<void> {
  await editable(db, ctx, id);
  await db.delete(template).where(and(eq(template.id, id), eq(template.isBuiltin, false)));
}
