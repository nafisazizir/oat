/**
 * The desktop meeting note (3.4): recording bar on top; below it the note — editable title, when it was
 * recorded, attendees, and my notes (`OatEditor`, autosaved into the local database and synced, 2.6) — with
 * the transcript in a collapsible, resizable panel on the right (live while this note is being recorded,
 * the stored transcript otherwise). Nothing open: a start screen ("Start recording" makes a new note).
 * A recorded note plays its local audio (3.7): the player sits on top of the transcript, a click on a line
 * seeks there and the line under the playhead is highlighted (`audio-player.tsx`).
 */
import type { InvokeResponse, MeetingNote, RecordingSnapshot } from '@oat/core/bridge';
import { sameDocumentContent } from '@oat/core/sync';
import { OatEditor } from '@oat/editor/react';
import {
  activeSegmentAt,
  MeetingTime,
  mergeTranscripts,
  ParticipantChips,
  SidePanel,
  type TranscriptItem,
  useStoredState,
} from '@oat/meeting-ui';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  AlertCircleIcon,
  AudioLinesIcon,
  CheckIcon,
  EyeIcon,
  Loader2Icon,
  LockIcon,
  NotebookPenIcon,
  PanelRightOpenIcon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { NoteEventLine } from '../calendar/note-event-line.tsx';
import { IssueBanner, RecordingBar } from '../recording/recording-controls.tsx';
import { TranscriptPanel } from '../recording/transcript-panel.tsx';
import { useTranscript } from '../recording-state.ts';
import { isActive } from '../recording-view.ts';
import { PlaybackBar, playerKey, useMeetingPlayback } from './audio-player.tsx';
import {
  registerFlush,
  useMeetingNote,
  useStoredTranscript,
  useTranscriptStatus,
} from './meetings-state.ts';
import { type AutosaveState, NoteAutosave } from './note-autosave.ts';

type Content = MeetingNote['contentJson'];

export function MeetingView({
  documentId,
  snapshot,
  options,
  input,
  onInputChange,
}: {
  documentId: string | null;
  snapshot: RecordingSnapshot | null;
  options: InvokeResponse<'recording:options'> | null;
  input: string;
  onInputChange: (choice: string) => void;
}) {
  const { note, loaded } = useMeetingNote(documentId);
  const live = useTranscript();
  const meetingId = note?.meetingId ?? null;
  const recordingThis =
    meetingId !== null && snapshot?.meetingId === meetingId && isActive(snapshot.status);
  const stored = useStoredTranscript(documentId, !recordingThis);
  const transcriptStatus = useTranscriptStatus(documentId ? meetingId : null);
  const [panelOpen, setPanelOpen] = useStoredState<boolean>('oat.desktop.transcript.open', true);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const segments = useMemo<TranscriptItem[]>(() => {
    if (!documentId) return [];
    const storedItems: TranscriptItem[] = stored.segments.map((s) => ({
      id: s.id,
      source: s.source,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      ...(s.speaker ? { speaker: s.speaker } : {}),
    }));
    return meetingId && live.meetingId === meetingId
      ? mergeTranscripts(storedItems, live.segments)
      : storedItems;
  }, [documentId, stored.segments, meetingId, live.meetingId, live.segments]);

  // Playback (3.7): only a note with a meeting, and not while it is being recorded (the bar above says so).
  const { audioRef, player } = useMeetingPlayback(
    documentId && meetingId && !recordingThis ? meetingId : null,
  );
  const playable = player.available && !recordingThis;
  // Re-renders only when the highlighted line changes, not on every frame of the playhead.
  const activeId = useSyncExternalStore(player.clock.subscribe, () =>
    playable ? activeSegmentAt(segments, player.clock.ms) : undefined,
  );

  // Home (no note open) shows the recording's state; a note shows it only while it is the one recorded.
  const showsRecording = documentId === null || recordingThis;
  const followLive = recordingThis || (meetingId !== null && live.meetingId === meetingId);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Meeting">
      <audio ref={audioRef} preload="metadata" hidden data-testid="playback-audio" />
      <div className="flex flex-col gap-3 border-b px-6 py-3">
        <RecordingBar
          snapshot={snapshot}
          options={options}
          input={input}
          onInputChange={onInputChange}
          // D-24: continue only an editable note whose audio is on this Mac; else a new note.
          meetingId={note?.editable && note.recordedHere ? meetingId : null}
          recorded={note?.startedAt !== null}
          hint={
            note && meetingId && !(note.editable && note.recordedHere)
              ? note.editable
                ? 'Recorded on another device — recording starts a new note.'
                : 'You can’t add to this note — recording starts a new note.'
              : null
          }
        />
        <IssueBanner snapshot={snapshot} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto" data-testid="note-column">
          {documentId === null ? (
            <StartScreen />
          ) : !loaded ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2Icon aria-hidden className="size-5 animate-spin" />
            </div>
          ) : !note ? (
            <p className="p-8 text-sm text-muted-foreground">
              This note isn’t on this Mac anymore.
            </p>
          ) : (
            <NoteBody
              key={note.documentId}
              note={note}
              live={recordingThis}
              transcriptCount={segments.length}
              panelOpen={panelOpen}
              onOpenPanel={() => setPanelOpen(true)}
            />
          )}
        </div>
        {panelOpen && (
          <SidePanel
            title={
              <>
                <AudioLinesIcon aria-hidden className="size-4 text-muted-foreground" />
                Transcript
              </>
            }
            meta={
              segments.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {segments.length}
                </span>
              )
            }
            closeLabel="Hide transcript"
            onClose={() => {
              player.pause(); // no hidden player keeps talking
              setPanelOpen(false);
            }}
            storageKey="oat.desktop.transcript.width"
            defaultWidth={340}
            minWidth={260}
            maxWidth={560}
            data-testid="transcript-panel"
          >
            <div
              className="flex min-h-0 flex-1 flex-col"
              onKeyDown={(event) => playerKey(event, player)}
            >
              {documentId && meetingId && !recordingThis && <PlaybackBar player={player} />}
              <TranscriptPanel
                segments={segments}
                // A just-recorded note that can be played back follows the playhead, not the live end.
                live={showsRecording || (followLive && !playable)}
                snapshot={showsRecording ? snapshot : null}
                loaded={documentId === null ? live.loaded : stored.loaded}
                failed={documentId === null ? live.failed : stored.failed}
                meetingKey={documentId}
                focusId={playable ? undefined : selected}
                onSelect={
                  playable
                    ? (s) => player.seek(s.startMs)
                    : documentId
                      ? (s) => setSelected(s.id)
                      : undefined
                }
                activeId={activeId}
                playheadKey={playable ? player.seekCount : undefined}
                status={transcriptStatus}
              />
            </div>
          </SidePanel>
        )}
      </div>
    </section>
  );
}

