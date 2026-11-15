import type { AppInfo, AuthState, DesktopUser, InvokeResponse } from '@oat/core/bridge';
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
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  LogOutIcon,
  PanelTopIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { useMainState } from '../main-state.ts';
import { useRecording, useTranscript } from '../recording-state.ts';
import { IssueBanner, RecordingBar } from '../recording/recording-controls.tsx';
import { TranscriptPanel } from '../recording/transcript-panel.tsx';
import { Wordmark } from '../wordmark.tsx';

/**
 * The main window: title bar + the account flow; signed in, the account sidebar and the meeting view
 * (recording bar + live transcript, 2.5). Notes and the workspace arrive in later tasks.
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
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b bg-sidebar">
        <Wordmark className="text-lg" />
      </header>
      {signedIn ? (
        <main className="flex min-h-0 flex-1" data-testid="shell">
          <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar p-3">
            <SignedInCard user={signedIn} />
          </aside>
          <MeetingView />
        </main>
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
      <footer className="flex h-8 shrink-0 items-center justify-center text-xs text-muted-foreground">
        {info && (
          <span data-testid="app-info">
            Oat {info.version}
            {info.dev && ' · dev'}
            {info.coldStartMs !== null && ` · ready in ${info.coldStartMs} ms`}
          </span>
        )}
      </footer>
    </div>
  );
}

function RestoringCard() {
  return (
    <Card className="shadow-md" aria-busy>
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
    <Card className="shadow-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
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
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <ExternalLinkIcon data-icon="inline-start" />
          )}
          Sign in with your browser
        </Button>
        <p role="status" className="text-center text-xs text-destructive empty:hidden">
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
    <Card className="shadow-md" data-testid="signing-in">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Loader2Icon className="size-5 animate-spin" />
        </div>
        <CardTitle className="text-xl">
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
          <RefreshCwIcon data-icon="inline-start" />
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
            <Label htmlFor="sign-in-link" className="text-xs text-muted-foreground">
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
            <p role="status" className="text-xs text-destructive empty:hidden">
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

/** Account panel in the sidebar: who is signed in, connection check, widget, sign out. */
function SignedInCard({ user }: { user: DesktopUser }) {
  const check = useAction();
  const other = useAction();
  const [me, setMe] = useState<InvokeResponse<'api:me'> | null>(null);
  const label = user.name || user.email;

  return (
    <div className="flex h-full flex-col gap-3" data-testid="signed-in">
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <div
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-sm font-semibold text-primary-foreground"
        >
          {label.charAt(0).toUpperCase()}
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-sm font-medium">{user.name || 'Signed in'}</h1>
          <p
            className="truncate text-xs text-muted-foreground"
            data-selectable
            data-testid="signed-in-email"
          >
            {user.email}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={check.pending}
          onClick={async () => setMe((await check.run(() => call('api:me'))) ?? null)}
        >
          {check.pending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Check connection
        </Button>
        {me && !check.error && (
          <p
            role="status"
            className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground"
            data-testid="api-me"
          >
            <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
            <span className="truncate">Connected as {me.user.email}</span>
          </p>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={other.pending}
          onClick={() => void other.run(() => call('window:open-widget'))}
        >
          <PanelTopIcon data-icon="inline-start" />
          Show meeting widget
        </Button>
        <p role="status" className="px-2.5 text-xs text-destructive empty:hidden">
          {check.error ?? other.error}
        </p>
      </div>
      <Button
        variant="ghost"
        className="mt-auto w-full justify-start text-muted-foreground"
        disabled={other.pending}
        onClick={() => void other.run(() => call('auth:sign-out'))}
      >
        <LogOutIcon data-icon="inline-start" />
        Sign out
      </Button>
    </div>
  );
}

/** Recording bar, issue banner and the live transcript. */
function MeetingView() {
  const snapshot = useRecording();
  const transcript = useTranscript();
  const [options, setOptions] = useState<InvokeResponse<'recording:options'> | null>(null);
  useEffect(() => {
    void call('recording:options')
      .then(setOptions)
      .catch(() => {});
  }, []);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Meeting">
      <div className="flex flex-col gap-3 border-b px-6 py-3">
        <RecordingBar snapshot={snapshot} options={options} />
        <IssueBanner snapshot={snapshot} />
      </div>
      <TranscriptPanel transcript={transcript} snapshot={snapshot} />
    </section>
  );
}
