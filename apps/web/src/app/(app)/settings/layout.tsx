import { SettingsLayout } from '@oat/ui/components/settings-layout';

import { SettingsNav } from '@/components/settings/settings-nav';
import { getShellData } from '@/server/shell';

export default async function SettingsRootLayout({ children }: { children: React.ReactNode }) {
  const { workspace } = await getShellData();
  return (
    <SettingsLayout navigation={<SettingsNav workspace={workspace.name} />}>
      {children}
    </SettingsLayout>
  );
}
