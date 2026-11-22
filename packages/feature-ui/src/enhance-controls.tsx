'use client';

import { Button } from '@oat/ui/components/button';
import { TemplatePicker } from '@oat/workspace-ui/template-picker';
import { Alert, AlertAction, AlertTitle } from '@oat/ui/components/alert';
import { ButtonGroup, ButtonGroupSeparator } from '@oat/ui/components/button-group';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle, IconChevronDown, IconRefresh, IconSparkles } from '@tabler/icons-react';

import type { Enhancement } from './use-enhancement';

type StartInput = Parameters<Enhancement['start']>[0];

/**
 * "Enhance" for meeting notes: one click uses the meeting's template (or General); the chevron picks another.
 * Shows progress while a run is going. Once the note has been enhanced it reads "Regenerate" (4.5), and the
 * caller routes starts through `onStart` (to confirm first when that would replace edits) and adds its own
 * menu items (`children`: history, original notes, undo).
 */
export function EnhanceButton({
  enhancement,
  workspaceId,
  regenerate = false,
  onStart,
  children,
}: {
  enhancement: Enhancement;
  workspaceId: string;
  /** The note was enhanced before: label the action "Regenerate". */
  regenerate?: boolean;
  /** Starts a run (default: `enhancement.start`). `undefined` input = the default template. */
  onStart?: (input?: StartInput) => void;
  /** Extra menu items, after the templates. */
  children?: React.ReactNode;
}) {
  const { state } = enhancement;
  const start = onStart ?? ((input?: StartInput) => void enhancement.start(input));
  const busy = state.phase === 'starting' || state.phase === 'streaming';

  return (
    <ButtonGroup>
      <Button
        size="sm"
        variant="secondary"
        data-testid="enhance-button"
        disabled={busy}
        onClick={() => start()}
      >
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : regenerate ? (
          <IconRefresh data-icon="inline-start" />
        ) : (
          <IconSparkles data-icon="inline-start" />
        )}
        {busy ? 'Enhancing…' : regenerate ? 'Regenerate' : 'Enhance'}
      </Button>
      <ButtonGroupSeparator />
      <TemplatePicker
        workspaceId={workspaceId}
        label={regenerate ? 'Regenerate with template' : 'Enhance with template'}
        onSelect={(templateId) => start({ templateId })}
        trigger={
          <Button
            size="icon-sm"
            variant="secondary"
            disabled={busy}
            aria-label={regenerate ? 'Regenerate with a template' : 'Enhance with a template'}
            data-testid="enhance-template-menu"
          >
            <IconChevronDown />
          </Button>
        }
      >
        {children}
      </TemplatePicker>
    </ButtonGroup>
  );
}

/** Error line under the header when a run failed or the stream was lost, with the matching retry. */
export function EnhanceError({ enhancement }: { enhancement: Enhancement }) {
  const { state, retry, reattach, dismiss } = enhancement;
  if (state.phase !== 'failed') return null;
  return (
    <Alert role="alert" variant="destructive" data-testid="enhance-error">
      <IconAlertCircle />
      <AlertTitle className="text-copy-14">{state.message}</AlertTitle>
      <AlertAction className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={state.lost ? reattach : retry}>
          {state.lost ? 'Reconnect' : 'Try again'}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}
