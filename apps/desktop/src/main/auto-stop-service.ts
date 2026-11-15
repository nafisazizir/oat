/**
 * Auto-stop (task 7.5) in the desktop main process: `@oat/detection`'s `AutoStopper` (the pure rules + a timer)
 * fed with what main knows, and its decisions turned into UI and a stop.
 *
 * In: the recording's state and levels (`RecordingService` snapshots), detection's `meetingEnded` and whether a
 * call is open (`DetectionService`), the calendar, the note's own calendar event, and the settings
 * (`<userData>/auto-stop.json`, per Mac: "Stop recording automatically when the meeting ends", on by default;
 * "also in-person recordings", off).
 * Out: one notice at a time on `autostop:changed` — the "Stopping… Keep recording" toast or the "Meeting over?"
 * question — mirrored as a native notification (the window may be hidden during a call), and the stop itself.
 * The stop is an ordinary `recording.stop()`: the grace period and the post-meeting pipeline follow from it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import type { CalendarEvent } from '@oat/core';
import {
  type AutoStopNoticeSnapshot,
  type AutoStopSettingsSnapshot,
  autoStopSettingsSchema,
  type RecordingSnapshot,
} from '@oat/core/bridge';
import {
  type AutoStopAction,
  type AutoStopConfig,
  AutoStopper,
  DEFAULT_AUTO_STOP_SETTINGS,
  type DetectorTimers,
  type MeetingEndedAction,
} from '@oat/detection';

import type { NotifyRequest, ShownNotification } from './detection-service.ts';
import type { Logger } from './ipc.ts';

export interface AutoStopServiceOptions {
  /** `<userData>/auto-stop.json`. */
  settingsFile: string;
  /** Rule timings (dev/e2e override; production uses the defaults). */
  config?: Partial<AutoStopConfig>;
  /** Stops the recording. */
  stop: () => Promise<unknown>;
  /** The calendar event id of the meeting's note (made from an event, 7.3), if the calendar still has it. */
  eventOf: (meetingId: string) => string | null;
  notify: (request: NotifyRequest) => ShownNotification | null;
  onNotice: (notice: AutoStopNoticeSnapshot | null) => void;
  /** A notification was clicked: show the window. */
  onOpen?: () => void;
  now?: () => Date;
  timers?: DetectorTimers;
  log?: Logger;
}

export class AutoStopServiceError extends Error {
  override name = 'AutoStopServiceError';
}

type Level = RecordingSnapshot['levels']['mic'];

export class AutoStopService {
  readonly #o: AutoStopServiceOptions;
  readonly #stopper: AutoStopper;
  #settings: AutoStopSettingsSnapshot;
  #notice: AutoStopNoticeSnapshot | null = null;
  #notification: ShownNotification | null = null;
  #recording: { meetingId: string | null; paused: boolean } | null = null;
  #loud: string | null = null;

