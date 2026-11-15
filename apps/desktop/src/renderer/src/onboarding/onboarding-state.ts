/**
 * Renderer side of first-run setup (9.2): permission states, the test recording and this account's setup
 * state, from main (`permissions:*`, `onboarding:*`). Subscribes before asking, like
 * `calendar-state.ts`.
 */
import type { OnboardingState, PermissionsSnapshot, TestRecordingSnapshot } from '@oat/core/bridge';
import { useCallback, useEffect, useState } from 'react';

import { bridge, call } from '../bridge.ts';

/**
 * Permission states, re-read when main says they changed, when the calendar changed (EventKit access) and
 * when the window comes back to the front (the user may have just changed one in System Settings).
 */
export function usePermissions(enabled = true): PermissionsSnapshot | null {
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () =>
      void call('permissions:get')
        .then((p) => live && setSnapshot(p))
        .catch(() => {});
    const offChanged = bridge().subscribe('permissions:changed', (p) => live && setSnapshot(p));
    const offCalendar = bridge().subscribe('calendar:changed', refresh);
    window.addEventListener('focus', refresh);
    refresh();
    return () => {
      live = false;
      offChanged();
      offCalendar();
      window.removeEventListener('focus', refresh);
    };
  }, [enabled]);
  return snapshot;
}

export function useTestRecording(): TestRecordingSnapshot | null {
  const [snapshot, setSnapshot] = useState<TestRecordingSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    const apply = (next: TestRecordingSnapshot) => {
      if (live) setSnapshot((cur) => (cur && cur.seq > next.seq ? cur : next));
    };
    const unsubscribe = bridge().subscribe('onboarding:test-state', apply);
    void call('onboarding:test-get')
      .then(apply)
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return snapshot;
}

/** This account's setup state; `null` while loading. */
export function useOnboarding(userId: string) {
  const [loaded, setLoaded] = useState<{ userId: string; state: OnboardingState } | null>(null);
  useEffect(() => {
    let live = true;
    void call('onboarding:get')
      .then((state) => live && setLoaded({ userId, state }))
      // Can't tell: don't hold the app hostage to setup.
      .catch(() => live && setLoaded({ userId, state: { needed: false, guide: false } }));
    return () => {
      live = false;
    };
  }, [userId]);
  const update = useCallback(
    (fn: (s: OnboardingState) => OnboardingState) =>
      setLoaded((l) => l && { ...l, state: fn(l.state) }),
    [],
  );
  const complete = useCallback(
    (guide: boolean) =>
      call('onboarding:complete', { guide })
        .then((state) => update(() => state))
        .catch(() => update((s) => ({ ...s, needed: false }))),
    [update],
  );
  const dismissGuide = useCallback(
    () =>
      call('onboarding:dismiss-guide')
        .then((state) => update(() => state))
        .catch(() => update((s) => ({ ...s, guide: false }))),
    [update],
  );
  return { state: loaded?.userId === userId ? loaded.state : null, complete, dismissGuide };
}
