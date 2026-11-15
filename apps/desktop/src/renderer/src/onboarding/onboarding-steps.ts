/**
 * First-run setup (9.2) as pure functions: which step shows what, given the permission states the sidecar
 * reports and the test recording's outcome. No React, unit-tested (`onboarding-steps.test.ts`).
 *
 * Steps: microphone → system audio → calendar → test recording; the user can skip any of them (setup never
 * blocks using Oat) and go back. "Allow" is offered only while macOS never asked; a denied permission can only
 * be changed in System Settings, so the step says how and opens the right pane.
 */
import type {
  EventkitState,
  PermissionsSnapshot,
  PermissionState,
  TestRecordingSnapshot,
} from '@oat/core/bridge';

export const STEPS = ['microphone', 'system-audio', 'calendar', 'test'] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  microphone: 'Microphone',
  'system-audio': 'System audio',
  calendar: 'Calendar',
  test: 'Test recording',
};

/**
 * What a permission step offers: `done` (allowed), `ask` ("Allow" → the macOS prompt), `blocked` (turned off:
 * System Settings), `unsupported` (this macOS can't), `off` (this build reads no Mac calendar).
 */
export type PermissionView = 'done' | 'ask' | 'blocked' | 'unsupported' | 'off';

export function audioPermissionView(state: PermissionState, supported = true): PermissionView {
  if (!supported) return 'unsupported';
  switch (state) {
    case 'granted':
      return 'done';
    case 'not_determined':
    case 'unknown':
      return 'ask';
    case 'denied':
    case 'restricted':
      return 'blocked';
  }
}

export function calendarPermissionView(state: EventkitState): PermissionView {
  switch (state) {
    case 'full_access':
      return 'done';
    case 'not_determined':
    case 'unknown':
      return 'ask';
    case 'off':
      return 'off';
    // Write-only access can't read events: it is changed in System Settings like a denial.
    case 'write_only':
    case 'denied':
    case 'restricted':
    case 'error':
      return 'blocked';
  }
}

export function stepView(step: StepId, p: PermissionsSnapshot): PermissionView | null {
  switch (step) {
    case 'microphone':
      return audioPermissionView(p.microphone);
    case 'system-audio':
      return audioPermissionView(p.systemAudio, p.systemAudioSupported);
    case 'calendar':
      // Google Calendar alone is enough to see upcoming meetings.
      return p.google === 'ok' ? 'done' : calendarPermissionView(p.calendar);
    case 'test':
      return null;
  }
}

/** A step is finished: its permission is allowed (or can't apply here), or the test recording ran. */
export function stepDone(
  step: StepId,
  p: PermissionsSnapshot | null,
  test: TestRecordingSnapshot | null,
): boolean {
  if (step === 'test') return test?.status === 'done';
  if (!p) return false;
  const view = stepView(step, p);
  return view === 'done' || view === 'unsupported';
}

/** Where setup opens: the first permission still to allow, else the test recording. */
export function firstOpenStep(p: PermissionsSnapshot | null): StepId {
  if (!p) return 'microphone';
  return STEPS.find((s) => s !== 'test' && !stepDone(s, p, null)) ?? 'test';
}

export function nextStep(step: StepId): StepId | null {
  return STEPS[STEPS.indexOf(step) + 1] ?? null;
}

export function previousStep(step: StepId): StepId | null {
  return STEPS[STEPS.indexOf(step) - 1] ?? null;
}

export type Tone = 'ok' | 'warn' | 'problem';

/** What the test recording found, in words: shown once it ended. */
export function testVerdict(
  t: TestRecordingSnapshot,
): { tone: Tone; title: string; detail: string } | null {
  if (t.status === 'error') {
    return { tone: 'problem', title: 'The test didn’t work', detail: t.error ?? 'Try again.' };
  }
  if (t.status !== 'done') return null;
  if (!t.heard.mic) {
    return {
      tone: 'warn',
      title: 'Oat didn’t hear your microphone',
      detail:
        'Check that the right microphone is selected in System Settings → Sound → Input, then try again.',
    };
  }
  if (t.transcription === 'unavailable') {
    return {
      tone: 'warn',
      title: 'Oat hears you, but live transcription didn’t connect',
      detail:
        'Recording still works: Oat transcribes the saved audio once it can. Check your connection and try again.',
    };
  }
  if (!t.line) {
    return {
      tone: 'warn',
      title: 'Oat hears you, but no words came through',
      detail: 'Speak a full sentence close to the microphone, then try again.',
    };
  }
  return {
    tone: 'ok',
    title: 'Oat hears you',
    detail: t.heard.system
      ? 'Your voice and the sound from other apps both came through.'
      : 'Your voice came through. On a call, the other side shows up as “Them”.',
  };
}

/** `0:04 / 0:10`-style seconds for the test's timer. */
export function seconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
