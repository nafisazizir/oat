import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import { Separator } from '@oat/ui/components/separator';
import { ChevronRightIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';

import { PageContainer, PageHeader } from '@/components/page';
import { ThemeTabs } from '@/components/theme-toggle';
import { integrationModes, serverEnv } from '@/lib/env';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Settings' };

const integrationLabels = {
  ai: 'AI (AI Gateway)',
  stt: 'Speech-to-text (Deepgram)',
  oauth: 'Google sign-in',
  calendar: 'Google Calendar',
} as const;

function Row({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">{label}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export default async function SettingsPage() {
  // Explicitly per-request: reads runtime env (not just dynamic because the layout reads cookies).
  await connection();
  const modes = integrationModes(serverEnv());
  const { workspace: currentWorkspace } = await getShellData();

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Appearance, workspace and environment." />

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how Oat looks on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <Row label="Theme" hint="System follows your operating system.">
            <ThemeTabs />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>The workspace you’re in now.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          <Row
            label={currentWorkspace.name}
            hint={
              currentWorkspace.kind === 'personal'
                ? 'Personal workspace, just for you.'
                : 'Team workspace: name, icon, members and invites.'
            }
          >
            <Button asChild variant="outline">
              <Link href="/settings/workspace">
                {currentWorkspace.kind === 'personal' ? 'About this workspace' : 'Manage workspace'}
              </Link>
            </Button>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
          <CardDescription>Google Calendar shows your upcoming meetings on Home.</CardDescription>
        </CardHeader>
        <CardContent>
          <Row label="Calendar" hint="Connect or disconnect Google Calendar.">
            <Button variant="outline" asChild>
              <Link href="/settings/integrations">
                Manage integrations
                <ChevronRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
          <CardDescription>
            Integrations use local mocks until a key is set in{' '}
            <code className="font-mono">.env</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {(Object.keys(integrationLabels) as (keyof typeof integrationLabels)[]).map(
            (key, index) => (
              <div key={key}>
                {index > 0 && <Separator className="my-3" />}
                <div className="flex items-center justify-between gap-4">
                  <span>{integrationLabels[key]}</span>
                  <Badge
                    variant={modes[key] === 'real' ? 'default' : 'outline'}
                    data-testid={`integration-${key}`}
                  >
                    {modes[key] === 'real' ? 'Live' : 'Local mock'}
                  </Badge>
                </div>
              </div>
            ),
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
