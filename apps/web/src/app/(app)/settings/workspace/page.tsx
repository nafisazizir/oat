import type { Metadata } from 'next';

import { WebSettingsPanel } from '@/components/settings/web-settings';

export const metadata: Metadata = { title: 'Workspace settings' };

export default function Page() {
  return <WebSettingsPanel active="workspace" />;
}
