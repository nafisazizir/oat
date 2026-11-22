import type { OatClient } from '@oat/client';
import { Badge } from '@oat/ui/components/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@oat/ui/components/item';
import { useCallback } from 'react';

import { useSettingsResource } from './resource';
import { SettingsHeading, SettingsList, SettingsSection } from './section';
import { ThemeMenu } from './theme-menu';
import type { ThemePreference } from './theme';

const integrationLabels = {
  ai: 'AI (AI Gateway)',
  stt: 'Speech-to-text (Deepgram)',
  oauth: 'Google sign-in',
  calendar: 'Google Calendar',
} as const;

export function AppearancePanel({
  client,
  theme,
  setTheme,
}: {
  client: OatClient;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => client.settings.environment({ signal }),
    [client],
  );
  const { value } = useSettingsResource(load);
  const mocked =
    value && 'data' in value
      ? (Object.keys(integrationLabels) as (keyof typeof integrationLabels)[]).filter(
          (key) => value.data[key] === 'mock',
        )
      : [];

  return (
    <>
      <SettingsHeading>Appearance</SettingsHeading>
      <SettingsList>
        <Item>
          <ItemContent>
            <ItemTitle>Theme</ItemTitle>
            <ItemDescription className="text-copy-13">
              System follows your operating system.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ThemeMenu theme={theme} setTheme={setTheme} showValue />
          </ItemActions>
        </Item>
      </SettingsList>
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
              <Item key={key} size="sm">
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
