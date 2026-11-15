import { loadConflictForPage } from '@/server/sync/page';

import { ConflictBanner } from './conflict-banner';

/**
 * Server component: the conflicted-copy banner (3.5) if this document is a live conflicted copy, else
 * nothing. Rendered inside its own `<Suspense>` so the page never waits for it (an extra await before the
 * page's first render left duplicated editor DOM behind after a reload in e2e).
 */
export async function ConflictBannerSlot({ documentId }: { documentId: string }) {
  const conflict = await loadConflictForPage(documentId);
  return conflict ? <ConflictBanner conflict={conflict} /> : null;
}
