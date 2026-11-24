/**
 * The desktop meeting note (3.4): editable title, when it was
 * recorded, attendees, and my notes (`OatEditor`, autosaved into the local database and synced, 2.6) — with
 * the transcript in a collapsible sheet above the note dock (live while this note is being recorded,
 * the stored transcript otherwise). Nothing open: a start screen ("Start recording" makes a new note).
 * A recorded note plays its local audio (3.7): the player sits on top of the transcript, a click on a line
 * seeks there and the line under the playhead is highlighted (`audio-player.tsx`).
 */
import type { InvokeResponse, MeetingNote, RecordingSnapshot } from '@oat/core/bridge';
import { visibilityBadge } from '@oat/core/sections';
import { sameDocumentContent } from '@oat/core/sync';
import { BlockFocus, OatEditor } from '@oat/editor/react';
import { NotionExportButton, useDocumentEnhancement } from '@oat/feature-ui/document';
import { MoreActions } from '@oat/workspace-ui/page-editor';
import { useWorkspaceHost } from '@oat/workspace-ui/host';
import { useShellData } from '@oat/workspace-ui/shell-data';
import {
  DocumentAssistant,
  AssistantToggleAnchor,
  DockControlsOutlet,
  useRegisterOpenDocument,
  type NoteEditor,
  focusedLine,
  parseDeepLink,
  wantsTranscript,
} from '@oat/feature-ui/assistant';
import {
  MeetingTime,
  mergeTranscripts,
  ParticipantSummary,
  TranscriptSheet,
  TranscriptToggle,
  NoteColumn,
  usePanelEscape,
  type TranscriptItem,
  useStoredState,
} from '@oat/meeting-ui';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconEye,
  IconLock,
  IconNotes,
  IconStack2,
  IconUsers,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import { useMeetingGrace } from '../auto-stop/auto-stop-state.ts';
import { bridge, BridgeCallError, call } from '../bridge.ts';
import { NoteEventLine } from '../calendar/note-event-line.tsx';
import { IssueBanner, RecordingBar } from '../recording/recording-controls.tsx';
import { TranscriptPanel } from '../recording/transcript-panel.tsx';
import { useTranscript } from '../recording-state.ts';
import { isActive } from '../recording-view.ts';
import {
  registerFlush,
  useMeetingNote,
  useStoredTranscript,
  useTranscriptStatus,
} from './meetings-state.ts';
import { PipelineWatcher } from './post-meeting.tsx';
import { type AutosaveState, NoteAutosave } from './note-autosave.ts';
import { meetingAssistantHandle } from './meeting-assistant';
import { MeetingActions } from '../workspace/meeting-actions';
import { meetingDocumentAdapter } from './meeting-document';
import { api } from '../lib/api';

type Content = MeetingNote['contentJson'];

