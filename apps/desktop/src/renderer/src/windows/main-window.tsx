import type {
  AppInfo,
  AuthState,
  DesktopUser,
  InvokeResponse,
  MainState,
  SyncStatusSnapshot,
} from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oat/ui/components/card';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertTriangle,
  IconAppWindow,
  IconCircleCheck,
  IconCloudCheck,
  IconCloudOff,
  IconCloudUpload,
  IconExternalLink,
  IconLoader,
  IconLogout,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';

import { bridge, BridgeCallError, call } from '../bridge.ts';
import { AutoStopQuestion, AutoStopToast } from '../auto-stop/auto-stop-notice.tsx';
import { useAutoStopNotice } from '../auto-stop/auto-stop-state.ts';
import { useCalendar, useMeetingPrompt } from '../calendar/calendar-state.ts';
import { PromptBanner } from '../calendar/prompt-banner.tsx';
import { UpcomingList } from '../calendar/upcoming-list.tsx';
import { useMainState } from '../main-state.ts';
import { MeetingList, NewMeetingButton } from '../meetings/meeting-list.tsx';
import { MeetingView } from '../meetings/meeting-view.tsx';
import { bumpMeetingsVersion, useMeetingNotes } from '../meetings/meetings-state.ts';
import { useRecording } from '../recording-state.ts';
import { isActive } from '../recording-view.ts';
import { syncLabel, type SyncTone } from '../sync-status.ts';
import { defaultInputChoice, startRequest } from '../recording/recording-controls.tsx';
import { ConflictsPanel } from '../sync/conflicts-panel.tsx';
import { LocalSearch } from '../sync/local-search.tsx';
import { SettingsView } from '../settings/settings-view.tsx';
import { FirstMeetingGuide } from '../onboarding/first-meeting-guide.tsx';
import { useOnboarding } from '../onboarding/onboarding-state.ts';
import { OnboardingView } from '../onboarding/onboarding-view.tsx';
import { Wordmark } from '../wordmark.tsx';
import { WorkspaceSwitcher } from '../workspaces/workspace-switcher.tsx';
import { useWorkspaces } from '../workspaces/workspaces-state.ts';

/**
 * The main window: title bar + the account flow; signed in, the sidebar (account, "New meeting note", the
 * meeting notes on this Mac) and the meeting view (recording bar, the note, the transcript panel; 2.5, 3.4).
 */
export default function MainWindow() {
  const state = useMainState();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    // The cold-start figure is known right after the first render; ask again shortly after.
    const timer = setTimeout(
      () =>
        void call('app:info')
          .then(setInfo)
          .catch(() => {}),
      500,
    );
    return () => clearTimeout(timer);
  }, []);

  const signedIn = state?.auth.status === 'signed-in' ? state.auth.user : null;

  return (
    <div className="flex h-full flex-col bg-background-100 text-gray-1000">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-gray-alpha-400 bg-background-200">
        <Wordmark className="text-heading-16" />
      </header>
      {signedIn ? (
        <SignedInShell
          user={signedIn}
          sync={state!.sync}
          activeMeetingId={state!.activeMeetingId}
          recordingStatus={state!.recording.status}
        />
      ) : (
        <main className="flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-sm" data-testid="shell">
            {!state || state.auth.status === 'restoring' ? (
              <RestoringCard />
            ) : (
              // Pasting a sign-in link is a dev-only fallback; never offered in a packaged app.
              <AccountCard auth={state.auth} allowPaste={info !== null && !info.packaged} />
            )}
          </div>
        </main>
      )}
      <footer className="flex h-8 shrink-0 items-center justify-center text-label-12 text-gray-900">
        {info && (
          <span data-testid="app-info">
            Oat {info.version}
            {info.dev && ' · dev'}
            {/* Start-up timing is a development figure, not something to show users (9.3b). */}
            {info.coldStartMs !== null && !info.packaged && ` · ready in ${info.coldStartMs} ms`}
          </span>
        )}
      </footer>
    </div>
  );
}

