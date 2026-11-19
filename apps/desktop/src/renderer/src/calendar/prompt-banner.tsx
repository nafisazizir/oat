/**
 * The in-app "Start notes?" banner (7.3), shown with the native notification while main has a prompt: a
 * meeting app took the mic (D-21) or a meeting with attendees is about to start. "Start notes" makes (or
 * reopens) the note and starts recording it — the note opens by itself once recording runs.
 */
import type { MeetingPrompt } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconBellRinging, IconNotes } from '@tabler/icons-react';
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
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-alpha-400 bg-brand-100 py-2.5 ps-6 pe-4"
    >
      <IconBellRinging aria-hidden className="size-4 shrink-0 text-brand-900" />
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <p id="meeting-prompt-title" className="truncate text-label-14 text-gray-1000">
          {title}
        </p>
        <p id="meeting-prompt-detail" className="truncate text-label-13 text-gray-900">
          {detail}
          {error?.promptId === prompt.id && (
            <span role="alert" className="ms-1 text-red-900">
              {error.message}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {prompt.appId && prompt.appName && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('silence')}>
            Don’t ask for {prompt.appName}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('dismiss')}>
          Not now
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void respond('start')}>
          {pending === 'start' ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconNotes data-icon="inline-start" />
          )}
          Start notes
        </Button>
      </div>
    </div>
  );
}
