import type { Metadata } from 'next';

import { WebSettingsPanel } from '@/components/settings/web-settings';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <WebSettingsPanel active="preferences" />;
}