function RestoringCard() {
  return (
    <Card aria-busy>
      <CardHeader className="items-center gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-56" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

function AccountCard({
  auth,
  allowPaste,
}: {
  auth: Exclude<AuthState, { status: 'restoring' }>;
  allowPaste: boolean;
}) {
  switch (auth.status) {
    case 'signed-out':
      return <SignedOutCard error={auth.error} />;
    case 'signing-in':
      return <SigningInCard allowPaste={allowPaste} />;
    case 'signed-in':
      return <SignedInCard user={auth.user} />;
  }
}

/** Runs a bridge call with a pending flag and a user-facing error. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.');
      return undefined;
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

function SignedOutCard({ error }: { error: string | null }) {
  const action = useAction();
  const message = action.error ?? error;
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-heading-24">
          <h1>Welcome to Oat</h1>
        </CardTitle>
        <CardDescription>
          Sign in with your browser. Your notes and workspaces sync to this Mac.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button
          size="lg"
          className="w-full"
          disabled={action.pending}
          onClick={() => void action.run(() => call('auth:sign-in'))}
        >
          {action.pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconExternalLink data-icon="inline-start" />
          )}
          Sign in with your browser
        </Button>
        <p role="status" className="text-center text-copy-13 text-red-900 empty:hidden">
          {message}
        </p>
      </CardContent>
    </Card>
  );
}

function SigningInCard({ allowPaste }: { allowPaste: boolean }) {
  const action = useAction();
  const [link, setLink] = useState('');
  const [rejected, setRejected] = useState(false);

  async function submitLink() {
    setRejected(false);
    const result = await action.run(() => call('auth:complete-from-link', { url: link }));
    if (result && !result.accepted) setRejected(true);
  }

  return (
    <Card data-testid="signing-in">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-11 items-center justify-center rounded-full bg-brand-100 text-brand-900">
          <Spinner className="size-5" />
        </div>
        <CardTitle className="text-heading-20">
          <h1>Finish signing in in your browser</h1>
        </CardTitle>
        <CardDescription>
          We opened Oat in your browser. Sign in there, and this window updates by itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="w-full"
          disabled={action.pending}
          onClick={() => void action.run(() => call('auth:sign-in'))}
        >
          <IconRefresh data-icon="inline-start" />
          Open the browser again
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          disabled={action.pending}
          onClick={() => void action.run(() => call('auth:cancel-sign-in'))}
        >
          Cancel
        </Button>
      </CardContent>
      {allowPaste && (
        <CardFooter className="flex-col items-stretch gap-2 pt-4">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (link.trim()) void submitLink();
            }}
          >
            <Label htmlFor="sign-in-link" className="text-label-12 text-gray-900">
              Dev build: browser didn’t switch back? Paste the link it gave you.
            </Label>
            <div className="flex gap-2">
              <Input
                id="sign-in-link"
                value={link}
                placeholder="oat://auth?…"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setLink(event.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={action.pending || !link.trim()}>
                Continue
              </Button>
            </div>
            <p role="status" className="text-copy-13 text-red-900 empty:hidden">
              {rejected
                ? 'That link isn’t for this sign-in. Open the browser again.'
                : action.error}
            </p>
          </form>
        </CardFooter>
      )}
    </Card>
  );
}

/**
 * Signed in: the sidebar and the meeting view. Which note is open lives here: picking one in the list opens
 * it; starting a recording opens the note it records into (3.4).
 */
function SignedInShell({
  user,
  sync,
  activeMeetingId,
  recordingStatus,
}: {
  user: DesktopUser;
  sync: SyncStatusSnapshot;
  activeMeetingId: string | null;
  recordingStatus: MainState['recording']['status'];
}) {
  const snapshot = useRecording();
  const notes = useMeetingNotes(true);
  // 3.9: the sidebar shows one workspace's notes; new notes go there when I can create there.
  const workspaces = useWorkspaces();
  const activeWorkspace = workspaces.active;
  const listed = activeWorkspace
    ? (notes?.filter((n) => n.workspaceId === activeWorkspace.id) ?? null)
    : notes;
  const workspaceNames = new Map(workspaces.snapshot?.workspaces.map((w) => [w.id, w.name]));
  /** "Upcoming": a note made in another workspace than the one shown says where it is. */
  const otherWorkspace = (documentId: string) => {
    const ws = notes?.find((n) => n.documentId === documentId)?.workspaceId;
    return ws && ws !== activeWorkspace?.id ? (workspaceNames.get(ws) ?? null) : null;
  };
  const [selected, setSelected] = useState<string | null>(null);
  // 3.8: Settings replaces the meeting view (a recording keeps running); opening a note closes it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [options, setOptions] = useState<InvokeResponse<'recording:options'> | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const input = choice ?? defaultInputChoice(options);
  const starting = useAction();
  useEffect(() => {
    void call('recording:options')
      .then(setOptions)
      .catch(() => {});
  }, []);
  // 7.3: "Upcoming" + the "Start notes?" prompt; main opens a note when a notification is clicked.
  const calendar = useCalendar(true);
  const prompt = useMeetingPrompt(true);
  const autoStop = useAutoStopNotice();
  useEffect(
    () => bridge().subscribe('notes:open', ({ documentId }) => setSelected(documentId)),
    [],
  );
  // 9.2: first run of this account on this Mac → the setup walkthrough; Settings → Setup reopens it.
  const onboarding = useOnboarding(user.id);
  const [setupOpen, setSetupOpen] = useState(false);

  // A recording (re)started: open the note it records into once it exists (its row is created right
  // before the audio starts, so it may take one list reload to appear).
  const recording = isActive(recordingStatus);
  const [opened, setOpened] = useState<string | null>(null);
  const recordingNote = recording
    ? notes?.find((n) => n.meetingId !== null && n.meetingId === activeMeetingId)
    : undefined;
  if (recording && activeMeetingId && opened !== activeMeetingId && recordingNote) {
    setOpened(activeMeetingId);
    setSelected(recordingNote.documentId);
  }
  useEffect(() => {
    if (recording && activeMeetingId && opened !== activeMeetingId) bumpMeetingsVersion();
  }, [recording, activeMeetingId, opened]);

  if (!onboarding.state) return <main className="flex-1" data-testid="shell" aria-busy />;
  if (onboarding.state.needed || setupOpen) {
    const firstRun = onboarding.state.needed;
    return (
      <OnboardingView
        firstRun={firstRun}
        email={user.email}
        input={input}
        onDone={(finished) => {
          setSetupOpen(false);
          setSettingsOpen(false);
          setSelected(null);
          // The guide card follows a finished first run; "Set up later" and re-runs go straight back.
          if (firstRun) void onboarding.complete(finished);
        }}
      />
    );
  }

  return (
    <main className="flex min-h-0 flex-1" data-testid="shell">
      <aside className="flex w-64 shrink-0 flex-col gap-3 border-e border-gray-alpha-400 bg-background-200 p-3">
        <WorkspaceSwitcher view={workspaces} />
        {/* 3.5: local search + conflicted copies, refreshed after every sync. */}
        <LocalSearch refreshKey={sync.lastSyncedAt} />
        <ConflictsPanel refreshKey={sync.lastSyncedAt} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SignedInCard user={user} sync={sync} onOpenSettings={() => setSettingsOpen(true)}>
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <NewMeetingButton
                disabled={recording || !snapshot}
                pending={starting.pending}
                onClick={() => {
                  setSettingsOpen(false);
                  void starting.run(() => call('recording:start', startRequest(input)));
                }}
              />
              {starting.error && (
                <p role="status" className="px-2.5 text-copy-13 text-red-900">
                  {starting.error}
                </p>
              )}
              <UpcomingList
                snapshot={calendar}
                otherWorkspace={otherWorkspace}
                onOpen={(documentId) => {
                  setSelected(documentId);
                  bumpMeetingsVersion();
                }}
              />
              <MeetingList
                notes={listed}
                workspaceName={activeWorkspace?.name ?? null}
                selected={selected}
                recordingMeetingId={recording ? activeMeetingId : null}
                onSelect={(id) => {
                  setSelected(id);
                  setSettingsOpen(false);
                }}
              />
            </div>
          </SignedInCard>
        </div>
      </aside>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col [&>section]:min-h-0">
        <PromptBanner prompt={prompt} recording={startRequest(input)} />
        <AutoStopQuestion notice={autoStop} />
        {settingsOpen ? (
          <SettingsView
            onClose={() => setSettingsOpen(false)}
            onOpenSetup={() => setSetupOpen(true)}
          />
        ) : (
          <MeetingView
            documentId={selected}
            snapshot={snapshot}
            options={options}
            input={input}
            onInputChange={setChoice}
            home={
              onboarding.state.guide ? (
                <FirstMeetingGuide onDismiss={() => void onboarding.dismissGuide()} />
              ) : undefined
            }
          />
        )}
        <AutoStopToast notice={autoStop} />
      </div>
    </main>
  );
}

/** Account panel in the sidebar: who is signed in, (meeting notes,) connection check, widget, sign out. */
function SignedInCard({
  user,
  sync,
  children,
  onOpenSettings,
}: {
  user: DesktopUser;
  sync?: SyncStatusSnapshot;
  children?: ReactNode;
  onOpenSettings?: () => void;
}) {
  const check = useAction();
  const other = useAction();
  const [me, setMe] = useState<InvokeResponse<'api:me'> | null>(null);
  const label = user.name || user.email;

  return (
    <div className="flex h-full flex-col gap-3" data-testid="signed-in">
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <div
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-label-14 text-brand-on"
        >
          {label.charAt(0).toUpperCase()}
        </div>
        {/* The account, not a page heading (9.3b): the name when there is one, else the address. */}
        <div className="flex min-w-0 flex-col">
          {user.name && <p className="truncate text-label-14 text-gray-1000">{user.name}</p>}
          <p
            className={
              user.name
                ? 'truncate text-label-12 text-gray-900'
                : 'truncate text-label-14 text-gray-1000'
            }
            title={user.email}
            data-selectable
            data-testid="signed-in-email"
          >
            {user.email}
          </p>
        </div>
      </div>
      {children}
      <div className="flex flex-col gap-1">
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={check.pending}
          onClick={async () => setMe((await check.run(() => call('api:me'))) ?? null)}
        >
          {check.pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconRefresh data-icon="inline-start" />
          )}
          Check connection
        </Button>
        {me && !check.error && (
          <p
            role="status"
            className="flex items-center gap-1.5 px-2.5 text-label-12 text-gray-900"
            data-testid="api-me"
          >
            <IconCircleCheck className="size-3.5 shrink-0 text-green-900" />
            <span className="truncate">Connected as {me.user.email}</span>
          </p>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={other.pending}
          onClick={() => void other.run(() => call('window:open-widget'))}
        >
          <IconAppWindow data-icon="inline-start" />
          Show meeting widget
        </Button>
        {onOpenSettings && (
          <Button variant="ghost" className="w-full justify-start" onClick={onOpenSettings}>
            <IconSettings data-icon="inline-start" />
            Settings
          </Button>
        )}
        <p role="status" className="px-2.5 text-copy-13 text-red-900 empty:hidden">
          {check.error ?? other.error}
        </p>
      </div>
      <SyncLine status={sync} />
      <Button
        variant="ghost"
        className="w-full justify-start text-gray-900"
        disabled={other.pending}
        onClick={() => void other.run(() => call('auth:sign-out'))}
      >
        <IconLogout data-icon="inline-start" />
        Sign out
      </Button>
    </div>
  );
}

const SYNC_ICONS: Record<SyncTone, { icon: typeof IconCloudCheck; className: string }> = {
  ok: { icon: IconCloudCheck, className: 'text-green-900' },
  busy: { icon: IconLoader, className: 'animate-spin' },
  waiting: { icon: IconCloudUpload, className: '' },
  offline: { icon: IconCloudOff, className: 'text-amber-900' },
  problem: { icon: IconAlertTriangle, className: 'text-red-900' },
};

/** Sync status (2.6): caught up, syncing, waiting, or offline with how much is kept on this Mac. */
function SyncLine({ status }: { status: SyncStatusSnapshot | undefined }) {
  const label = status && syncLabel(status);
  if (!status || !label) return <div className="mt-auto" />;
  const { icon: Icon, className } = SYNC_ICONS[label.tone];
  return (
    <p
      role="status"
      className="mt-auto flex items-center gap-1.5 px-2.5 text-label-12 text-gray-900"
      data-testid="sync-status"
      data-state={status.state}
      data-pending={status.pending}
      title={status.error ?? undefined}
    >
      <Icon className={`size-3.5 shrink-0 ${className}`} />
      <span className="truncate">{label.text}</span>
    </p>
  );
}
