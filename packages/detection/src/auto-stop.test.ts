/**
 * Edge cases of the auto-stop rules the fixture timelines don't pin down: exact boundaries (floor, ±5 min),
 * event choice, purity, settings changes under a pending stop, answers to stale notices, `nextAutoStopDeadline`
 * and the `AutoStopper` timer.
 */
import { describe, expect, it } from 'vitest';

import {
  autoStop,
  type AutoStopAction,
  type AutoStopInput,
  type AutoStopState,
  DEFAULT_AUTO_STOP_CONFIG,
  eventForCall,
  initialAutoStopState,
  type MeetingEndedAction,
  nextAutoStopDeadline,
} from './auto-stop.ts';
import { AutoStopper } from './auto-stopper.ts';
import { timelineEvent } from './timeline.ts';

const T0 = Date.parse('2026-11-16T17:00:00Z');
const MIN = 60_000;
const event = (id: string, start: string, end: string, extra: object = {}) =>
  timelineEvent({ id, title: id, start, end, ...extra });
const WEEKLY = event('weekly', '2026-11-16T17:00:00Z', '2026-11-16T17:30:00Z');

const ended = (
  startedAt: number,
  endedAt: number,
  extra: Partial<MeetingEndedAction> = {},
): MeetingEndedAction => ({
  type: 'meetingEnded',
  at: new Date(endedAt + 2000),
  startedAt: new Date(startedAt),
  endedAt: new Date(endedAt),
  appIds: ['zoom'],
  recording: true,
  recordingStartedDuringMeeting: true,
  prompted: true,
  eventId: null,
  ...extra,
});

class Harness {
  state: AutoStopState;
  log: { at: number; action: AutoStopAction }[] = [];
  constructor(init: Parameters<typeof initialAutoStopState>[0] = {}) {
    this.state = initialAutoStopState({ now: new Date(T0), ...init });
  }
  at(ms: number, input: AutoStopInput): AutoStopAction[] {
    const r = autoStop(this.state, input, new Date(T0 + ms));
    this.state = r.state;
    for (const action of r.actions) this.log.push({ at: ms, action });
    return r.actions;
  }
  /** Ticks at every deadline up to `until`. */
  run(until: number) {
    for (;;) {
      const d = nextAutoStopDeadline(this.state);
      if (d === null || d - T0 > until) return;
      this.at(d - T0, { type: 'tick' });
    }
  }
  get types() {
    return this.log.map((l) => `${l.at}:${l.action.type}:${l.action.reason}`);
  }
}

const C = DEFAULT_AUTO_STOP_CONFIG.confirmMs;

/** Recording from 0 with sound, a strict Zoom call 0 → `endedAt`, ticked through its confirmation period. */
function callEnding(endedAt: number, h = new Harness({ events: [WEEKLY] })) {
  h.at(0, { type: 'recording', recording: true });
  h.at(0, { type: 'levels', mic: -20, system: null });
  h.at(0, { type: 'apps', appIds: ['zoom'] });
  h.at(endedAt, { type: 'apps', appIds: [] });
  h.at(endedAt + 2000, { type: 'meetingEnded', ended: ended(T0, T0 + endedAt) });
  h.run(endedAt + C);
  return h;
}