  constructor(options: AutoStopServiceOptions) {
    this.#o = options;
    this.#settings = this.#readSettings();
    this.#stopper = new AutoStopper({
      settings: this.#settings,
      ...(options.config ? { config: options.config } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.timers ? { timers: options.timers } : {}),
    });
    this.#stopper.onAction((action) => this.#onAction(action));
  }

  get settings(): AutoStopSettingsSnapshot {
    return this.#settings;
  }

  get notice(): AutoStopNoticeSnapshot | null {
    return this.#notice;
  }

  setSettings(patch: Partial<AutoStopSettingsSnapshot>): AutoStopSettingsSnapshot {
    this.#settings = { ...this.#settings, ...patch };
    try {
      writeFileSync(this.#o.settingsFile, `${JSON.stringify(this.#settings)}\n`);
    } catch (error) {
      this.#o.log?.warn(`auto-stop: couldn't save the settings: ${String(error)}`);
    }
    this.#stopper.dispatch({ type: 'settings', settings: this.#settings });
    return this.#settings;
  }

  /** Every recording snapshot: start/stop, pause, levels. */
  recordingState(snapshot: Pick<RecordingSnapshot, 'status' | 'meetingId' | 'levels'>): void {
    const active = snapshot.status === 'recording' || snapshot.status === 'paused';
    const was = this.#recording;
    if (!active) {
      if (was) {
        this.#recording = null;
        this.#loud = null;
        this.#stopper.dispatch({ type: 'recording', recording: false });
      }
      return;
    }
    if (!was || was.meetingId !== snapshot.meetingId) {
      if (was) this.#stopper.dispatch({ type: 'recording', recording: false });
      const meetingId = snapshot.meetingId;
      this.#recording = { meetingId, paused: false };
      this.#loud = null;
      this.#stopper.dispatch({
        type: 'recording',
        recording: true,
        eventId: meetingId ? this.#o.eventOf(meetingId) : null,
      });
    }
    const paused = snapshot.status === 'paused';
    if (this.#recording!.paused !== paused) {
      this.#recording = { ...this.#recording!, paused };
      this.#loud = null;
      this.#stopper.dispatch({ type: 'paused', paused });
    }
    if (paused) return;
    // Only quiet ↔ loud and "the other side is talking" changes matter to the rules: no dispatch for every
    // meter update.
    const db = (l: Level) => l?.rmsDb ?? null;
    const mic = db(snapshot.levels.mic);
    const system = db(snapshot.levels.system);
    const { silenceDb, speechDb } = this.#stopper.state.config;
    const loud = Math.max(mic ?? -Infinity, system ?? -Infinity) > silenceDb;
    const talking = (system ?? -Infinity) > speechDb;
    const key = `${loud}/${talking}`;
    if (key === this.#loud) return;
    this.#loud = key;
    this.#stopper.dispatch({ type: 'levels', mic, system });
  }

  meetingEnded(action: MeetingEndedAction): void {
    this.#stopper.dispatch({ type: 'meetingEnded', ended: action });
  }

  appsChanged(appIds: readonly string[]): void {
    this.#stopper.dispatch({ type: 'apps', appIds });
  }

  callChanged(open: boolean): void {
    this.#stopper.dispatch({ type: 'call', open });
  }

  setEvents(events: readonly CalendarEvent[]): void {
    this.#stopper.dispatch({ type: 'calendar', events });
  }

  /** "Keep recording" / "Keep going" (`keep`) or "Stop recording" (`stop`). */
  async respond(id: string, action: 'keep' | 'stop'): Promise<void> {
    if (this.#notice?.id !== id) {
      throw new AutoStopServiceError('That message is no longer on screen.');
    }
    if (action === 'keep') {
      this.#stopper.dispatch({ type: 'keep', id });
      return;
    }
    this.#stopper.dispatch({ type: 'answered', id });
    this.#clear(id);
    await this.#o.stop();
  }

  dispose(): void {
    this.#stopper.dispose();
    this.#clear(this.#notice?.id ?? '');
  }

  // --- internals -------------------------------------------------------------------------------------------

  #onAction(action: AutoStopAction): void {
    switch (action.type) {
      case 'stopping':
      case 'ask':
        this.#show({
          id: action.id,
          kind: action.type,
          reason: action.reason,
          at: action.at.getTime(),
          stopAt: action.type === 'stopping' ? action.stopAt.getTime() : null,
        });
        break;
      case 'stop':
        this.#clear(action.id);
        this.#o.log?.info(`auto-stop: stopping the recording (${action.reason})`);
        void this.#o.stop().catch((error: unknown) => {
          this.#o.log?.warn(`auto-stop: stop failed: ${String(error)}`);
        });
        break;
      case 'cancel':
        this.#clear(action.id);
        break;
    }
  }

  #show(notice: AutoStopNoticeSnapshot): void {
    this.#notification?.close();
    this.#notification = null;
    this.#notice = notice;
    this.#o.onNotice(notice);
    const silence = notice.reason === 'silence';
    const request: NotifyRequest =
      notice.kind === 'stopping'
        ? {
            title: 'Stopping the recording',
            body: silence
              ? 'Nothing has been heard for a while. Open Oat to keep recording.'
              : 'Your meeting ended. Open Oat to keep recording.',
            onClick: () => this.#o.onOpen?.(),
          }
        : {
            title: 'Meeting over?',
            body: silence
              ? 'Oat hasn’t heard anything for a while and is still recording.'
              : 'The call ended and Oat is still recording.',
            onClick: () => this.#o.onOpen?.(),
          };
    try {
      this.#notification = this.#o.notify(request);
    } catch (error) {
      this.#o.log?.warn(`auto-stop: notification failed: ${String(error)}`);
    }
  }

  #clear(id: string): void {
    if (!this.#notice || this.#notice.id !== id) return;
    this.#notification?.close();
    this.#notification = null;
    this.#notice = null;
    this.#o.onNotice(null);
  }

  #readSettings(): AutoStopSettingsSnapshot {
    try {
      return autoStopSettingsSchema.parse({
        ...DEFAULT_AUTO_STOP_SETTINGS,
        ...(JSON.parse(readFileSync(this.#o.settingsFile, 'utf8')) as object),
      });
    } catch {
      return { ...DEFAULT_AUTO_STOP_SETTINGS };
    }
  }
}
