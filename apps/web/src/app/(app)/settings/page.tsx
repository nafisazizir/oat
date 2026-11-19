import { Badge } from '@oat/ui/components/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import { IconChevronRight, IconPlugConnected, IconUser } from '@tabler/icons-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';

import { PageContainer, PageHeader } from '@/components/page';
import { SettingsList, SettingsSection } from '@/components/settings/section';
import { ThemeTabs } from '@/components/theme-toggle';
import { WorkspaceAvatar } from '@/components/workspace/workspace-avatar';
import { integrationModes, serverEnv } from '@/lib/env';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Settings' };

const integrationLabels = {
  ai: 'AI (AI Gateway)',
  stt: 'Speech-to-text (Deepgram)',
  oauth: 'Google sign-in',
  calendar: 'Google Calendar',
} as const;

const ICON_TILE =
  'flex size-8 items-center justify-center rounded-md border border-gray-alpha-400 text-gray-1000 [&_svg]:size-4';

/** A settings row that opens a sub-page: the whole row is the link. */
function LinkRow({
  href,
  media,
  title,
  description,
  testId,
}: {
  href: Route;
  media: React.ReactNode;
  title: string;
  description: string;
  testId?: string;
}) {
  return (
    <Item
      render={<Link href={href} data-testid={testId} />}
      className="transition-colors duration-fast outline-none hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:ring-inset"
    >
      <ItemMedia>{media}</ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0">
          <span className="truncate">{title}</span>
        </ItemTitle>
        <ItemDescription className="truncate text-copy-13">{description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight aria-hidden className="size-4 text-gray-900" />
      </ItemActions>
    </Item>
  );
}

export default async function SettingsPage() {
  // Explicitly per-request: reads runtime env (not just dynamic because the layout reads cookies).
  await connection();
  const modes = integrationModes(serverEnv());
  const mocked = (Object.keys(integrationLabels) as (keyof typeof integrationLabels)[]).filter(
    (key) => modes[key] !== 'real',
  );
  const { workspace } = await getShellData();

  return (
    <PageContainer>
      <PageHeader title="Settings" />

      <SettingsList aria-label="Settings pages">
        <LinkRow
          href="/settings/profile"
          testId="settings-profile-link"
          media={
            <span className={ICON_TILE}>
              <IconUser />
            </span>
          }
          title="About me"
          description="Your role, focus and names to spell right. The AI uses it."
        />
        <LinkRow
          href="/settings/workspace"
          media={<WorkspaceAvatar workspace={workspace} size="default" />}
          title={workspace.name}
          description={
            workspace.kind === 'personal'
              ? 'Personal workspace, just for you'
              : 'Team workspace · name, icon, members and invites'
          }
        />
        <LinkRow
          href="/settings/integrations"
          media={
            <span className={ICON_TILE}>
              <IconPlugConnected />
            </span>
          }
          title="Integrations"
          description="Google Calendar, Notion and what happens after a meeting"
        />
      </SettingsList>

      <SettingsSection title="Appearance">
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
      </SettingsSection>

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
    </PageContainer>
  );
}
