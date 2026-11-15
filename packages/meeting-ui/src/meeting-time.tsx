'use client';

/**
 * The meeting's time line under its title: "Thu, Nov 14 · 3:04 PM · 12 min", or "In progress · 5 min" while
 * it is being recorded (ticks every 30 s), or "Not recorded yet".
 */
import { cn } from '@oat/ui/lib/utils';
import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { meetingWhen } from './format.ts';

export function MeetingTime({
  startedAt,
  endedAt,
  live = false,
  timeZone,
  className,
}: {
  startedAt: string | null;
  endedAt: string | null;
  /** Being recorded right now (the desktop knows; the web infers it from a missing end). */
  live?: boolean;
  /** `undefined` = the viewer's zone. */
  timeZone?: string;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const when = meetingWhen(startedAt, live ? null : endedAt, now, timeZone);
  const ticking = live || when.inProgress;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);

  return (
    <p
      className={cn('flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground', className)}
      data-testid="meeting-time"
      data-in-progress={ticking || undefined}
    >
      <ClockIcon aria-hidden className="size-3.5" />
      {when.label ? (
        <>
          {/* Day and time get the same separator (and spacing) as the duration after them. */}
          <time dateTime={startedAt ?? undefined} className="inline-flex flex-wrap gap-1.5">
            {when.label.split(' · ').map((part, i) => (
              <span key={i} className="inline-flex gap-1.5">
                {i > 0 && <span aria-hidden>·</span>}
                {part}
              </span>
            ))}
          </time>
          {when.duration && (
            <>
              <span aria-hidden>·</span>
              <span data-testid="meeting-duration">
                {ticking ? `In progress · ${when.duration}` : when.duration}
              </span>
            </>
          )}
        </>
      ) : (
        <span>Not recorded yet</span>
      )}
    </p>
  );
}
