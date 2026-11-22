import { WebSettingsShell } from '@/components/settings/web-settings';
import { getShellData } from '@/server/shell';

export default async function SettingsRootLayout({ children }: { children: React.ReactNode }) {
  const { workspace } = await getShellData();
  return <WebSettingsShell workspace={workspace}>{children}</WebSettingsShell>;
}
