import { Badge } from '@oat/ui/components/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@oat/ui/components/item';
import type { Metadata } from 'next';
import { connection } from 'next/server';

import { SettingsHeading, SettingsList, SettingsSection } from '@/components/settings/section';
import { ThemeTabs } from '@/components/theme-toggle';
import { integrationModes, serverEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'Settings' };

const integrationLabels = {
  ai: 'AI (AI Gateway)',
  stt: 'Speech-to-text (Deepgram)',
  oauth: 'Google sign-in',
  calendar: 'Google Calendar',
} as const;

export default async function SettingsPage() {
  // Explicitly per-request: reads runtime env (not just dynamic because the layout reads cookies).
  await connection();
  const modes = integrationModes(serverEnv());
  const mocked = (Object.keys(integrationLabels) as (keyof typeof integrationLabels)[]).filter(
    (key) => modes[key] !== 'real',
  );

  return (
    <>
      <SettingsHeading>Appearance</SettingsHeading>
      <SettingsList>
        <Item className="flex-col items-stretch sm:flex-row sm:items-center">
          <ItemContent>
            <ItemTitle>Theme</ItemTitle>
            <ItemDescription className="text-copy-13">
              System follows your operating system.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ThemeTabs />
          </ItemActions>
        </Item>
      </SettingsList>

      {/* Only worth showing while something still runs on a local mock (development). */}
      {mocked.length > 0 && (
        <SettingsSection
          title="Environment"
          description={
            <>
              These use local mocks until a key is set in{' '}
              <code className="text-label-13-mono">.env</code>.
            </>
          }
        >
          <SettingsList>
            {mocked.map((key) => (
              <Item key={key} size="sm" className="px-4">
                <ItemContent>
                  <ItemTitle>{integrationLabels[key]}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Badge variant="outline" data-testid={`integration-${key}`}>
                    Local mock
                  </Badge>
                </ItemActions>
              </Item>
            ))}
          </SettingsList>
        </SettingsSection>
      )}
    </>
  );
}