describe('autoStop', () => {
  it('stops for an event ending exactly 5 min after the call, asks at 5 min + 1 ms', () => {
    // WEEKLY ends at 30 min.
    expect(callEnding(25 * MIN).types).toEqual([`${25 * MIN + C}:stopping:meeting_ended`]);
    expect(callEnding(35 * MIN).types).toEqual([`${35 * MIN + C}:stopping:meeting_ended`]);
    expect(callEnding(25 * MIN - 1).types).toEqual([`${25 * MIN - 1 + C}:ask:meeting_ended`]);
  });

  it('waits the confirmation period after the release, not 1 ms less', () => {
    const h = new Harness({ events: [WEEKLY] });
    h.at(0, { type: 'recording', recording: true });
    h.at(0, { type: 'levels', mic: -20, system: null });
    h.at(29 * MIN + 2000, { type: 'meetingEnded', ended: ended(T0, T0 + 29 * MIN) });
    expect(nextAutoStopDeadline(h.state)).toBe(T0 + 29 * MIN + C);
    h.at(29 * MIN + C - 1, { type: 'tick' });
    expect(h.log).toEqual([]);
    h.at(29 * MIN + C, { type: 'tick' });
    expect(h.types).toEqual([`${29 * MIN + C}:stopping:meeting_ended`]);
  });

  it('decides exactly at the floor, not 1 ms before', () => {
    const h = new Harness({ events: [WEEKLY] });
    h.at(0, { type: 'recording', recording: true });
    h.at(0, { type: 'levels', mic: -20, system: null });
    h.at(MIN + 2000, { type: 'meetingEnded', ended: ended(T0, T0 + MIN) });
    expect(nextAutoStopDeadline(h.state)).toBe(T0 + DEFAULT_AUTO_STOP_CONFIG.floorMs);
    h.at(DEFAULT_AUTO_STOP_CONFIG.floorMs - 1, { type: 'tick' });
    expect(h.log).toEqual([]);
    h.at(DEFAULT_AUTO_STOP_CONFIG.floorMs, { type: 'tick' });
    // The call ended at 1 min, WEEKLY ends at 30: not clearly over.
    expect(h.types).toEqual([`${3 * MIN}:ask:meeting_ended`]);
  });

  it('any reappearance of the call’s app resumes it — another app doesn’t', () => {
    const h = new Harness({ events: [WEEKLY] });
    h.at(0, { type: 'recording', recording: true });
    h.at(0, { type: 'levels', mic: -20, system: null });
    h.at(0, { type: 'apps', appIds: ['zoom'] });
    h.at(29 * MIN, { type: 'apps', appIds: [] });
    h.at(29 * MIN + 2000, { type: 'meetingEnded', ended: ended(T0, T0 + 29 * MIN) });
    h.at(29 * MIN + 5000, { type: 'apps', appIds: ['slack'] });
    expect(h.state.pendingEnd).not.toBeNull();
    h.at(29 * MIN + 6000, { type: 'apps', appIds: ['slack', 'zoom'] });
    expect(h.state.pendingEnd).toBeNull();
    expect(h.state.recording?.carry).toMatchObject({ strict: true, eventId: WEEKLY.id });
    h.run(40 * MIN);
    expect(h.log).toEqual([]);
  });

  it('the other side still talking after the release → ask, not stop; the call’s own tail doesn’t count', () => {
    const talk = (tailMs: number) => {
      const h = new Harness({ events: [WEEKLY] });
      h.at(0, { type: 'recording', recording: true });
      h.at(0, { type: 'levels', mic: -20, system: -25 });
      h.at(29 * MIN + tailMs, { type: 'levels', mic: -20, system: -70 });
      h.at(29 * MIN + 2000, { type: 'meetingEnded', ended: ended(T0, T0 + 29 * MIN) });
      h.run(29 * MIN + C);
      return h.types;
    };
    expect(talk(1500)).toEqual([`${29 * MIN + C}:stopping:meeting_ended`]);
    expect(talk(5000)).toEqual([`${29 * MIN + C}:ask:meeting_ended`]);
  });

  it('stops after the undo window unless kept; a stale keep does nothing', () => {
    const h = callEnding(29 * MIN);
    const [stopping] = h.log.map((l) => l.action);
    expect(stopping).toMatchObject({
      type: 'stopping',
      stopAt: new Date(T0 + 29 * MIN + C + 10_000),
    });
    expect(h.at(29 * MIN + C + 3000, { type: 'keep', id: 'nope' })).toEqual([]);
    h.run(40 * MIN);
    expect(h.types).toEqual([
      `${29 * MIN + C}:stopping:meeting_ended`,
      `${29 * MIN + C + 10_000}:stop:meeting_ended`,
    ]);
    expect(h.state.notice).toBeNull();
  });

  it('switching auto-stop off under the toast cancels it; on again does not bring it back', () => {
    const h = callEnding(29 * MIN);
    h.at(29 * MIN + C + 4000, { type: 'settings', settings: { enabled: false, inPerson: false } });
    h.at(29 * MIN + C + 5000, { type: 'settings', settings: { enabled: true, inPerson: false } });
    h.run(40 * MIN);
    expect(h.types).toEqual([
      `${29 * MIN + C}:stopping:meeting_ended`,
      `${29 * MIN + C + 4000}:cancel:settings`,
    ]);
  });

  it('a "Stop recording" answer clears the question without a cancel', () => {
    const h = callEnding(10 * MIN);
    const id = h.state.notice!.id;
    expect(h.at(10 * MIN + C + 5000, { type: 'answered', id })).toEqual([]);
    expect(h.at(10 * MIN + C + 5000, { type: 'recording', recording: false })).toEqual([]);
  });

  it('ignores ends while not recording and ends the meeting app saw without a recording', () => {
    const h = new Harness({ events: [WEEKLY] });
    h.at(29 * MIN, { type: 'meetingEnded', ended: ended(T0, T0 + 29 * MIN) });
    h.at(0, { type: 'recording', recording: true });
    h.at(29 * MIN, {
      type: 'meetingEnded',
      ended: ended(T0, T0 + 29 * MIN, { recording: false }),
    });
    h.at(29 * MIN, { type: 'levels', mic: -10, system: -60 });
    h.run(40 * MIN);
    expect(h.log).toEqual([]);
  });

  it('a repeated recording start keeps the original start (floor) and state', () => {
    const h = new Harness();
    h.at(0, { type: 'recording', recording: true, eventId: 'eventkit:x' });
    h.at(MIN, { type: 'recording', recording: true });
    expect(h.state.recording).toMatchObject({ since: T0, eventId: 'eventkit:x' });
  });

  it('a call open at the start makes the recording a call (silence asks, never auto)', () => {
    const h = new Harness({ settings: { inPerson: true } });
    h.at(0, { type: 'call', open: true });
    h.at(1000, { type: 'recording', recording: true });
    expect(h.state.recording?.call).toBe(true);
    h.run(20 * MIN);
    expect(h.types).toEqual([`${10 * MIN + 1000}:ask:silence`]);
  });

  it('missing levels count as quiet; a newer notice replaces the silence one', () => {
    const h = new Harness({ events: [WEEKLY] });
    h.at(0, { type: 'recording', recording: true });
    h.at(0, { type: 'levels', mic: null, system: null });
    h.run(11 * MIN);
    h.at(12 * MIN, { type: 'meetingEnded', ended: ended(T0, T0 + 12 * MIN - 2000) });
    h.run(13 * MIN);
    expect(h.types).toEqual([
      `${10 * MIN}:ask:silence`,
      `${12 * MIN - 2000 + C}:cancel:replaced`,
      `${12 * MIN - 2000 + C}:ask:meeting_ended`,
    ]);
  });

  it('is pure', () => {
    const h = callEnding(29 * MIN);
    const before = structuredClone(h.state);
    autoStop(h.state, { type: 'tick' }, new Date(T0 + 50 * MIN));
    autoStop(h.state, { type: 'recording', recording: false }, new Date(T0 + 50 * MIN));
    autoStop(h.state, { type: 'apps', appIds: ['zoom'] }, new Date(T0 + 50 * MIN));
    expect(h.state).toEqual(before);
  });

  it('time never goes back (late input is applied at the last time seen)', () => {
    const h = callEnding(29 * MIN);
    h.at(29 * MIN, { type: 'tick' }); // earlier than the last input
    expect(h.state.now).toBe(T0 + 29 * MIN + C);
  });
});

