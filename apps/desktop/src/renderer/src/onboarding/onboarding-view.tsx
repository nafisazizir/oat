/**
 * First-run setup (9.2): microphone → system audio → calendar → a test recording, each explained, each
 * permission asked for only when the user clicks "Allow". A permission that was turned off can only be changed
 * in System Settings, so the step says where and opens that pane. Every step can be skipped; closing the dialog
 * leaves at any time (Settings → Setup brings it back).
 *
 */
import type { PermissionKind, PermissionsSnapshot, TestRecordingSnapshot } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@oat/ui/components/dialog';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import {
  type Icon as TablerIcon,
  IconAlertTriangle,
  IconCalendarEvent,
  IconCheck,
  IconCircleDashed,
  IconExternalLink,
  IconInfoCircle,
  IconMicrophone,
  IconPlayerStopFilled,
  IconRotate,
  IconVolume,
} from '@tabler/icons-react';
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
  input,
  onDone,
}: {
  /** First run of this account on this Mac (else re-opened from Settings). */
  firstRun: boolean;
  /** The recording input choice (dev fixtures; `sidecar` = live capture). */
  input: string;
  /** `finished`: the last step's "Finish setup" (else the dialog was closed). */
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
    // A dialog over the signed-in app (D-39). There is no button to leave: a click outside or Escape closes
    // it, which skips setup (not while the test recording runs).
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !testBusy) onDone(false);
      }}
    >
      {/* Centred, with a fixed height: the steps and the Back/Continue row never move. A longer state (a
          permission to fix in System Settings, a test verdict) scrolls inside, above the row. */}
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(33rem,calc(100vh-4rem))] flex-col gap-7 px-8 py-7 sm:max-w-[32.5rem]"
        data-testid="onboarding"
        data-step={current}
      >
        <DialogTitle render={<h1 />} className="sr-only">
          {firstRun ? 'Set up Oat' : 'Setup'}
        </DialogTitle>
        <Stepper
          current={current}
          isDone={(s) => stepDone(s, permissions, test)}
          disabled={testBusy}
          onSelect={go}
        />

        <section
          aria-labelledby="onboarding-step-title"
          className="flex min-h-0 flex-1 flex-col gap-6 text-gray-1000"
          data-testid={`onboarding-step-${current}`}
        >
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
            {!permissions ? (
              <div role="status" aria-busy className="flex h-40 items-center justify-center">
                <Spinner aria-label="Loading" className="size-5 text-gray-900" />
              </div>
            ) : current === 'microphone' ? (
              <PermissionStep
                kind="microphone"
                icon={IconMicrophone}
                title="Your microphone"
                headingRef={headingRef}
                view={stepView('microphone', permissions)!}
                allowLabel="Allow microphone"
                settingsPath="Privacy & Security → Microphone"
              >
                Your voice is <Voice source="mic">Me</Voice>. Audio stays on this Mac — never
                uploaded.
              </PermissionStep>
            ) : current === 'system-audio' ? (
              <PermissionStep
                kind="system_audio"
                icon={IconVolume}
                title="The other side of the call"
                headingRef={headingRef}
                view={stepView('system-audio', permissions)!}
                allowLabel="Allow system audio"
                settingsPath="Privacy & Security → Screen & System Audio Recording (System Audio Recording Only)"
                unsupported="Recording other apps needs macOS 14.4 or later. Oat still records your microphone."
              >
                Call audio is <Voice source="system">Them</Voice>. No bot joins, and your screen is
                never recorded.
              </PermissionStep>
            ) : current === 'calendar' ? (
              <CalendarStep permissions={permissions} headingRef={headingRef} />
            ) : (
              <TestStep test={test} input={input} headingRef={headingRef} />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {back && (
              <Button variant="secondary" disabled={testBusy} onClick={() => go(back)}>
                Go back
              </Button>
            )}
            <div className="ms-auto flex items-center gap-2">
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
                  variant={done ? 'default' : 'ghost'}
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
      </DialogContent>
    </Dialog>
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
      <ol className="flex gap-1.5">
        {STEPS.map((s) => {
          const active = s === current;
          const complete = isDone(s);
          return (
            <li key={s} className="flex-1">
              {/* The bar is thin; the button around it is the (taller) click target. Dark = the step on screen, mid = done,
                  faint = still to do. */}
              <button
                type="button"
                disabled={disabled}
                title={STEP_LABELS[s]}
                aria-current={active ? 'step' : undefined}
                onClick={() => onSelect(s)}
                data-testid={`onboarding-nav-${s}`}
                data-complete={complete || undefined}
                className="group flex h-8 w-full items-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-gray-600/50 disabled:pointer-events-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1 w-full rounded-full transition-colors',
                    active
                      ? 'bg-gray-1000'
                      : complete
                        ? 'bg-gray-alpha-600 group-hover:bg-gray-alpha-800'
                        : 'bg-gray-alpha-200 group-hover:bg-gray-alpha-500',
                  )}
                />
                <span className="sr-only">{STEP_LABELS[s]}</span>
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
        'rounded-sm px-1',
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
  icon: TablerIcon;
  title: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  status?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-1000">
          <Icon aria-hidden className="size-5" />
        </div>
        {status}
      </div>
      <h2
        id="onboarding-step-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-heading-24 text-gray-1000 outline-none"
      >
        {title}
      </h2>
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
  const Icon = tone === 'ok' ? IconCheck : tone === 'off' ? IconAlertTriangle : IconCircleDashed;
  return (
    <span
      data-testid={testId}
      data-state={view}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-label-12 text-gray-1000 whitespace-nowrap',
        tone === 'ok' && 'bg-green-100 text-green-900',
        tone === 'muted' && 'bg-gray-100 text-gray-900',
        tone === 'off' && 'bg-red-100 text-red-900',
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
  icon: TablerIcon;
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
      <p className="text-copy-14 text-gray-900">{children}</p>
      {view === 'ask' && (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="self-start"
            disabled={action.pending}
            onClick={() => void action.run(() => call('permissions:request', { kind }))}
            data-testid="permission-allow"
          >
            {action.pending && <Spinner data-icon="inline-start" />}
            {allowLabel}
          </Button>
          <p className="text-label-12 text-gray-900">
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
      <p role="status" className="text-copy-13 text-red-900 empty:hidden">
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
  primary = true,
}: {
  kind: PermissionKind;
  path: string;
  pending: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  primary?: boolean;
}) {
  return (
    <Callout tone="warn" testId="permission-blocked">
      <p>Turn Oat on in System Settings → {path}.</p>
      <Button
        variant={primary ? 'default' : 'outline'}
        className="mt-1 self-start"
        disabled={pending}
        onClick={() => void run(() => call('permissions:open-settings', { kind }))}
        data-testid="permission-open-settings"
      >
        <IconExternalLink data-icon="inline-start" />
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
  const Icon = tone === 'ok' ? IconCheck : tone === 'info' ? IconInfoCircle : IconAlertTriangle;
  return (
    <div data-testid={testId} data-tone={tone} className="flex gap-2 text-copy-14 text-gray-1000">
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'ok' && 'text-green-900',
          tone === 'info' && 'text-gray-900',
          tone === 'warn' && 'text-amber-900',
          tone === 'problem' && 'text-red-900',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-gray-900">{children}</div>
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
      <StepHeader icon={IconCalendarEvent} title="Your calendar" headingRef={headingRef} />
      <p className="text-copy-14 text-gray-900">
        See upcoming meetings and attendees. Oat never changes your calendar.
      </p>
      <ul className="flex flex-col gap-5">
        <li className="flex flex-col gap-3" data-testid="calendar-mac">
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-label-14 text-gray-1000">Calendars on this Mac</span>
              <span className="text-label-12 text-gray-900">
                iCloud, Exchange and anything else in the Calendar app
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <StatusPill view={macView} testId="permission-status" />
              {macView === 'ask' && (
                <Button
                  variant={googleConnected ? 'outline' : 'default'}
                  disabled={mac.pending}
                  onClick={() =>
                    void mac.run(() => call('permissions:request', { kind: 'calendar' }))
                  }
                  data-testid="permission-allow"
                >
                  {mac.pending && <Spinner data-icon="inline-start" />}
                  Allow calendars
                </Button>
              )}
            </div>
          </div>
          {macView === 'blocked' && (
            <FixInSettings
              kind="calendar"
              primary={!googleConnected}
              path="Privacy & Security → Calendars (Full Access)"
              pending={mac.pending}
              run={mac.run}
            />
          )}
          <p role="status" className="text-copy-13 text-red-900 empty:hidden">
            {mac.error}
          </p>
        </li>
        <li className="flex flex-col gap-3" data-testid="calendar-google">
          <div className="flex min-w-0 flex-col">
            <span className="text-label-14 text-gray-1000">Google Calendar</span>
            <span className="text-label-12 text-gray-900">
              {googleConnected
                ? 'Connected to your Oat account'
                : 'Connect it in your browser; it works on every device you use'}
            </span>
          </div>
          <div className="ms-auto flex items-center gap-2">
            {googleConnected ? (
              <StatusPill view="done" />
            ) : (
              <Button
                variant={macView === 'off' ? 'default' : 'outline'}
                disabled={google.pending}
                onClick={() =>
                  void google.run(() => call('calendar:connect', { provider: 'google' }))
                }
                data-testid="calendar-connect-google"
              >
                <IconExternalLink data-icon="inline-start" />
                Connect Google Calendar
              </Button>
            )}
          </div>
        </li>
      </ul>
      <p role="status" className="text-copy-13 text-red-900 empty:hidden">
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
      <StepHeader icon={IconMicrophone} title="Try a test recording" headingRef={headingRef} />
      <p className="text-copy-14 text-gray-900">
        Say a few words — and play something with sound if you like. Oat listens for{' '}
        {Math.round((test?.durationMs ?? 10_000) / 1000)} seconds and shows what it hears. Nothing
        is saved.
      </p>
      <div className="flex flex-col gap-4" data-testid="test-recording" data-status={status}>
        <div className="flex items-center gap-3">
          {busy ? (
            <Button
              onClick={() => void action.run(() => call('onboarding:test-stop'))}
              data-testid="test-stop"
            >
              <IconPlayerStopFilled data-icon="inline-start" />
              Stop
            </Button>
          ) : (
            <Button
              variant={status === 'done' ? 'outline' : 'default'}
              disabled={action.pending}
              onClick={() => void start()}
              data-testid="test-start"
            >
              {status === 'idle' ? (
                <IconMicrophone data-icon="inline-start" />
              ) : (
                <IconRotate data-icon="inline-start" />
              )}
              {status === 'idle' ? 'Start test recording' : 'Test again'}
            </Button>
          )}
          <span
            className="ms-auto text-copy-14-mono text-gray-900 tabular-nums"
            data-testid="test-elapsed"
          >
            {status === 'starting' ? (
              <span className="inline-flex items-center gap-1.5 font-sans">
                <Spinner aria-hidden className="size-3.5" />
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
          className="flex min-h-12 items-center rounded-md bg-gray-100 px-3 py-2 text-copy-14 text-gray-1000"
          data-testid="test-line"
        >
          {test?.line ? (
            <p data-selectable>
              <span className="me-1.5 text-label-12 text-gray-900">
                {test.line.source === 'mic' ? 'Me' : 'Them'}
              </span>
              {test.line.text}
            </p>
          ) : (
            <p className="text-gray-900">
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
          <p className="text-label-14 text-gray-1000">{verdict.title}</p>
          <p>{verdict.detail}</p>
        </Callout>
      )}
      <p role="status" className="text-copy-13 text-red-900 empty:hidden">
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
      <div className="flex items-center justify-between text-label-12">
        <span className="text-gray-1000">{label}</span>
        {heard && (
          <span className="inline-flex items-center gap-1 text-green-900">
            <IconCheck aria-hidden className="size-3" />
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
