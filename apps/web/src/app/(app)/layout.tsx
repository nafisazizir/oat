import { cookies } from 'next/headers';

import { AppShell } from '@/components/app-shell/app-shell';
import { requireSession } from '@/server/session';
import { getShellData } from '@/server/shell';

/** Cookie written by @oat/ui's SidebarProvider whenever the sidebar is toggled. */
const SIDEBAR_COOKIE = 'sidebar_state';

/**
 * Signed-in frame. The session is checked first (no session → `/sign-in`; `src/proxy.ts` already
 * redirects requests without a cookie, this catches expired/revoked ones). `getShellData()` loads the
 * user, their workspaces and the active workspace's tree (documents: 3.3).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const [cookieStore, data] = await Promise.all([cookies(), getShellData()]);
  const defaultOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== 'false';
  return (
    <AppShell data={data} defaultOpen={defaultOpen}>
      {children}
    </AppShell>
  );
}
