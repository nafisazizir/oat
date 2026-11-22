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
import type { OatClient } from '@oat/client';
import type { JoinChoices } from '@oat/services/dto/workspaces';
import { type ReactElement, useState, useTransition } from 'react';

import { ROLE_INFO, workspaceIcon } from '@oat/settings-ui/workspace';

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

export function joinChoices(choices: JoinChoices): JoinChoice[] {
  return [
    ...choices.invites.map((invite) => ({
      kind: 'invite' as const,
      key: `invite:${invite.token}`,
      token: invite.token,
      workspace: { name: invite.workspace.name, icon: workspaceIcon(invite.workspace.logo) },
      detail: `${invite.invitedBy} invited you as ${invite.role === 'admin' || invite.role === 'owner' ? 'an' : 'a'} ${ROLE_INFO[invite.role].label.toLowerCase()}`,
    })),
    ...choices.workspaces.map((workspace) => ({
      kind: workspace.option,
      key: `workspace:${workspace.id}`,
      workspaceId: workspace.id,
      workspace: { name: workspace.name, icon: workspaceIcon(workspace.logo) },
      detail:
        workspace.option === 'join'
          ? `${workspace.memberCount} ${workspace.memberCount === 1 ? 'member' : 'members'} · open to your domain`
          : workspace.option === 'request'
            ? `${workspace.memberCount} ${workspace.memberCount === 1 ? 'member' : 'members'} · needs approval`
            : 'Waiting for approval',
    })),
  ];
}

/**
 * The join screen's list (D-36): each row is a workspace with its one action; the first row's is the
 * primary action of the screen, "Create my own workspace" the quiet alternative underneath. Every action
 * is rechecked by the API; hosts own navigation after membership changes.
 */
export function JoinChoiceList({
  choices,
  member = false,
  client,
  onHome,
  onRefresh,
  homeLink,
}: {
  choices: JoinChoice[];
  client: OatClient;
  onHome(joined?: boolean): void | Promise<void>;
  onRefresh(): void | Promise<void>;
  /** They already have a workspace (they came from the workspace menu): offer the way back instead. */
  member?: boolean;
  /** A host link element for "Back to Oat" (web renders a real link to /home). */
  homeLink?: ReactElement;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (id: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await action();
        if (done) setNotice(done);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : 'Couldn’t complete that action. Try again.',
        );
      }
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
                        run(`${choice.key}:decline`, async () => {
                          await client.invites.decline(choice.token);
                          await onRefresh();
                        })
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
                      onClick={() =>
                        run(choice.key, async () => {
                          await client.invites.accept(choice.token);
                          await onHome(true);
                        })
                      }
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
                    onClick={() =>
                      run(choice.key, async () => {
                        await client.workspaces.join(choice.workspaceId);
                        await onHome(true);
                      })
                    }
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
                        async () => {
                          await client.workspaces.requestAccess(choice.workspaceId);
                          await onRefresh();
                        },
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
        {member && homeLink ? (
          <Button
            size="lg"
            variant="ghost"
            className="w-full"
            nativeButton={false}
            role="link"
            render={homeLink}
          >
            Back to Oat
          </Button>
        ) : member ? (
          <Button
            size="lg"
            variant="ghost"
            className="w-full"
            disabled={pending}
            onClick={() =>
              run('back', async () => {
                await onHome();
              })
            }
          >
            Back to Oat
          </Button>
        ) : (
          <Button
            size="lg"
            variant={primary === undefined ? 'default' : 'ghost'}
            className="w-full"
            disabled={pending}
            onClick={() =>
              run('create', async () => {
                await client.workspaces.createMy();
                await onHome(true);
              })
            }
          >
            {spinner('create')}
            Create my own workspace
          </Button>
        )}
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
