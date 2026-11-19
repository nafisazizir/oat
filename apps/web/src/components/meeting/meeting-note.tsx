'use client';

/**
 * A meeting note on the web (3.4): the document editor with the meeting header under its title (when it was
 * recorded, attendees — editable by editors) and the transcript beside it in a collapsible, resizable panel
 * (a section under the note on narrow screens). Same pieces as the desktop (`@oat/meeting-ui`).
 *
 * - `?t=<s>&seg=<id>` (citations, transcript search hits, 6.4) opens the panel at that line, highlighted.
 * - Clicking a line picks it: the URL becomes that line's deep link (shareable; the jump target for audio
 *   playback in 3.7) without a server round trip.
 * - While the meeting is still being recorded on a desktop, the panel polls for new lines every 5 s.
 * - No player here (3.7): audio never leaves the Mac that recorded it (D-10), and the panel says so.
 */
import {
  MeetingTime,
  ParticipantChips,
  SidePanel,
  type TranscriptItem,
  TranscriptList,
  useStoredState,
} from '@oat/meeting-ui';
import { IN_PROGRESS_MAX_MS } from '@oat/meeting-ui/format';
import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconDeviceLaptop, IconLayoutSidebarRight, IconWaveSine } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { AssistantToggleAnchor } from '@/components/assistant/document-assistant';
import { DocumentEditor } from '@/components/document/document-editor';
import type { DocumentDetail } from '@/lib/api-types';
import { appendLines, type MeetingInfo, meetingApi, participantError } from '@/lib/meeting';
import { type DeepLinkFocus, focusedLine, segmentHref, wantsTranscript } from '@/lib/transcript';
import { useHydrated } from '@/lib/use-hydrated';
import type { WorkspaceAudience } from '@/lib/workspace';

const OPEN_KEY = 'oat.transcript.open';
const WIDTH_KEY = 'oat.transcript.width';
const POLL_MS = 5_000;
/** `lg`: from here on the transcript is a column beside the note; below, a section under it. */
const WIDE = '(min-width: 64rem)';

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/** Recorded but not ended, recently: a desktop may still be recording it. */
function maybeLive(info: MeetingInfo, now: number): boolean {
  if (!info.startedAt || info.endedAt) return false;
  const started = Date.parse(info.startedAt);
  return Number.isFinite(started) && now - started < IN_PROGRESS_MAX_MS;
}