export function MeetingView({
  userId,
  documentId,
  snapshot,
  options,
  input,
  onInputChange,
  home,
  controlsContainer,
  focus: focusQuery,
  focusRevision = 0,
}: {
  userId: string;
  documentId: string | null;
  snapshot: RecordingSnapshot | null;
  options: InvokeResponse<'recording:options'> | null;
  input: string;
  onInputChange: (choice: string) => void;
  /** Replaces the start screen when no note is open (9.2: the first-meeting guide). */
  home?: ReactNode;
  controlsContainer?: HTMLElement | null;
  focus?: Record<string, string>;
  focusRevision?: number;
}) {
  const { note, loaded, failure, retry } = useMeetingNote(documentId);
  const live = useTranscript();
  const meetingId = note?.meetingId ?? null;
  const recordingThis =
    meetingId !== null && snapshot?.meetingId === meetingId && isActive(snapshot.status);
  const stored = useStoredTranscript(note ? documentId : null, !recordingThis);
  const transcriptStatus = useTranscriptStatus(documentId ? meetingId : null);
  const [panelOpen, setPanelOpen] = useStoredState<boolean>(
    `oat.desktop.transcript.open:${userId}`,
    false,
  );
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [stopContainer, setStopContainer] = useState<HTMLDivElement | null>(null);
  const focus = useMemo(() => parseDeepLink(focusQuery ?? {}), [focusQuery]);
  const [picked, setPicked] = useState<{
    id: string;
    query: typeof focusQuery;
    revision: number;
    documentId: string | null;
  } | null>(null);

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

  const closePanel = () => {
    setPanelOpen(false);
    requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  };
  usePanelEscape(panelOpen && !!documentId, closePanel);
  const linked = focusedLine(segments, focus);
  const selected =
    picked &&
    picked.query === focusQuery &&
    picked.revision === focusRevision &&
    picked.documentId === documentId
      ? picked.id
      : linked;
  useEffect(() => {
    if (documentId && wantsTranscript(focus)) {
      setPanelOpen(true);
    }
  }, [documentId, focus, focusRevision, setPanelOpen]);

  // 7.5: just stopped → the grace period holds `endedAt` before it is written.
  const grace = useMeetingGrace();
  const graceHere =
    grace && meetingId && grace.meetingId === meetingId && !recordingThis ? grace : null;

  // Home (no note open) shows the recording's state; a note shows it only while it is the one recorded.
  const showsRecording = documentId === null || recordingThis;

  const surface = (
    <section
      className="group/meeting relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Meeting"
    >
      {/* The page's heading (the title itself is an editable field). */}
      {(!home || documentId !== null) && (
        <h1 className="sr-only">
          {documentId === null ? 'Meeting notes' : note?.title || 'Untitled meeting'}
        </h1>
      )}
      {note && meetingId && !recordingThis && !graceHere && note.endedAt && (
        <PipelineWatcher documentId={note.documentId} endedAt={note.endedAt} />
      )}
      <IssueBanner snapshot={snapshot} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="note-column">
            {documentId === null ? (
              (home ?? <StartScreen />)
            ) : !loaded ? (
              <NoteSkeleton />
            ) : !note ? (
              <Empty className="h-full border-none">
                <EmptyHeader>
                  <EmptyTitle>
                    {failure === 'offline'
                      ? 'This meeting isn’t available offline'
                      : failure === 'error'
                        ? 'Couldn’t load this meeting'
                        : 'Page not found'}
                  </EmptyTitle>
                  <EmptyDescription>
                    {failure === 'offline'
                      ? 'This meeting hasn’t been saved on this Mac yet. Reconnect and try again.'
                      : failure === 'error'
                        ? 'Please try again. Your local notes are unchanged.'
                        : 'It may have been moved or deleted, or you might not have access to it.'}
                  </EmptyDescription>
                  <Button variant="secondary" onClick={retry}>
                    Try again
                  </Button>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="pb-24 group-has-[[data-note-dock-panel=transcript]]/meeting:pb-[calc(6rem+min(25rem,55dvh))] group-has-[[data-note-dock-panel=assistant]:not([hidden]_*)]/meeting:pb-[calc(6rem+min(28rem,60dvh))]">
                <NoteBody
                  key={note.documentId}
                  note={note}
                  live={recordingThis}
                  endedAt={
                    note.endedAt ?? (graceHere ? new Date(graceHere.endedAt).toISOString() : null)
                  }
                  controlsContainer={controlsContainer}
                />
                <BlockFocus
                  key={`${note.documentId}:${focusRevision}:${focus.block ?? ''}`}
                  blockId={focus.block}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Home, idle: no bar (the sidebar's "New meeting note" starts a recording). */}
      {(documentId !== null || (snapshot && snapshot.status !== 'idle')) && (
        <AssistantToggleAnchor
          className="absolute inset-x-0"
          transcript={
            documentId &&
            panelOpen &&
            (note || !loaded || isActive(snapshot?.status) || snapshot?.status === 'error') ? (
              <TranscriptSheet
                items={segments}
                onClose={closePanel}
                footer={
                  <>
                    <DockControlsOutlet panel="transcript" />
                    <div
                      className="ms-auto flex items-center gap-2 empty:hidden"
                      ref={setStopContainer}
                    />
                  </>
                }
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <TranscriptPanel
                    key={`${documentId}:${focusRevision}:${focus.seg ?? ''}:${focus.t ?? ''}`}
                    segments={segments}
                    live={showsRecording}
                    snapshot={showsRecording ? snapshot : null}
                    loaded={documentId === null ? live.loaded : loaded && stored.loaded}
                    failed={documentId === null ? live.failed : stored.failed}
                    meetingKey={documentId}
                    focusId={selected}
                    onSelect={
                      documentId
                        ? (s) =>
                            setPicked({
                              id: s.id,
                              query: focusQuery,
                              revision: focusRevision,
                              documentId,
                            })
                        : undefined
                    }
                    status={transcriptStatus}
                  />
                </div>
              </TranscriptSheet>
            ) : undefined
          }
        >
          {(dockContainer) => (
            <div
              className={
                documentId === null
                  ? 'flex min-h-10 max-w-full flex-wrap items-center justify-center gap-1 rounded-lg border border-gray-alpha-400 bg-background-100 p-1 shadow-sm'
                  : undefined
              }
            >
              <RecordingBar
                snapshot={snapshot}
                options={options}
                input={input}
                onInputChange={onInputChange}
                transcriptToggle={
                  documentId && (
                    <TranscriptToggle
                      ref={toggleRef}
                      open={panelOpen}
                      count={segments.length}
                      recording={recordingThis && snapshot?.status === 'recording'}
                      onClick={(event) => {
                        if (panelOpen) closePanel();
                        else {
                          setPanelOpen(true);
                          if (event.detail === 0)
                            requestAnimationFrame(() =>
                              toggleRef.current?.focus({ preventScroll: true }),
                            );
                        }
                      }}
                    />
                  )
                }
                stopContainer={stopContainer}
                dockContainer={dockContainer}
                hideTranscriptionStatus={!!documentId && panelOpen && recordingThis}
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
            </div>
          )}
        </AssistantToggleAnchor>
      )}
    </section>
  );
  return note ? (
    <DocumentAssistant
      key={note.documentId}
      documentId={note.documentId}
      workspaceId={note.workspaceId}
      available={!note.trashed}
      layout="dock"
      transcript={null}
      focus={{}}
    >
      {surface}
    </DocumentAssistant>
  ) : (
    surface
  );
}

/** Same geometry as `NoteBody` (meta row, title, first lines), so nothing moves when the note arrives. */
function NoteSkeleton() {
  return (
    <NoteColumn className="gap-6" aria-busy aria-label="Loading note" data-testid="note-loading">
      <div className="flex flex-col gap-2.5">
        <div className="flex min-h-7 items-center gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <Skeleton className="h-10 w-1/2" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </NoteColumn>
  );
}

function StartScreen() {
  return (
    <Empty className="h-full border-none px-8" data-testid="meeting-start">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-brand-100 text-brand-900">
          <IconNotes aria-hidden />
        </EmptyMedia>
        <h2 className="text-heading-20 text-gray-1000">Start a meeting note</h2>
        <EmptyDescription>
          Start recording when your call begins. Jot what matters here while Oat transcribes both
          sides; your notes and the transcript sync to the web.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Title, time, attendees and my notes, autosaved. Re-mounted per note (`key`). */
function NoteBody({
  note,
  live,
  endedAt,
  controlsContainer,
}: {
  note: MeetingNote;
  live: boolean;
  /** The meeting's end, also while it waits out the grace period (not written yet). */
  endedAt: string | null;
  controlsContainer?: HTMLElement | null;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState<Content>(note.contentJson);
  const [save, setSave] = useState<{ state: AutosaveState; error: string | null }>({
    state: 'idle',
    error: null,
  });
  const [conflict, setConflict] = useState<{ documentId: string; title: string } | null>(null);
  const documentId = note.documentId;
  const editorRef = useRef<NoteEditor | null>(null);
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

  const shell = useShellData();
  const trashed = note.trashed || shell.trash.some((node) => node.id === documentId);
  const editable = note.editable && !trashed;
  const [assistant] = useState(() =>
    meetingAssistantHandle({
      documentId,
      autosave,
      client: api,
      adopt: (next) => setContent(next as Content),
    }),
  );
  const [documentHost] = useState(() =>
    meetingDocumentAdapter({ documentId, client: api, assistant }),
  );
  const [readOnlyHost] = useState(() =>
    meetingDocumentAdapter({
      documentId,
      client: api,
      assistant,
      readOnlyRefresh: () => call('sync:now'),
    }),
  );
  const workspaceHost = useWorkspaceHost();
  const capabilities = useDocumentEnhancement({
    documentId,
    loadedVersion: note.version ?? 0,
    enabled: !trashed,
    editable,
    host: editable ? documentHost : readOnlyHost,
  });
  const notion = (history: React.ReactNode, lifecycle: React.ReactNode) => (
    <NotionExportButton
      documentId={documentId}
      beforeSend={assistant.settle}
      onOpenIntegrations={() =>
        workspaceHost.navigate({ view: 'settings', section: 'integrations' })
      }
      openExternal={(url) => bridge().send('shell:open-external', { url })}
      fallback={
        history || lifecycle ? (
          <MoreActions>
            {history}
            {lifecycle}
          </MoreActions>
        ) : null
      }
      wrap={(control) => (
        <MoreActions>
          {history}
          {control}
          {lifecycle}
        </MoreActions>
      )}
    />
  );
  useRegisterOpenDocument(documentId, { ...assistant, editor: () => editorRef.current });
  return (
    <NoteColumn className="gap-6" role="article" data-testid="note">
      <header className="flex flex-col gap-2.5">
        <textarea
          aria-label="Title"
          data-testid="note-title"
          value={title}
          readOnly={!editable}
          placeholder="Untitled meeting"
          rows={1}
          maxLength={200}
          className="w-full resize-none bg-transparent text-heading-32 text-gray-1000 [field-sizing:content] outline-none placeholder:text-gray-700"
          onChange={(event) => {
            const next = event.target.value.replace(/\n/g, ' ');
            setTitle(next);
            autosave.queue({ title: next });
          }}
        />
        <div
          className="flex min-h-7 flex-wrap items-center gap-2 text-label-12 text-gray-900"
          data-testid="meeting-header"
        >
          {note.workspaceName && (
            // 3.9: which workspace the note lives in (it never moves, D-18).
            <Badge
              variant="secondary"
              className="h-6 gap-1 rounded-md px-2.5 text-gray-900"
              data-testid="note-workspace"
            >
              <IconStack2 />
              {note.workspaceName}
            </Badge>
          )}
          <Badge variant="secondary" className="h-6 gap-1 rounded-md px-2.5 text-gray-900">
            {note.visibility === 'private' ? <IconLock /> : <IconUsers />}
            {/* What the note's visibility is (D-36), in the web's words. */}
            {visibilityBadge(note.visibility, note.workspaceName ?? '')}
          </Badge>
          {!editable && (
            <Badge variant="outline" className="gap-1">
              <IconEye />
              {trashed ? 'In trash' : 'View only'}
            </Badge>
          )}

          <MeetingTime startedAt={note.startedAt} endedAt={endedAt} live={live} />
          <NoteEventLine event={note.calendarEvent} />
          <ParticipantSummary
            participants={note.participants}
            editable={editable && note.meetingId !== null}
            onAdd={(p) => bridgeAction(() => call('meeting:add-participant', { documentId, ...p }))}
            onRemove={(p) =>
              bridgeAction(() =>
                call('meeting:remove-participant', { documentId, participantId: p.id }),
              )
            }
          />
          {editable ? capabilities.enhance(note.workspaceId) : null}
        </div>
        {controlsContainer ? (
          createPortal(
            <div className="flex items-center gap-2 text-label-12 text-gray-900 empty:hidden">
              <SaveStatus state={save.state} error={save.error} />
            </div>,
            controlsContainer,
          )
        ) : (
          <div className="flex items-center gap-2 text-label-12 text-gray-900 empty:hidden">
            <SaveStatus state={save.state} error={save.error} />
          </div>
        )}
        <MeetingActions
          container={controlsContainer}
          id={documentId}
          beforeRemove={editable ? assistant.settle : undefined}
          removeDisabled={live}
          renderSecondaryActions={(lifecycle) =>
            notion(editable ? capabilities.historyAction : null, lifecycle)
          }
        />

        {conflict && (
          <div
            role="status"
            data-testid="conflict-banner"
            className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-100 py-2 ps-3 pe-2 text-copy-14 text-gray-1000"
          >
            <IconAlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-900" />
            <p className="flex-1">
              This note changed on another device while you were typing. It now shows that version;
              yours is kept as “{conflict.title}” under Conflicted copies, to compare and resolve.
            </p>
            <Button variant="ghost" size="xs" onClick={() => setConflict(null)}>
              Dismiss
            </Button>
          </div>
        )}
      </header>
      {capabilities.beforeEditor}
      <div data-testid="note-editor" hidden={capabilities.streaming}>
        <OatEditor
          onReady={(editor) => {
            editorRef.current = editor;
          }}
          value={content}
          editable={editable && !capabilities.streaming}
          aria-label="My notes"
          placeholder={editable ? 'Jot what matters — Oat transcribes alongside' : false}
          onChange={(json) => {
            // A view-only note never saves (not even the editor's one-off block-id repair).
            if (editable) autosave.queue({ contentJson: json as Content });
          }}
          className="min-h-64"
        />
      </div>
    </NoteColumn>
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
    case 'saved':
      return null;
    case 'pending':
    case 'saving':
      return (
        <span className={base} data-testid="save-status" data-state="saving" aria-live="polite">
          <Spinner aria-hidden className="size-3" />
          Saving…
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} text-red-900`}
          data-testid="save-status"
          data-state="error"
          role="alert"
          title={error ?? undefined}
        >
          <IconAlertCircle aria-hidden className="size-3" />
          Couldn’t save — keeps trying
        </span>
      );
  }
}
