import 'server-only';

import { loadActor } from '../actor';
import { getDb } from '../db';
import { requireSession } from '../session';
import { type ConflictDetail, getConflict } from './conflicts';

/**
 * For `/d/[id]`: the conflict this document is a copy of, if it is a live conflicted copy the user can
 * read (3.5) — the page then shows the conflict banner. `null` for every other document.
 */
export async function loadConflictForPage(documentId: string): Promise<ConflictDetail | null> {
  const session = await requireSession();
  const db = getDb();
  return getConflict(db, await loadActor(db, session.user.id), documentId);
}
