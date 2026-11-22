import type { Metadata } from 'next';

import { WebSettingsPanel } from '@/components/settings/web-settings';
import { calendarConnectErrorMessage } from '@/lib/calendar-errors';
import { notionConnectErrorMessage } from '@/lib/notion-client';

export const metadata: Metadata = { title: 'Integrations' };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; notion_error?: string }>;
}) {
  const { connected, error, notion_error } = await searchParams;
  return (
    <WebSettingsPanel
      active="integrations"
      notice={{
        connected:
          connected === 'notion' || connected === 'google-calendar' ? connected : undefined,
        calendarError: calendarConnectErrorMessage(error),
        notionError: notionConnectErrorMessage(notion_error),
      }}
    />
  );
}
