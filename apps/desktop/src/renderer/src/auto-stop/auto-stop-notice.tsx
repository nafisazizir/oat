/**
 * Auto-stop's notices in the main window (7.5):
 * - `stopping`: a toast over the meeting view — "Stopping the recording in 8 s · Your meeting ended" with a
 *   draining bar and "Keep recording" (undo); main stops when the time is up.
 * - `ask`: a strip above the meeting view like the "Start notes?" banner — "Meeting over?" with "Keep going" and
 *   "Stop recording".
 * Answers go to main (`autostop:respond`); main pushes the notice away (`autostop:changed`).
 */
import type { AutoStopNoticeSnapshot } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { CircleStopIcon, Loader2Icon, MicIcon, TimerIcon } from 'lucide-react';
import { useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { useSecondsLeft } from './auto-stop-state.ts';

function useRespond(notice: AutoStopNoticeSnapshot) {
  const [pending, setPending] = useState<'keep' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function respond(action: 'keep' | 'stop') {
    setPending(action);
    setError(null);
    try {
      await call('autostop:respond', { id: notice.id, action });
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.');
    } finally {
      setPending(null);
    }
  }
  return { pending, error, respond };
}

/** The "Meeting over?" strip (rendered above the meeting view). */
export function AutoStopQuestion({ notice }: { notice: AutoStopNoticeSnapshot | null }) {
  if (!notice || notice.kind !== 'ask') return null;
  return <Question key={notice.id} notice={notice} />;
}

function Question({ notice }: { notice: AutoStopNoticeSnapshot }) {
  const { pending, error, respond } = useRespond(notice);
  const detail =
    notice.reason === 'silence'
      ? 'Oat hasn’t heard anything for a while and is still recording.'
      : 'The call ended and Oat is still recording.';
  return (
    <div
      role="alertdialog"
      aria-labelledby="autostop-question-title"
      aria-describedby="autostop-question-detail"
      data-testid="autostop-question"
      data-reason={notice.reason}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-accent/60 px-6 py-2.5"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <MicIcon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <p id="autostop-question-title" className="truncate text-sm font-medium">
          Meeting over?
        </p>
        <p id="autostop-question-detail" className="truncate text-xs text-muted-foreground">
          {detail}
          {error && (
            <span role="alert" className="ml-1 text-destructive">
              {error}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          onClick={() => void respond('keep')}
        >
          Keep going
        </Button>
        <Button size="sm" disabled={pending !== null} onClick={() => void respond('stop')}>
          {pending === 'stop' ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <CircleStopIcon data-icon="inline-start" />
          )}
          Stop recording
        </Button>
      </div>
    </div>
  );
}

/** The "Stopping…" undo toast (rendered in a `relative` container; floats at its bottom). */
export function AutoStopToast({ notice }: { notice: AutoStopNoticeSnapshot | null }) {
  if (!notice || notice.kind !== 'stopping' || notice.stopAt === null) return null;
  return <Toast key={notice.id} notice={notice} stopAt={notice.stopAt} />;
}

function Toast({ notice, stopAt }: { notice: AutoStopNoticeSnapshot; stopAt: number }) {
  const { pending, error, respond } = useRespond(notice);
  const seconds = useSecondsLeft(stopAt) ?? 0;
  const total = Math.max(1, stopAt - notice.at);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-6">
      <div
        role="status"
        aria-live="assertive"
        data-testid="autostop-toast"
        data-reason={notice.reason}
        className="pointer-events-auto relative flex w-full max-w-md items-center gap-3 overflow-hidden rounded-xl border bg-popover px-4 py-3 text-popover-foreground shadow-lg"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <TimerIcon aria-hidden className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm font-medium">
            Stopping the recording in <span className="tabular-nums">{seconds}</span> s
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {error ? (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            ) : notice.reason === 'silence' ? (
              'Nothing has been heard for a while.'
            ) : (
              'Your meeting ended.'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => void respond('keep')}
        >
          Keep recording
        </Button>
        {/* Drains over the undo window (static under reduced motion: the seconds count down anyway). */}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary motion-safe:animate-[autostop-drain_linear_forwards]"
          style={{ animationDuration: `${total}ms` }}
        />
      </div>
    </div>
  );
}
