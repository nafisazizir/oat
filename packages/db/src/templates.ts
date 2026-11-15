/**
 * Built-in templates in Postgres (task 4.3). The definitions live in `@oat/ai/templates` (`BUILTIN_TEMPLATES`);
 * this package stays below `@oat/ai`, so callers pass them in. Built-ins are ordinary `template` rows with
 * `workspace_id = null` and `is_builtin = true`, so `meeting.template_id` / `enhancement.template_id` reference
 * them like any custom template.
 */
import type { TemplateSection } from '@oat/core';
import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { template } from './schema/index.ts';

export interface BuiltinTemplateRow {
  /** Fixed id (never changes between releases). */
  id: string;
  name: string;
  instructions: string;
  sections: readonly TemplateSection[];
}

export interface UpsertBuiltinsResult {
  /** Ids inserted or changed by this call (empty when everything was already current). */
  written: string[];
  /** Built-in rows in the database whose id is no longer in `builtins` (left in place; see below). */
  stale: string[];
}

/**
 * Inserts missing built-ins and updates ones whose name, description or sections changed. Idempotent: a row
 * that already matches is not touched, so repeated calls write nothing (no `updated_at` bump, no change-log
 * row for sync). Safe to run concurrently (`on conflict … do update … where distinct`).
 *
 * Built-ins dropped from the code are reported as `stale` but not deleted: meetings and enhancements may
 * still reference them (`on delete set null` would silently lose which template made a note).
 */
export async function upsertBuiltinTemplates(
  db: Db,
  builtins: readonly BuiltinTemplateRow[],
): Promise<UpsertBuiltinsResult> {
  if (builtins.length === 0) return { written: [], stale: [] };
  const excluded = (column: string) => sql.raw(`excluded.${column}`);
  const written = await db
    .insert(template)
    .values(
      builtins.map((b) => ({
        id: b.id,
        workspaceId: null,
        name: b.name,
        instructions: b.instructions,
        sectionsJson: b.sections.map((s) => ({ heading: s.heading, instructions: s.instructions })),
        isBuiltin: true,
      })),
    )
    .onConflictDoUpdate({
      target: template.id,
      set: {
        name: excluded('name'),
        instructions: excluded('instructions'),
        sectionsJson: excluded('sections_json'),
        updatedAt: sql`now()`,
      },
      // Only rows that really changed, and never a workspace template that happens to share the id.
      setWhere: sql`${template.isBuiltin} and (
        ${template.name} is distinct from excluded.name or
        ${template.instructions} is distinct from excluded.instructions or
        ${template.sectionsJson} is distinct from excluded.sections_json
      )`,
    })
    .returning({ id: template.id });
  const ids = builtins.map((b) => b.id);
  const stale = await db
    .select({ id: template.id })
    .from(template)
    .where(
      and(
        eq(template.isBuiltin, true),
        isNull(template.workspaceId),
        not(inArray(template.id, ids)),
      ),
    );
  return { written: written.map((r) => r.id), stale: stale.map((r) => r.id) };
}
