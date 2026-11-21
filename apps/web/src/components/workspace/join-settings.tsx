'use client';

import type { JoinPolicy } from '@oat/core';
import { Button } from '@oat/ui/components/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@oat/ui/components/field';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@oat/ui/components/item';
import { RadioGroup, RadioGroupItem } from '@oat/ui/components/radio-group';
import { Spinner } from '@oat/ui/components/spinner';
import { IconPlus } from '@tabler/icons-react';
import { useOptimistic, useTransition } from 'react';
import { toast } from 'sonner';

import { SettingsSection } from '@/components/settings/section';
import { allowMyDomain, removeAllowedDomain, setJoinPolicy } from '@/server/actions/joining';
import type { JoiningView } from '@/server/workspace-settings';

const POLICIES: { value: JoinPolicy; label: string; detail: string }[] = [
  {
    value: 'invite_only',
    label: 'Invite only',
    detail: 'People join when an owner or admin invites them.',
  },
  {
    value: 'request',
    label: 'Request access',
    detail:
      'People with an allowed email domain can ask to join. An owner or admin approves and picks their role.',
  },
  {
    value: 'auto_join',
    label: 'Join automatically',
    detail: 'People with an allowed email domain can join right away, as members.',
  },
];

/**
 * Who can join without an invitation (D-36): the policy and the allowed email domains. Owners and admins
 * only (the page doesn't render it for anyone else). Changes save right away; the server decides each one
 * again. The only domain that can be added is the viewer's own — there is no field to type one into.
 */
export function WorkspaceJoinSettings({
  workspaceId,
  joining,
}: {
  workspaceId: string;
  joining: JoiningView;
}) {
  const [policy, setPolicy] = useOptimistic(joining.policy);
  const [saving, startSaving] = useTransition();
  const [changingDomains, startDomains] = useTransition();
  const { ownDomain, domains } = joining;
  const open = policy !== 'invite_only';

  const changePolicy = (next: JoinPolicy) => {
    startSaving(async () => {
      setPolicy(next);
      const result = await setJoinPolicy({ workspaceId, policy: next });
      if (!result.ok) toast.error('Couldn’t save that setting', { description: result.error });
      else toast.success('Join setting saved');
    });
  };

  return (
    <SettingsSection
      title="Joining"
      description="Who can join this workspace without an invitation."
      data-testid="join-settings"
    >
      <FieldSet disabled={saving}>
        <FieldLegend className="sr-only">Who can join</FieldLegend>
        <RadioGroup
          value={policy}
          disabled={saving}
          className="gap-1"
          onValueChange={(value) => {
            const next = POLICIES.find((p) => p.value === value)?.value;
            if (next && next !== policy) changePolicy(next);
          }}
        >
          {POLICIES.map((option) => (
            <FieldLabel
              key={option.value}
              className="rounded-md transition-colors hover:bg-gray-alpha-100 has-data-checked:bg-gray-alpha-100 has-[>[data-slot=field]]:border-0 has-data-disabled:cursor-not-allowed has-data-disabled:hover:bg-transparent"
            >
              <Field orientation="horizontal" className="items-start px-3 py-2.5">
                <RadioGroupItem
                  value={option.value}
                  className="mt-0.5"
                  data-testid={`join-policy-${option.value}`}
                />
                <FieldContent className="gap-0">
                  <FieldTitle>{option.label}</FieldTitle>
                  <FieldDescription className="text-copy-13">{option.detail}</FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>

      <div className="flex flex-col gap-1" data-testid="join-domains">
        <h3 className="text-label-14 text-gray-1000">Allowed email domains</h3>
        <p className="text-copy-13 text-gray-900">
          {domains.length === 0
            ? open
              ? 'No domain is allowed yet, so nobody can find this workspace. Add yours below.'
              : 'Only verified addresses on these domains count. Used when people can request access or join automatically.'
            : 'Only verified addresses on these domains count. Public mail services can’t be added.'}
        </p>
        {domains.length > 0 && (
          <ItemGroup className="gap-0" aria-label="Allowed email domains">
            {domains.map((domain) => (
              <Item
                key={domain}
                role="listitem"
                data-testid="join-domain"
                className="rounded-none px-0 py-2 not-last:border-b not-last:border-b-gray-alpha-300"
              >
                <ItemContent>
                  <ItemTitle className="text-label-14-mono">{domain}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={changingDomains}
                    aria-label={`Remove ${domain}`}
                    onClick={() =>
                      startDomains(async () => {
                        const result = await removeAllowedDomain({ workspaceId, domain });
                        if (!result.ok) {
                          toast.error('Couldn’t remove the domain', { description: result.error });
                        } else toast.success(`${domain} removed`);
                      })
                    }
                  >
                    Remove
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {ownDomain.domain === null ? (
          <p className="text-copy-13 text-gray-900" data-testid="join-own-domain-note">
            {ownDomain.reason === 'public'
              ? 'You’re signed in with a public mail address, so there’s no domain of yours to add. An owner or admin with a work address can add theirs.'
              : 'Verify your email address to add its domain.'}
          </p>
        ) : (
          !ownDomain.listed && (
            <div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={changingDomains}
                onClick={() =>
                  startDomains(async () => {
                    const result = await allowMyDomain(workspaceId);
                    if (!result.ok) {
                      toast.error('Couldn’t add the domain', { description: result.error });
                    } else toast.success(`${ownDomain.domain} allowed`);
                  })
                }
              >
                {changingDomains ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <IconPlus data-icon="inline-start" />
                )}
                Allow {ownDomain.domain}
              </Button>
            </div>
          )
        )}
      </div>
    </SettingsSection>
  );
}
