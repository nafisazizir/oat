'use client';

import type { OatClient } from '@oat/client';
import type { JoinChoices } from '@oat/services/dto/workspaces';
import {
  AuthContent,
  AuthDescription,
  AuthHeader,
  AuthPanel,
  AuthTitle,
} from '@oat/ui/components/auth-layout';
import { Button } from '@oat/ui/components/button';
import { useEffect, useState } from 'react';
import { JoinChoiceList, joinChoices } from './join-choices';

export type JoinSnapshot = { member: boolean; choices: JoinChoices };

export async function loadJoinSnapshot(client: OatClient): Promise<JoinSnapshot> {
  const [list, choices] = await Promise.all([
    client.workspaces.list(),
    client.workspaces.joinable(),
  ]);
  return { member: list.workspaces.length > 0, choices };
}

export function JoinWorkspace({
  client,
  email,
  initial,
  onHome,
}: {
  client: OatClient;
  email: string;
  initial?: JoinSnapshot;
  onHome(joined?: boolean): void | Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(!initial);
  useEffect(() => {
    if (initial && revision === 0) return;
    let active = true;
    void (async () => {
      try {
        const next = await loadJoinSnapshot(client);
        if (!active) return;
        if (!next.choices.invites.length && !next.choices.workspaces.length) {
          if (!next.member) await client.workspaces.createMy();
          if (active) await onHome(!next.member);
        }
        if (active) setSnapshot(next);
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Couldn’t load workspaces.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, initial, revision, onHome]);

  async function refresh() {
    const next = await loadJoinSnapshot(client);
    setSnapshot(next);
    if (!next.choices.invites.length && !next.choices.workspaces.length) {
      if (!next.member) await client.workspaces.createMy();
      await onHome(!next.member);
    }
  }

  return (
    <AuthPanel data-testid="join-screen">
      <AuthHeader>
        <AuthTitle>
          <h1>Join a workspace</h1>
        </AuthTitle>
        <AuthDescription>
          You’re signed in as{' '}
          <span className="block truncate text-gray-1000" title={email}>
            {email}
          </span>
        </AuthDescription>
      </AuthHeader>
      <AuthContent className="gap-6">
        {loading && <p role="status">Loading workspaces…</p>}
        {error ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-copy-14 text-red-900">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setLoading(true);
                setRevision((v) => v + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          snapshot && (
            <JoinChoiceList
              choices={joinChoices(snapshot.choices)}
              member={snapshot.member}
              client={client}
              onHome={onHome}
              onRefresh={refresh}
            />
          )
        )}
      </AuthContent>
    </AuthPanel>
  );
}
