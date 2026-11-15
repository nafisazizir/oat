import 'server-only';

import { loadPermissionContext } from '@oat/auth';
import { cache } from 'react';

import type { TemplateDetail, TemplateList } from '@/lib/templates';

import { getDb } from '../db';
import { requireSession } from '../session';
import { getShellData } from '../shell';
import { ApiError } from '../api/errors';
import { getTemplate, listTemplates } from './service';

/** The signed-in caller, their permission context and the active workspace (deduped per request). */
const caller = cache(async () => {
  const [{ user }, shell] = await Promise.all([requireSession(), getShellData()]);
  const db = getDb();
  const ctx = await loadPermissionContext(db, user.id);
  return { db, ctx, workspace: shell.workspace };
});

/** `/templates`: built-ins + the active workspace's custom templates. */
export async function loadTemplateList(): Promise<
  TemplateList & { workspace: { id: string; name: string; kind: 'personal' | 'team' } }
> {
  const { db, ctx, workspace } = await caller();
  return { ...(await listTemplates(db, ctx, workspace.id)), workspace };
}

/** `/templates/[id]`, or `null` when it doesn't exist or the caller can't read it (→ 404 page). */
export const loadTemplate = cache(
  async (
    id: string,
  ): Promise<
    (TemplateDetail & { workspace: { id: string; name: string; kind: 'personal' | 'team' } }) | null
  > => {
    const { db, ctx, workspace } = await caller();
    try {
      return { ...(await getTemplate(db, ctx, id, { workspaceId: workspace.id })), workspace };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
);

/** `/templates/new`: may the caller create templates in the active workspace? */
export async function loadNewTemplate() {
  const { db, ctx, workspace } = await caller();
  const { canCreate } = await listTemplates(db, ctx, workspace.id);
  return { canCreate, workspace };
}
