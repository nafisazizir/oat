import type { PermissionsSnapshot, TestRecordingSnapshot } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import {
  audioPermissionView,
  calendarPermissionView,
  firstOpenStep,
  nextStep,
  previousStep,
  seconds,
  stepDone,
  stepView,
  testVerdict,
} from './onboarding-steps.ts';

const fresh: PermissionsSnapshot = {
  microphone: 'not_determined',
  systemAudio: 'not_determined',
  systemAudioSupported: true,
  calendar: 'not_determined',
  google: 'not_connected',
};
const allowed: PermissionsSnapshot = {
  ...fresh,
  microphone: 'granted',
  systemAudio: 'granted',
  calendar: 'full_access',
};
const test = (patch: Partial<TestRecordingSnapshot>): TestRecordingSnapshot => ({
  seq: 1,
  status: 'done',
  elapsedMs: 10_000,
  durationMs: 10_000,
  levels: { mic: null, system: null },
  heard: { mic: true, system: true },
  line: { source: 'mic', text: 'Hello there' },
  transcription: 'live',
  error: null,
  ...patch,
});

describe('permission views', () => {
  it('microphone / system audio: allowed, ask (never asked or unknown), blocked', () => {
    expect(audioPermissionView('granted')).toBe('done');
    expect(audioPermissionView('not_determined')).toBe('ask');
    expect(audioPermissionView('unknown')).toBe('ask');
    expect(audioPermissionView('denied')).toBe('blocked');
    expect(audioPermissionView('restricted')).toBe('blocked');
    expect(audioPermissionView('granted', false)).toBe('unsupported');
  });

  it('calendar: write-only can’t read events (System Settings); off = no Mac calendar here', () => {
    expect(calendarPermissionView('full_access')).toBe('done');
    expect(calendarPermissionView('not_determined')).toBe('ask');
    expect(calendarPermissionView('write_only')).toBe('blocked');
    expect(calendarPermissionView('denied')).toBe('blocked');
    expect(calendarPermissionView('off')).toBe('off');
  });

  it('Google Calendar connected is enough for the calendar step', () => {
    expect(stepView('calendar', { ...fresh, calendar: 'denied', google: 'ok' })).toBe('done');
    expect(stepView('calendar', { ...fresh, calendar: 'denied' })).toBe('blocked');
  });
});

describe('step machine', () => {
  it('opens at the first permission still to allow, else the test', () => {
    expect(firstOpenStep(null)).toBe('microphone');
    expect(firstOpenStep(fresh)).toBe('microphone');
    expect(firstOpenStep({ ...fresh, microphone: 'granted' })).toBe('system-audio');
    expect(firstOpenStep({ ...fresh, microphone: 'granted', systemAudio: 'granted' })).toBe(
      'calendar',
    );
    expect(firstOpenStep(allowed)).toBe('test');
    // An unsupported system-audio step counts as done.
    expect(firstOpenStep({ ...fresh, microphone: 'granted', systemAudioSupported: false })).toBe(
      'calendar',
    );
    // A denied permission is still open (it needs System Settings).
    expect(firstOpenStep({ ...allowed, microphone: 'denied' })).toBe('microphone');
  });

  it('done per step', () => {
    expect(stepDone('microphone', allowed, null)).toBe(true);
    expect(stepDone('microphone', fresh, null)).toBe(false);
    expect(stepDone('microphone', null, null)).toBe(false);
    expect(stepDone('test', allowed, null)).toBe(false);
    expect(stepDone('test', allowed, test({}))).toBe(true);
    expect(stepDone('test', allowed, test({ status: 'error' }))).toBe(false);
  });

  it('next / previous', () => {
    expect(nextStep('microphone')).toBe('system-audio');
    expect(nextStep('calendar')).toBe('test');
    expect(nextStep('test')).toBeNull();
    expect(previousStep('microphone')).toBeNull();
    expect(previousStep('test')).toBe('calendar');
  });
});

describe('testVerdict', () => {
  it('nothing until the test ended', () => {
    expect(testVerdict(test({ status: 'running' }))).toBeNull();
    expect(testVerdict(test({ status: 'idle' }))).toBeNull();
  });

  it('ok with both voices; says what “Them” is when no other app played', () => {
    expect(testVerdict(test({}))).toMatchObject({ tone: 'ok', title: 'Oat hears you' });
    expect(testVerdict(test({ heard: { mic: true, system: false } }))?.detail).toMatch(/Them/);
  });

  it('warns when the mic was silent, transcription was down, or no words came', () => {
    expect(testVerdict(test({ heard: { mic: false, system: true } }))).toMatchObject({
      tone: 'warn',
      title: expect.stringMatching(/microphone/),
    });
    expect(testVerdict(test({ transcription: 'unavailable', line: null }))?.title).toMatch(
      /transcription/,
    );
    expect(testVerdict(test({ line: null }))?.title).toMatch(/no words/);
  });

  it('a failed test shows its error', () => {
    expect(testVerdict(test({ status: 'error', error: 'No audio helper.' }))).toEqual({
      tone: 'problem',
      title: 'The test didn’t work',
      detail: 'No audio helper.',
    });
  });
});

it('seconds', () => {
  expect(seconds(0)).toBe('0:00');
  expect(seconds(4_900)).toBe('0:04');
  expect(seconds(70_000)).toBe('1:10');
});