function StartScreen() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
      data-testid="meeting-start"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <NotebookPenIcon aria-hidden className="size-5" />
      </div>
      <h2 className="font-heading text-xl font-medium">Start a meeting note</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Start recording when your call begins. Jot what matters here while Oat transcribes both
        sides; your notes and the transcript sync to the web.
      </p>
    </div>
  );
}

/** Title, time, attendees and my notes, autosaved. Re-mounted per note (`key`). */
function NoteBody({
  note,
  live,
  transcriptCount,
  panelOpen,
  onOpenPanel,
}: {
  note: MeetingNote;
  live: boolean;
  transcriptCount: number;
  panelOpen: boolean;
  onOpenPanel: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState<Content>(note.contentJson);
  const [save, setSave] = useState<{ state: AutosaveState; error: string | null }>({
    state: 'idle',
    error: null,
  });
  const [conflict, setConflict] = useState<{ documentId: string; title: string } | null>(null);
  const documentId = note.documentId;
  // Every save carries the stored note the editor is built on (D-19): main refuses to overwrite a note that
  // has moved on since (a pull landed while I typed) — my edit becomes a conflicted copy then.
  const [autosave] = useState(
    () =>
      new NoteAutosave({
        base: { title: note.title, contentJson: note.contentJson },
        save: (patch, base) => call('meeting:save', { documentId, base, ...patch }),
        // Main then announces a reload: the newer note replaces the editor's text (mine is in the copy).
        onConflict: (c) => setConflict(c as { documentId: string; title: string }),
        onState: (state, error) => setSave({ state, error }),
      }),
  );

  // Leaving the note: write what is pending. The window going away or the app quitting: the same, through
  // `registerFlush` (pagehide / notes:flush).
  useEffect(() => {
    const unregister = registerFlush(() => autosave.flush());
    return () => {
      unregister();
      void autosave.flush();
      autosave.dispose();
    };
  }, [autosave]);

  // A reload brought a newer copy (edited on the web, pulled by sync): show it, unless I'm mid-edit (that
  // edit's save then finds the note moved and keeps it as a conflicted copy). Comparing with the base (not
  // the previous prop) ignores my own saves coming back normalised by the server.
  useEffect(() => {
    if (autosave.dirty) return;
    const b = autosave.base;
    const titleMoved = !b || note.title !== b.title;
    const contentMoved = !b || !sameDocumentContent(note.contentJson, b.contentJson);
    if (!titleMoved && !contentMoved) return;
    autosave.rebase({ title: note.title, contentJson: note.contentJson });
    // The local database is an external source here: adopting its newer copy is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (titleMoved) setTitle(note.title);
    if (contentMoved) setContent(note.contentJson);
  }, [note, autosave]);

  const editable = note.editable;
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-6" data-testid="note">
      <header className="flex flex-col gap-2.5">
        <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="gap-1">
            {note.visibility === 'private' ? <LockIcon /> : <UsersIcon />}
            {note.visibility === 'private'
              ? 'Private'
              : `Shared with ${note.workspaceName ?? 'the workspace'}`}
          </Badge>
          {!editable && (
            <Badge variant="outline" className="gap-1">
              <EyeIcon />
              {note.trashed ? 'In trash' : 'View only'}
            </Badge>
          )}
          <SaveStatus state={save.state} error={save.error} />
          {!panelOpen && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7"
              onClick={onOpenPanel}
              aria-expanded={false}
              data-testid="transcript-toggle"
            >
              <PanelRightOpenIcon data-icon="inline-start" />
              Transcript
              {transcriptCount > 0 && (
                <span className="text-muted-foreground tabular-nums">{transcriptCount}</span>
              )}
            </Button>
          )}
        </div>
        <textarea
          aria-label="Title"
          data-testid="note-title"
          value={title}
          readOnly={!editable}
          placeholder="Untitled meeting"
          rows={1}
          maxLength={200}
          className="w-full resize-none bg-transparent font-heading text-3xl font-medium [field-sizing:content] outline-none placeholder:text-muted-foreground/60"
          onChange={(event) => {
            const next = event.target.value.replace(/\n/g, ' ');
            setTitle(next);
            autosave.queue({ title: next });
          }}
        />
        {conflict && (
          <div
            role="status"
            data-testid="conflict-banner"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          >
            <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="flex-1">
              This note changed on another device while you were typing. It now shows that version;
              yours is kept as “{conflict.title}” under Conflicted copies, to compare and resolve.
            </p>
            <Button variant="ghost" size="sm" className="h-6" onClick={() => setConflict(null)}>
              Dismiss
            </Button>
          </div>
        )}
        <MeetingTime startedAt={note.startedAt} endedAt={note.endedAt} live={live} />
        <NoteEventLine event={note.calendarEvent} />
        <ParticipantChips
          participants={note.participants}
          editable={editable && note.meetingId !== null}
          onAdd={(p) => bridgeAction(() => call('meeting:add-participant', { documentId, ...p }))}
          onRemove={(p) =>
            bridgeAction(() =>
              call('meeting:remove-participant', { documentId, participantId: p.id }),
            )
          }
        />
      </header>
      <div data-testid="note-editor">
        <OatEditor
          value={content}
          editable={editable}
          aria-label="My notes"
          placeholder={editable ? 'Jot what matters — Oat transcribes alongside' : false}
          onChange={(json) => {
            // A view-only note never saves (not even the editor's one-off block-id repair).
            if (editable) autosave.queue({ contentJson: json as Content });
          }}
          className="min-h-64"
        />
      </div>
    </article>
  );
}

/** Bridge errors carry a user-facing message; anything else gets a generic one. */
async function bridgeAction(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw new Error(error instanceof BridgeCallError ? error.message : 'Something went wrong.', {
      cause: error,
    });
  }
}

function SaveStatus({ state, error }: { state: AutosaveState; error: string | null }) {
  const base = 'inline-flex items-center gap-1';
  switch (state) {
    case 'idle':
      return null;
    case 'pending':
    case 'saving':
      return (
        <span className={base} data-testid="save-status" data-state="saving" aria-live="polite">
          <Loader2Icon className="size-3 animate-spin" />
          Saving…
        </span>
      );
    case 'saved':
      return (
        <span className={base} data-testid="save-status" data-state="saved" aria-live="polite">
          <CheckIcon className="size-3" />
          Saved on this Mac
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} text-destructive`}
          data-testid="save-status"
          data-state="error"
          role="alert"
          title={error ?? undefined}
        >
          <AlertCircleIcon className="size-3" />
          Couldn’t save — keeps trying
        </span>
      );
  }
}
