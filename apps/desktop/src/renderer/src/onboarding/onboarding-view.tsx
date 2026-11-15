/**
 * First-run setup (9.2): microphone → system audio → calendar → a test recording, each explained, each
 * permission asked for only when the user clicks "Allow". A permission that was turned off can only be changed
 * in System Settings, so the step says where and opens that pane. Every step can be skipped; "Set up later"
 * leaves at any time (Settings → Setup brings it back).
 *
 * ```
 *  Set up Oat                                        Set up later
 *  (1)───(2)───(3)───(4)   Microphone · System audio · Calendar · Test recording
 *  ┌──────────────────────────────────────────────────────────┐
 *  │ [icon]  Your microphone                     [Allowed ✓]   │
 *  │ Oat transcribes your voice live as “Me”…                  │
 *  │ [Allow microphone]   or   ⚠ Turned off → [Open System Settings] │
 *  ├──────────────────────────────────────────────────────────┤
 *  │ Back                                 Skip for now / Continue │
 *  └──────────────────────────────────────────────────────────┘
 * ```
 */
import type { PermissionKind, PermissionsSnapshot, TestRecordingSnapshot } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import {
  AlertTriangleIcon,
  CalendarDaysIcon,
  CheckIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  MicIcon,
  RotateCcwIcon,
  SquareIcon,
  Volume2Icon,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { startRequest } from '../recording/recording-controls.tsx';
import { levelFill } from '../recording-view.ts';
import {
  firstOpenStep,
  nextStep,
  type PermissionView,
  previousStep,
  seconds,
  STEP_LABELS,
  STEPS,
  type StepId,
  stepDone,
  stepView,
  testVerdict,
  type Tone,
} from './onboarding-steps.ts';
import { usePermissions, useTestRecording } from './onboarding-state.ts';

export function OnboardingView({
  firstRun,
  email,
  input,
  onDone,
}: {
  /** First run of this account on this Mac (else re-opened from Settings). */
  firstRun: boolean;
  /** The signed-in account (setup is per account). */
  email: string;
  /** The recording input choice (dev fixtures; `sidecar` = live capture). */
  input: string;
  /** `finished`: the last step's "Finish setup" (else "Set up later"). */
  onDone: (finished: boolean) => void;
}) {
  const permissions = usePermissions();
  const test = useTestRecording();
  const [step, setStep] = useState<StepId | null>(null);
  if (step === null && permissions) setStep(firstOpenStep(permissions));
  const current = step ?? 'microphone';

  // A new step moves focus to its heading, so a screen reader announces it.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    headingRef.current?.focus();
  }, [step]);
  const go = (next: StepId) => {
    moved.current = true;
    setStep(next);
  };

  const done = stepDone(current, permissions, test);
  const next = nextStep(current);
  const back = previousStep(current);
  const testBusy = test?.status === 'starting' || test?.status === 'running';

  return (
    <main
      className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 py-10"
      data-testid="onboarding"
      data-step={current}
    >
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              {firstRun ? 'Set up Oat' : 'Setup'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {firstRun
                ? 'A minute now, so your first meeting just works.'
                : 'Check permissions and try a test recording.'}
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={testBusy}
            onClick={() => onDone(false)}
            data-testid="onboarding-later"
          >
            {firstRun ? 'Set up later' : 'Close'}
          </Button>
        </div>

        <Stepper
          current={current}
          isDone={(s) => stepDone(s, permissions, test)}
          disabled={testBusy}
          onSelect={go}
        />

        <section
          aria-labelledby="onboarding-step-title"
          className="flex flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10"
          data-testid={`onboarding-step-${current}`}
        >
          <div className="flex flex-col gap-5 p-6">
            {!permissions ? (
              <div role="status" aria-busy className="flex h-40 items-center justify-center">
                <Loader2Icon
                  aria-label="Loading"
                  className="size-5 animate-spin text-muted-foreground"
                />
              </div>
            ) : current === 'microphone' ? (
              <PermissionStep
                kind="microphone"
                icon={MicIcon}
                title="Your microphone"
                headingRef={headingRef}
                view={stepView('microphone', permissions)!}
                allowLabel="Allow microphone"
                settingsPath="Privacy & Security → Microphone"
              >
                Oat transcribes your voice live as <Voice source="mic">Me</Voice>. Audio is saved
                only on this Mac, so you can listen back — it’s never uploaded.
              </PermissionStep>
            ) : current === 'system-audio' ? (
              <PermissionStep
                kind="system_audio"
                icon={Volume2Icon}
                title="The other side of the call"
                headingRef={headingRef}
                view={stepView('system-audio', permissions)!}
                allowLabel="Allow system audio"
                settingsPath="Privacy & Security → Screen & System Audio Recording (System Audio Recording Only)"
                unsupported="Recording other apps needs macOS 14.4 or later. Oat still records your microphone."
              >
                To hear everyone else, Oat records the sound your call app plays — Zoom, Meet, Teams
                — as <Voice source="system">Them</Voice>. No bot joins your call, and your screen is
                never recorded.
              </PermissionStep>
            ) : current === 'calendar' ? (
              <CalendarStep permissions={permissions} headingRef={headingRef} />
            ) : (
              <TestStep test={test} input={input} headingRef={headingRef} />
            )}
          </div>
          <div className="flex items-center gap-2 border-t bg-muted/40 px-6 py-3">
            {back && (
              <Button variant="ghost" disabled={testBusy} onClick={() => go(back)}>
                Back
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {next ? (
                <Button
                  variant={done ? 'default' : 'ghost'}
                  disabled={testBusy}
                  onClick={() => go(next)}
                  data-testid="onboarding-next"
                >
                  {done ? 'Continue' : 'Skip for now'}
                </Button>
              ) : (
                <Button
                  variant={done ? 'default' : 'outline'}
                  disabled={testBusy}
                  onClick={() => onDone(true)}
                  data-testid="onboarding-finish"
                >
                  {done ? 'Finish setup' : 'Finish without a test'}
                </Button>
              )}
            </div>
          </div>
        </section>
        <p className="text-center text-xs text-muted-foreground">
          Signed in as{' '}
          <span data-selectable data-testid="onboarding-account">
            {email}
          </span>
        </p>
      </div>
    </main>
  );
}

function Stepper({
  current,
  isDone,
  disabled,
  onSelect,
}: {
  current: StepId;
  isDone: (step: StepId) => boolean;
  disabled: boolean;
  onSelect: (step: StepId) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => {
          const active = s === current;
          const complete = isDone(s);
          return (
            <li key={s} className="flex flex-col gap-2">
              <span
                aria-hidden
                className={cn(
                  'h-1 rounded-full bg-muted',
                  (active || complete) && 'bg-primary',
                  complete && !active && 'bg-primary/50',
                )}
              />
              <button
                type="button"
                disabled={disabled}
                aria-current={active ? 'step' : undefined}
                onClick={() => onSelect(s)}
                data-testid={`onboarding-nav-${s}`}
                className={cn(
                  'flex min-h-6 items-center gap-1.5 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none',
                  active && 'font-medium text-foreground',
                )}
              >
                {complete ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
                ) : (
                  <span aria-hidden className="w-3.5 shrink-0 text-center tabular-nums">
                    {i + 1}
                  </span>
                )}
                <span className="truncate">{STEP_LABELS[s]}</span>
                {complete && <span className="sr-only">(done)</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** "Me" / "Them" in that voice's colour, as the transcript shows them. */
function Voice({ source, children }: { source: 'mic' | 'system'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-sm px-1 font-medium',
        source === 'mic' ? 'bg-me text-me-foreground' : 'bg-them text-them-foreground',
      )}
    >
      {children}
    </span>
  );
}

function StepHeader({
  icon: Icon,
  title,
  headingRef,
  status,
}: {
  icon: LucideIcon;
  title: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  status?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon aria-hidden className="size-5" />
      </div>
      <h2
        id="onboarding-step-title"
        ref={headingRef}
        tabIndex={-1}
        className="font-heading text-xl font-semibold outline-none"
      >
        {title}
      </h2>
      {status && <div className="ml-auto">{status}</div>}
    </div>
  );
}

const STATUS: Record<PermissionView, { label: string; tone: 'ok' | 'muted' | 'off' }> = {
  done: { label: 'Allowed', tone: 'ok' },
  ask: { label: 'Not allowed yet', tone: 'muted' },
  blocked: { label: 'Turned off', tone: 'off' },
  unsupported: { label: 'Not available', tone: 'muted' },
  off: { label: 'Not used here', tone: 'muted' },
};

function StatusPill({ view, testId }: { view: PermissionView; testId?: string }) {
  const { label, tone } = STATUS[view];
  const Icon = tone === 'ok' ? CheckIcon : tone === 'off' ? AlertTriangleIcon : CircleDashedIcon;
  return (
    <span
      data-testid={testId}
      data-state={view}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap',
        tone === 'ok' && 'bg-success/12 text-success',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'off' && 'bg-destructive/10 text-destructive',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}

/** Runs a permission call with a pending flag and a user-facing error. */
function usePermissionAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

function PermissionStep({
  kind,
  icon,
  title,
  headingRef,
  view,
  allowLabel,
  settingsPath,
  unsupported,
  children,
}: {
  kind: PermissionKind;
  icon: LucideIcon;
  title: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  view: PermissionView;
  allowLabel: string;
  /** Where in System Settings → … the switch is. */
  settingsPath: string;
  unsupported?: string;
  children: ReactNode;
}) {
  const action = usePermissionAction();
  return (
    <>
      <StepHeader
        icon={icon}
        title={title}
        headingRef={headingRef}
        status={<StatusPill view={view} testId="permission-status" />}
      />
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      {view === 'ask' && (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="self-start"
            disabled={action.pending}
            onClick={() => void action.run(() => call('permissions:request', { kind }))}
            data-testid="permission-allow"
          >
            {action.pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            {allowLabel}
          </Button>
          <p className="text-xs text-muted-foreground">
            {action.pending
              ? 'Answer the macOS prompt to continue.'
              : 'macOS asks you to confirm. You can change this later in System Settings.'}
          </p>
        </div>
      )}
      {view === 'blocked' && (
        <FixInSettings kind={kind} path={settingsPath} pending={action.pending} run={action.run} />
      )}
      {view === 'unsupported' && unsupported && <Callout tone="info">{unsupported}</Callout>}
      <p role="status" className="text-xs text-destructive empty:hidden">
        {action.error}
      </p>
    </>
  );
}

/** A permission that was turned off: macOS won't ask again, so say where to turn it on and open that pane. */
function FixInSettings({
  kind,
  path,
  pending,
  run,
}: {
  kind: PermissionKind;
  path: string;
  pending: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <Callout tone="warn" testId="permission-blocked">
      <p className="font-medium text-foreground">Oat isn’t allowed to use this</p>
      <p>
        Turn Oat on in System Settings → {path}. Then come back here — this step updates by itself.
      </p>
      <Button
        variant="outline"
        className="mt-1 self-start text-foreground"
        disabled={pending}
        onClick={() => void run(() => call('permissions:open-settings', { kind }))}
        data-testid="permission-open-settings"
      >
        <ExternalLinkIcon data-icon="inline-start" />
        Open System Settings
      </Button>
    </Callout>
  );
}

function Callout({
  tone,
  children,
  testId,
}: {
  tone: Tone | 'info';
  children: ReactNode;
  testId?: string;
}) {
  const Icon = tone === 'ok' ? CheckIcon : tone === 'info' ? InfoIcon : AlertTriangleIcon;
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'flex gap-3 rounded-lg border px-3.5 py-3 text-sm',
        tone === 'ok' && 'border-success/30 bg-success/8',
        tone === 'info' && 'border-border bg-muted/50',
        tone === 'warn' && 'border-warning/40 bg-warning/10',
        tone === 'problem' && 'border-destructive/30 bg-destructive/8',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'ok' && 'text-success',
          tone === 'info' && 'text-muted-foreground',
          tone === 'warn' && 'text-warning',
          tone === 'problem' && 'text-destructive',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-muted-foreground">{children}</div>
    </div>
  );
}

function CalendarStep({
  permissions,
  headingRef,
}: {
  permissions: PermissionsSnapshot;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const mac = usePermissionAction();
  const google = usePermissionAction();
  const macView = stepView('calendar', { ...permissions, google: 'not_connected' })!;
  const googleConnected = permissions.google === 'ok';
  return (
    <>
      <StepHeader icon={CalendarDaysIcon} title="Your calendar" headingRef={headingRef} />
      <p className="text-sm leading-relaxed text-muted-foreground">
        With your calendar, Oat lists upcoming meetings, names each note after its meeting and adds
        who was invited. It never changes your calendar. Use either one, or both.
      </p>
      <ul className="flex flex-col divide-y rounded-lg border">
        <li className="flex flex-col gap-3 p-4" data-testid="calendar-mac">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Calendars on this Mac</span>
              <span className="text-xs text-muted-foreground">
                iCloud, Exchange and anything else in the Calendar app
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <StatusPill view={macView} testId="permission-status" />
              {macView === 'ask' && (
                <Button
                  disabled={mac.pending}
                  onClick={() =>
                    void mac.run(() => call('permissions:request', { kind: 'calendar' }))
                  }
                  data-testid="permission-allow"
                >
                  {mac.pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                  Allow calendars
                </Button>
              )}
            </div>
          </div>
          {macView === 'blocked' && (
            <FixInSettings
              kind="calendar"
              path="Privacy & Security → Calendars (Full Access)"
              pending={mac.pending}
              run={mac.run}
            />
          )}
          <p role="status" className="text-xs text-destructive empty:hidden">
            {mac.error}
          </p>
        </li>
        <li className="flex items-center gap-3 p-4" data-testid="calendar-google">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Google Calendar</span>
            <span className="text-xs text-muted-foreground">
              {googleConnected
                ? 'Connected to your Oat account'
                : 'Connect it in your browser; it works on every device you use'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {googleConnected ? (
              <StatusPill view="done" />
            ) : (
              <Button
                variant="outline"
                disabled={google.pending}
                onClick={() =>
                  void google.run(() => call('calendar:connect', { provider: 'google' }))
                }
                data-testid="calendar-connect-google"
              >
                <ExternalLinkIcon data-icon="inline-start" />
                Connect Google Calendar
              </Button>
            )}
          </div>
        </li>
      </ul>
      <p role="status" className="text-xs text-destructive empty:hidden">
        {google.error}
      </p>
    </>
  );
}

function TestStep({
  test,
  input,
  headingRef,
}: {
  test: TestRecordingSnapshot | null;
  input: string;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const action = usePermissionAction();
  const status = test?.status ?? 'idle';
  const busy = status === 'starting' || status === 'running';
  const verdict = test ? testVerdict(test) : null;
  const start = () => {
    const { input: kind, fixture } = startRequest(input);
    return action.run(() =>
      call('onboarding:test-start', { input: kind, ...(fixture ? { fixture } : {}) }),
    );
  };

  return (
    <>
      <StepHeader icon={MicIcon} title="Try a test recording" headingRef={headingRef} />
      <p className="text-sm leading-relaxed text-muted-foreground">
        Say a few words — and play something with sound if you like. Oat listens for{' '}
        {Math.round((test?.durationMs ?? 10_000) / 1000)} seconds and shows what it hears. Nothing
        is saved.
      </p>
      <div
        className="flex flex-col gap-4 rounded-lg border bg-background p-4"
        data-testid="test-recording"
        data-status={status}
      >
        <div className="flex items-center gap-3">
          {busy ? (
            <Button
              variant="destructive"
              onClick={() => void action.run(() => call('onboarding:test-stop'))}
              data-testid="test-stop"
            >
              <SquareIcon data-icon="inline-start" className="fill-current" />
              Stop
            </Button>
          ) : (
            <Button
              variant={status === 'idle' ? 'default' : 'outline'}
              disabled={action.pending}
              onClick={() => void start()}
              data-testid="test-start"
            >
              {status === 'idle' ? (
                <MicIcon data-icon="inline-start" />
              ) : (
                <RotateCcwIcon data-icon="inline-start" />
              )}
              {status === 'idle' ? 'Start test recording' : 'Test again'}
            </Button>
          )}
          <span
            className="ml-auto font-mono text-sm text-muted-foreground tabular-nums"
            data-testid="test-elapsed"
          >
            {status === 'starting' ? (
              <span className="inline-flex items-center gap-1.5 font-sans">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                Starting…
              </span>
            ) : (
              `${seconds(test?.elapsedMs ?? 0)} / ${seconds(test?.durationMs ?? 10_000)}`
            )}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <WideMeter
            label="Me"
            source="mic"
            db={busy ? test?.levels.mic?.rmsDb : undefined}
            heard={!!test?.heard.mic}
          />
          <WideMeter
            label="Them"
            source="system"
            db={busy ? test?.levels.system?.rmsDb : undefined}
            heard={!!test?.heard.system}
          />
        </div>
        <div
          aria-live="polite"
          className="flex min-h-12 items-center rounded-md bg-muted/60 px-3 py-2 text-sm"
          data-testid="test-line"
        >
          {test?.line ? (
            <p data-selectable>
              <span className="mr-1.5 text-xs font-medium text-muted-foreground">
                {test.line.source === 'mic' ? 'Me' : 'Them'}
              </span>
              {test.line.text}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {busy
                ? test?.transcription === 'unavailable'
                  ? 'Live transcription isn’t available right now.'
                  : 'Listening…'
                : 'What Oat hears shows up here.'}
            </p>
          )}
        </div>
      </div>
      {verdict && (
        <Callout tone={verdict.tone} testId="test-verdict">
          <p className="font-medium text-foreground">{verdict.title}</p>
          <p>{verdict.detail}</p>
        </Callout>
      )}
      <p role="status" className="text-xs text-destructive empty:hidden">
        {action.error}
      </p>
    </>
  );
}

function WideMeter({
  label,
  source,
  db,
  heard,
}: {
  label: string;
  source: 'mic' | 'system';
  db: number | undefined;
  heard: boolean;
}) {
  const fill = levelFill(db);
  return (
    <div className="flex flex-col gap-1.5" data-testid={`test-level-${source}`} data-heard={heard}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        {heard && (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckIcon aria-hidden className="size-3" />
            Heard
          </span>
        )}
      </div>
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
        className={cn('h-2 overflow-hidden rounded-full', source === 'mic' ? 'bg-me' : 'bg-them')}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-150 ease-out',
            source === 'mic' ? 'bg-me-foreground' : 'bg-them-foreground',
          )}
          style={{ width: `${fill * 100}%` }}
        />
      </div>
    </div>
  );
}