export function MeetingNote({
  document: doc,
  workspace,
  initial,
  focus,
  eventLine,
}: {
  document: DocumentDetail;
  workspace: WorkspaceAudience;
  initial: MeetingInfo;
  focus: DeepLinkFocus;
  /** The calendar event the note was started from ("Scheduled … · Join"), streamed in by the page. */
  eventLine?: React.ReactNode;
}) {
  const hydrated = useHydrated();
  const wide = useWide();
  const [info, setInfo] = useState(initial);
  const lines = useMemo(() => info.transcript ?? [], [info.transcript]);
  const editable = doc.access.edit && doc.deletedAt === null;

  // Panel open: remembered per browser; a transcript deep link always opens it.
  const [open, setOpen] = useStoredState<boolean>(OPEN_KEY, true);
  const linkKey = wantsTranscript(focus) ? `${focus.seg ?? ''}|${focus.t ?? ''}` : null;
  useEffect(() => {
    if (linkKey) setOpen(true);
  }, [linkKey, setOpen]);

  // The highlighted line: from the deep link, then whatever the user clicks.
  const linked = useMemo(() => focusedLine(lines, focus), [lines, focus]);
  const [picked, setPicked] = useState<{ id: string; link: string | null } | null>(null);
  const focusId = picked && picked.link === linkKey ? picked.id : linked;
  const select = useCallback(
    (segment: TranscriptItem) => {
      setPicked({ id: segment.id, link: linkKey });
      // Shareable moment link without a server round trip (Next.js keeps its router in sync).
      window.history.replaceState(null, '', segmentHref(doc.id, segment.startMs, segment.id));
    },
    [doc.id, linkKey],
  );

  // Still being recorded somewhere: every few seconds, fetch the lines from the last one on (and times,
  // attendees). Stops once the meeting has ended (or after the in-progress cap, re-checked on every poll).
  const [now, setNow] = useState(() => Date.now());
  const polling = maybeLive(info, now);
  const lastStart = lines.at(-1)?.startMs ?? 0;
  useEffect(() => {
    if (!polling) return;
    let stop = false;
    const timer = setTimeout(() => {
      meetingApi
        .get(doc.id, { transcript: true, after: lastStart })
        .then((next) => {
          if (stop) return;
          setInfo((current) => ({
            ...next,
            transcript: appendLines(current.transcript ?? [], next.transcript ?? [], lastStart),
          }));
          setNow(Date.now());
        })
        .catch(() => !stop && setNow(Date.now()));
    }, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [polling, doc.id, lastStart, now]);

  const items = useMemo<TranscriptItem[]>(
    () =>
      lines.map((l) => ({
        id: l.id,
        source: l.source,
        startMs: l.startMs,
        text: l.text,
        ...(l.source === 'system' && l.speaker !== 'Them' ? { speaker: l.speaker } : {}),
      })),
    [lines],
  );

  const header = (
    <div className="flex flex-col gap-2.5" data-testid="meeting-header">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <MeetingTime
          startedAt={info.startedAt}
          endedAt={info.endedAt}
          // Server render + hydration in UTC (they must agree), then the viewer's zone.
          {...(hydrated ? {} : { timeZone: 'UTC' })}
        />
        {!open && (
          <Button
            variant="ghost"
            size="sm"
            className="-me-2 ms-auto"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            data-testid="transcript-toggle"
          >
            <IconLayoutSidebarRight data-icon="inline-start" />
            Transcript
            {lines.length > 0 && <span className="text-gray-900 tabular-nums">{lines.length}</span>}
          </Button>
        )}
      </div>
      {eventLine}
      <ParticipantChips
        participants={info.participants}
        editable={editable && hydrated}
        onAdd={async (input) => {
          try {
            const added = await meetingApi.addParticipant(doc.id, input);
            setInfo((i) => ({ ...i, participants: [...i.participants, added] }));
          } catch (error) {
            throw participantError(error);
          }
        }}
        onRemove={async (p) => {
          try {
            await meetingApi.removeParticipant(doc.id, p.id);
            setInfo((i) => ({ ...i, participants: i.participants.filter((x) => x.id !== p.id) }));
          } catch (error) {
            throw participantError(error);
          }
        }}
      />
    </div>
  );

  const transcript = (
    <TranscriptBody items={items} focusId={focusId} onSelect={select} live={polling} />
  );

  return (
    <div className="flex min-w-0 flex-1">
      {/* At least the window's height, so "Ask about this note" sits at its bottom (9.3b). */}
      <div className="flex min-h-[calc(100svh-3rem)] min-w-0 flex-1 flex-col">
        <DocumentEditor document={doc} workspace={workspace} meta={header} />
        {open && !wide && (
          <section
            aria-label="Transcript"
            data-testid="transcript-panel"
            className="mx-auto mb-14 flex h-96 w-full max-w-content flex-col overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-100"
          >
            <PanelTitle count={lines.length} onClose={() => setOpen(false)} />
            {transcript}
          </section>
        )}
        {/* "Ask about this note" floats over the note column, never over the transcript panel. */}
        <AssistantToggleAnchor className="mt-auto" />
      </div>
      {open && wide && (
        <SidePanel
          title={
            <>
              <IconWaveSine aria-hidden className="size-4 text-gray-900" />
              Transcript
            </>
          }
          meta={
            lines.length > 0 && (
              <span className="text-label-13 text-gray-900 tabular-nums">{lines.length}</span>
            )
          }
          closeLabel="Hide transcript"
          onClose={() => setOpen(false)}
          storageKey={WIDTH_KEY}
          defaultWidth={360}
          minWidth={280}
          maxWidth={600}
          className="sticky top-12 h-[calc(100svh-3rem)] self-start"
          data-testid="transcript-panel"
        >
          {transcript}
        </SidePanel>
      )}
    </div>
  );
}

function PanelTitle({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-alpha-400 ps-4 pe-2">
      <IconWaveSine aria-hidden className="size-4 text-gray-900" />
      <h2 className="text-label-14 text-gray-1000">Transcript</h2>
      {count > 0 && <span className="text-label-13 text-gray-900 tabular-nums">{count}</span>}
      <Button variant="ghost" size="sm" className="ms-auto" onClick={onClose}>
        Hide
      </Button>
    </header>
  );
}

function TranscriptBody({
  items,
  focusId,
  onSelect,
  live,
}: {
  items: TranscriptItem[];
  focusId: string | undefined;
  onSelect: (segment: TranscriptItem) => void;
  live: boolean;
}) {
  if (items.length === 0) {
    return (
      <Empty className="px-8 py-10" data-testid="transcript-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconWaveSine aria-hidden className={cn('text-gray-900', live && 'animate-pulse')} />
          </EmptyMedia>
          <EmptyTitle className="text-heading-16">
            {live ? 'Waiting for the transcript…' : 'No transcript'}
          </EmptyTitle>
          <EmptyDescription className="max-w-xs">
            {live
              ? 'This meeting is being recorded on a desktop. Lines appear here as they sync.'
              : 'Record this meeting with the Oat desktop app to get a transcript here.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <p
        className="flex shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 px-4 py-1.5 text-label-12 text-gray-900"
        data-testid="audio-hint"
        title="Recordings are kept only on the Mac that recorded the meeting. Open the note in the Oat desktop app there to listen back."
      >
        <IconDeviceLaptop aria-hidden className="size-3.5 shrink-0" />
        Audio is on the Mac that recorded this meeting
      </p>
      <TranscriptList
        segments={items}
        focusId={focusId}
        onSelect={onSelect}
        follow={live && !focusId}
        className="min-h-0"
      />
    </>
  );
}
