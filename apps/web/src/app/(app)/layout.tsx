import { cookies } from 'next/headers';

import { AppShell } from '@/components/app-shell/app-shell';
import { getShellData } from '@/server/shell';

/** Cookie written by @oat/ui's SidebarProvider whenever the sidebar is toggled. */
const SIDEBAR_COOKIE = 'sidebar_state';

/**
 * Signed-in frame. The seam for later tasks:
 * - 1.6 (auth): resolve the session at the top of this function and `redirect('/sign-in')` when there
 *   is none, then pass the user/workspace to `getShellData`.
 * - 3.3 (data): only the body of `getShellData()` in `src/server/shell.ts` changes.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [cookieStore, data] = await Promise.all([cookies(), getShellData()]);
  const defaultOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== 'false';
  return (
    <AppShell data={data} defaultOpen={defaultOpen}>
      {children}
    </AppShell>
  );
}
