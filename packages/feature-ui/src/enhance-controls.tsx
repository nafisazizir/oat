'use client';

import { Button } from '@oat/ui/components/button';
import { TemplatePicker } from '@oat/workspace-ui/template-picker';
import { Alert, AlertAction, AlertTitle } from '@oat/ui/components/alert';
import { ButtonGroup, ButtonGroupSeparator } from '@oat/ui/components/button-group';
import { DropdownMenuItem } from '@oat/ui/components/dropdown-menu';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';

import type { Enhancement } from './use-enhancement';

type StartInput = Parameters<Enhancement['start']>[0];

/**
 * "Enhance" for meeting notes. Before the first run it is a split button: one click uses the meeting's
 * template (or General); the chevron picks another. Once the note has been enhanced (4.5) it becomes a
 * single "Enhanced" menu button: the top row names the current template with a Regenerate action, then
 * the templates, then any caller items (`children`). The caller routes starts through `onStart` (to confirm
 * first when that would replace edits). Shows progress while a run is going.
 */
export function EnhanceButton({
  enhancement,
  workspaceId,
  regenerate = false,
  currentTemplate,
  size = 'xs',
  onStart,
  children,
}: {
  enhancement: Enhancement;
  workspaceId: string;
  /** The note was enhanced before: show the "Enhanced" menu, with Regenerate inside it. */
  regenerate?: boolean;
  /** Name of the template the current notes were written with: the menu's top row. */
  currentTemplate?: string | null;
  /** Button size: `xs` (h-6) matches the metadata pill row under the title. */
  size?: 'xs' | 'sm';
  /** Starts a run (default: `enhancement.start`). `undefined` input = the default template. */
  onStart?: (input?: StartInput) => void;
  /** Extra menu items, after the templates. */
  children?: React.ReactNode;
}) {
  const { state } = enhancement;
  const start = onStart ?? ((input?: StartInput) => void enhancement.start(input));
  const busy = state.phase === 'starting' || state.phase === 'streaming';

  if (regenerate) {
    return (
      <TemplatePicker
        workspaceId={workspaceId}
        label="Templates"
        align="start"
        onSelect={(templateId) => start({ templateId })}
        leading={
          <DropdownMenuItem
            nativeButton
            label="Regenerate"
            aria-label="Regenerate"
            title="Regenerate"
            data-testid="enhance-regenerate"
            onClick={() => start()}
            render={({ className, ...buttonProps }) => (
              <div className={className}>
                <IconSparkles aria-hidden />
                <span className="min-w-0 flex-1 truncate" data-testid="enhance-current-template">
                  {currentTemplate ?? 'Enhanced notes'}
                </span>
                <Button {...buttonProps} variant="ghost" size="icon-xs">
                  <IconRefresh aria-hidden />
                </Button>
                <IconCheck aria-hidden className="text-gray-900" />
              </div>
            )}
          />
        }
        trigger={
          <Button
            size={size}
            shape="rounded"
            variant="secondary"
            disabled={busy}
            data-testid="enhance-button"
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconSparkles data-icon="inline-start" />
            )}
            {busy ? 'Enhancing…' : 'Enhanced'}
            <IconChevronDown data-icon="inline-end" />
          </Button>
        }
      >
        {children}
      </TemplatePicker>
    );
  }

  return (
    <ButtonGroup>
      <Button
        size={size}
        shape="rounded"
        variant="secondary"
        data-testid="enhance-button"
        disabled={busy}
        onClick={() => start()}
      >
        {busy ? <Spinner data-icon="inline-start" /> : <IconSparkles data-icon="inline-start" />}
        {busy ? 'Enhancing…' : 'Enhance'}
      </Button>
      <ButtonGroupSeparator />
      <TemplatePicker
        workspaceId={workspaceId}
        label="Enhance with template"
        onSelect={(templateId) => start({ templateId })}
        trigger={
          <Button
            size={size === 'xs' ? 'icon-xs' : 'icon-sm'}
            shape="rounded"
            variant="secondary"
            disabled={busy}
            aria-label="Enhance with a template"
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
