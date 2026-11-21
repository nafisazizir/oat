'use client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import { Spinner } from '@oat/ui/components/spinner';
import { useState, useTransition } from 'react';

import { createMyWorkspace, joinWorkspace, requestAccess } from '@/server/actions/joining';
import { acceptInvite, declineInvite } from '@/server/actions/members';

import { WorkspaceAvatar } from './workspace-avatar';

type Common = {
  key: string;
  workspace: { name: string; icon: string | null };
  /** One line under the name: who invited them, or how the workspace lets people in. */
  detail: string;
};

/** One thing the newcomer can do: answer an invitation, join, ask to join — or wait for an answer. */
export type JoinChoice =
  | (Common & { kind: 'invite'; token: string })
  | (Common & { kind: 'join' | 'request' | 'requested'; workspaceId: string });

type Result = { ok: true } | { ok: false; error: string };

/**
 * The join screen's list (D-36): each row is a workspace with its one action; the first row's is the
 * primary action of the screen, "Create my own workspace" the quiet alternative underneath. Every action
 * is a server action that decides again on the server; this only shows what came back.
 */
export function JoinChoiceList({ choices }: { choices: JoinChoice[] }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (id: string, action: () => Promise<Result>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else if (done) setNotice(done);
    });
  };
  const spinner = (id: string) =>
    pending && busy === id ? <Spinner data-icon="inline-start" /> : null;
  // The first thing that can be acted on is the screen's one primary action.
  const primary = choices.find((choice) => choice.kind !== 'requested')?.key;

  return (
    <>
      <ItemGroup className="gap-0" data-testid="join-choices">
        {choices.map((choice) => {
          const variant = choice.key === primary ? 'default' : 'outline';
          return (
            <Item
              key={choice.key}
              role="listitem"
              data-testid="join-choice"
              data-kind={choice.kind}
              className="flex-nowrap rounded-none px-0 py-3 not-last:border-b not-last:border-b-gray-alpha-300"
            >
              <ItemMedia>
                <WorkspaceAvatar workspace={choice.workspace} size="default" />
              </ItemMedia>
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle className="w-full min-w-0 text-label-14">
                  <span className="truncate">{choice.workspace.name}</span>
                </ItemTitle>
                <ItemDescription className="text-copy-13">{choice.detail}</ItemDescription>
              </ItemContent>
              <ItemActions className="shrink-0 gap-1">
                {choice.kind === 'invite' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Decline the invitation to ${choice.workspace.name}`}
                      onClick={() =>
                        run(`${choice.key}:decline`, () => declineInvite(choice.token))
                      }
                    >
                      {spinner(`${choice.key}:decline`)}
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      variant={variant}
                      disabled={pending}
                      aria-label={`Accept the invitation to ${choice.workspace.name}`}
                      onClick={() => run(choice.key, () => acceptInvite(choice.token))}
                    >
                      {spinner(choice.key)}
                      Accept
                    </Button>
                  </>
                )}
                {choice.kind === 'join' && (
                  <Button
                    size="sm"
                    variant={variant}
                    disabled={pending}
                    aria-label={`Join ${choice.workspace.name}`}
                    onClick={() => run(choice.key, () => joinWorkspace(choice.workspaceId))}
                  >
                    {spinner(choice.key)}
                    Join
                  </Button>
                )}
                {choice.kind === 'request' && (
                  <Button
                    size="sm"
                    variant={variant}
                    disabled={pending}
                    aria-label={`Request access to ${choice.workspace.name}`}
                    onClick={() =>
                      run(
                        choice.key,
                        () => requestAccess(choice.workspaceId),
                        `Request sent to ${choice.workspace.name}. We’ll email you when an owner or admin answers.`,
                      )
                    }
                  >
                    {spinner(choice.key)}
                    Request access
                  </Button>
                )}
                {choice.kind === 'requested' && <Badge variant="secondary">Requested</Badge>}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>

      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          variant={primary === undefined ? 'default' : 'ghost'}
          className="w-full"
          disabled={pending}
          onClick={() => run('create', () => createMyWorkspace())}
        >
          {spinner('create')}
          Create my own workspace
        </Button>
        <p role="status" className="text-center text-copy-13 text-gray-900 empty:hidden">
          {notice}
        </p>
        {error && (
          <p role="alert" className="text-center text-copy-14 text-red-900">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
