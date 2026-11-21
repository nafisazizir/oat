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
import { cn } from '@oat/ui/lib/utils';
import {
  IconAlertTriangle,
  IconCloudCheck,
  IconCloudOff,
  IconCloudUpload,
  IconExternalLink,
  IconLoader,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

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
import { DesktopSearch, DesktopUserMenu } from './shell-menus.tsx';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarInset,
  SidebarTrigger,
} from '@oat/ui/components/sidebar';
import { RecordingBar, IssueBanner } from '../recording/recording-controls.tsx';
import { SettingsView } from '../settings/settings-view.tsx';
import { FirstMeetingGuide } from '../onboarding/first-meeting-guide.tsx';
import { useOnboarding } from '../onboarding/onboarding-state.ts';
import { OnboardingView } from '../onboarding/onboarding-view.tsx';
import { Wordmark } from '../wordmark.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
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
      {!signedIn && (
        <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-gray-alpha-400 bg-background-200">
          <Wordmark className="text-heading-16" />
        </header>
      )}
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
      {!signedIn && (
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
      )}
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
      return null;
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
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
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

  if (!onboarding.state) return <main className="app-drag flex-1" data-testid="shell" aria-busy />;
  if (onboarding.state.needed || setupOpen) {
    const firstRun = onboarding.state.needed;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="app-drag h-12 shrink-0" />
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
      </div>
    );
  }

  return (
    <SidebarProvider className="h-full min-h-0 min-w-0 flex-1" data-testid="shell">
      <Sidebar collapsible="icon">
        <div className="app-drag h-12 shrink-0" />
        <SidebarHeader>
          <SidebarMenu>
            <DesktopSearch
              refreshKey={sync.lastSyncedAt}
              onOpen={(hit) => {
                if (hit.kind !== 'meeting') return;
                setSelected(hit.documentId);
                setSettingsOpen(false);
              }}
            />
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <div className="group-data-[collapsible=icon]:hidden">
            <UpcomingList
              snapshot={calendar}
              otherWorkspace={otherWorkspace}
              onOpen={(documentId) => {
                setSelected(documentId);
                setSettingsOpen(false);
                bumpMeetingsVersion();
              }}
            />
            <ConflictsPanel refreshKey={sync.lastSyncedAt} />
          </div>
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
        </SidebarContent>
        <SidebarFooter data-testid="signed-in">
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Settings"
                    onClick={() => setSettingsOpen(true)}
                  />
                }
              >
                <IconSettings />
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
            <SyncLine status={sync} />
          </div>
          <DesktopUserMenu
            user={user}
            workspaces={workspaces}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <header
          className={cn(
            'app-drag sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background-100 px-3',
            /Mac/.test(navigator.platform) &&
              'max-md:ps-24 group-has-data-[collapsible=icon]/sidebar-wrapper:ps-12',
          )}
        >
          <SidebarTrigger className="app-no-drag" />
          <div className="ms-auto flex min-w-0 items-center gap-2">
            <NewMeetingButton
              disabled={recording || !snapshot}
              pending={starting.pending}
              onClick={() => {
                setSettingsOpen(false);
                void starting.run(() => call('recording:start', startRequest(input)));
              }}
            />
            <div ref={setToolbar} className="app-no-drag min-w-0 overflow-x-auto" />
          </div>
        </header>
        {starting.error && (
          <p role="status" className="px-3 text-copy-13 text-red-900">
            {starting.error}
          </p>
        )}
        <div className="relative flex min-h-0 flex-1 flex-col [&>section]:min-h-0">
          <PromptBanner prompt={prompt} recording={startRequest(input)} />
          <AutoStopQuestion notice={autoStop} />
          {settingsOpen ? (
            <>
              {recording && (
                <>
                  <RecordingBar
                    snapshot={snapshot}
                    options={options}
                    input={input}
                    onInputChange={setChoice}
                    controlsContainer={toolbar}
                  />
                  <IssueBanner snapshot={snapshot} />
                </>
              )}
              <SettingsView
                teamWorkspace={workspaces.active?.kind === 'team'}
                onClose={() => setSettingsOpen(false)}
                onOpenSetup={() => setSetupOpen(true)}
              />
            </>
          ) : (
            <MeetingView
              documentId={selected}
              snapshot={snapshot}
              options={options}
              input={input}
              onInputChange={setChoice}
              controlsContainer={toolbar}
              home={
                onboarding.state.guide ? (
                  <FirstMeetingGuide onDismiss={() => void onboarding.dismissGuide()} />
                ) : undefined
              }
            />
          )}
          <AutoStopToast notice={autoStop} />
        </div>
      </SidebarInset>
    </SidebarProvider>
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
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label.text} />}>
        <span
          role="status"
          aria-label={label.text}
          data-testid="sync-status"
          data-state={status.state}
          data-pending={status.pending}
        >
          <Icon aria-hidden className={`size-4 ${className}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{status.error ?? label.text}</TooltipContent>
    </Tooltip>
  );
}
