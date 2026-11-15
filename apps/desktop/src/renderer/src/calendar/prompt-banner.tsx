/**
 * The in-app "Start notes?" banner (7.3), shown with the native notification while main has a prompt: a
 * meeting app took the mic (D-21) or a meeting with attendees is about to start. "Start notes" makes (or
 * reopens) the note and starts recording it — the note opens by itself once recording runs.
 */
import type { MeetingPrompt } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { BellRingIcon, Loader2Icon, NotebookPenIcon } from 'lucide-react';
import { useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';

export function PromptBanner({
  prompt,
  recording,
}: {
  prompt: MeetingPrompt | null;
  /** The dev input choice (`startRequest`), so a fixture choice applies here too. */
  recording: { input?: 'sidecar' | 'file'; fixture?: string };
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ promptId: string; message: string } | null>(null);
  if (!prompt) return null;
  const shown = prompt;

  async function respond(action: 'start' | 'dismiss' | 'silence') {
    setPending(action);
    setError(null);
    try {
      await call('prompt:respond', {
        promptId: shown.id,
        action,
        ...(action === 'start' ? recording : {}),
      });
    } catch (e) {
      setError({
        promptId: shown.id,
        message: e instanceof BridgeCallError ? e.message : 'Couldn’t start notes.',
      });
    } finally {
      setPending(null);
    }
  }

  const title =
    prompt.kind === 'starting'
      ? `${prompt.title || 'Your meeting'} starts in a minute`
      : `Start notes for ${prompt.title}?`;
  const detail =
    prompt.kind === 'starting'
      ? 'Start notes to record and transcribe it.'
      : `${prompt.appName ?? 'A meeting app'} is using your microphone.`;
  const busy = pending !== null;

  return (
    <div
      role="alertdialog"
      aria-labelledby="meeting-prompt-title"
      aria-describedby="meeting-prompt-detail"
      data-testid="meeting-prompt"
      data-kind={prompt.kind}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-accent/60 px-6 py-2.5"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <BellRingIcon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <p id="meeting-prompt-title" className="truncate text-sm font-medium">
          {title}
        </p>
        <p id="meeting-prompt-detail" className="truncate text-xs text-muted-foreground">
          {detail}
          {error?.promptId === prompt.id && (
            <span role="alert" className="ml-1 text-destructive">
              {error.message}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {prompt.appId && prompt.appName && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => void respond('silence')}
          >
            Don’t ask for {prompt.appName}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('dismiss')}>
          Not now
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void respond('start')}>
          {pending === 'start' ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <NotebookPenIcon data-icon="inline-start" />
          )}
          Start notes
        </Button>
      </div>
    </div>
  );
}