describe('eventForCall', () => {
  const a = event('a', '2026-11-16T17:00:00Z', '2026-11-16T17:30:00Z');
  const b = event('b', '2026-11-16T17:15:00Z', '2026-11-16T17:45:00Z');
  const declined = event('d', '2026-11-16T17:00:00Z', '2026-11-16T17:40:00Z', { declined: true });
  const allDay = event('all', '2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z', { allDay: true });
  const call = { eventId: null, startedAt: T0 + 5 * MIN, endedAt: T0 + 40 * MIN };

  it('prefers the prompt’s event, then the recording’s, then the overlap ending closest', () => {
    const events = [a, b, declined, allDay];
    expect(eventForCall(events, { ...call, eventId: 'eventkit:a' }, 'eventkit:b')?.id).toBe(
      'eventkit:a',
    );
    expect(eventForCall(events, call, 'eventkit:a')?.id).toBe('eventkit:a');
    // Overlapping: a (ends 30) and b (ends 45); 40 is closer to 45. Declined / all-day never count.
    expect(eventForCall(events, call, null)?.id).toBe('eventkit:b');
    expect(eventForCall([declined, allDay], call, null)).toBeNull();
    // An id the calendar no longer has falls through to the overlap rule.
    expect(eventForCall(events, { ...call, eventId: 'eventkit:gone' }, null)?.id).toBe(
      'eventkit:b',
    );
  });
});

describe('AutoStopper', () => {
  it('ticks itself at the deadlines', () => {
    let now = T0;
    const timers: { fn: () => void; at: number }[] = [];
    const stopper = new AutoStopper({
      now: () => new Date(now),
      config: { floorMs: 1000, undoMs: 500, confirmMs: 0 },
      timers: {
        setTimeout: (fn, ms) => {
          const t = { fn, at: now + ms };
          timers.push(t);
          return t;
        },
        clearTimeout: (h) => {
          const i = timers.indexOf(h as (typeof timers)[number]);
          if (i >= 0) timers.splice(i, 1);
        },
      },
    });
    const seen: string[] = [];
    stopper.onAction((a) => seen.push(`${a.type}@${new Date(a.at).getTime() - T0}`));
    stopper.dispatch({ type: 'recording', recording: true });
    stopper.dispatch({ type: 'levels', mic: -10, system: -60 });
    stopper.dispatch({ type: 'calendar', events: [WEEKLY] });
    now = T0 + 200;
    stopper.dispatch({
      type: 'meetingEnded',
      ended: ended(T0, T0 + 100, { at: new Date(T0 + 200) }),
    });
    const fire = () => {
      timers.sort((x, y) => x.at - y.at);
      const t = timers.shift()!;
      now = t.at;
      t.fn();
    };
    fire(); // floor (1 s): the call ended 29 min before WEEKLY's end → ask
    expect(seen).toEqual(['ask@1000']);
    expect(timers).toHaveLength(0);
    stopper.dispose();
  });
});
