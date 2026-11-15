/**
 * `Detector`: the `detect` reducer driven by a `MicAppsSource` and a timer — the piece the desktop main
 * process wires to its notification UI (7.3), recording state and `CalendarCache`. All decisions are in
 * `detect`; this only feeds inputs, schedules `tick`s at `nextDeadline` and fans actions out.
 */
import type { CalendarEvent } from '@oat/core';

import type { MicAppProcess } from './apps.ts';
import {
  detect,
  initialDetectionState,
  nextDeadline,
  type DetectionAction,
  type DetectionConfig,
  type DetectionInput,
  type DetectionState,
} from './detect.ts';
import type { MicAppsSource, MicAppsWatch } from './source.ts';

export interface DetectorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DetectorOptions {
  source: MicAppsSource;
  config?: Partial<DetectionConfig>;
  /** Default `() => new Date()`. */
  now?: () => Date;
  /** Default the global timers. */
  timers?: DetectorTimers;
  events?: readonly CalendarEvent[];
  silenced?: readonly string[];
  recording?: boolean;
}

export class Detector {
  #state: DetectionState;
  readonly #source: MicAppsSource;
  readonly #now: () => Date;
  readonly #timers: DetectorTimers;
  #timer: unknown;
  #watch: MicAppsWatch | undefined;
  #running = false;
  readonly #actionListeners = new Set<(action: DetectionAction) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();

  constructor(options: DetectorOptions) {
    this.#source = options.source;
    this.#now = options.now ?? (() => new Date());
    this.#timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.#state = initialDetectionState({
      config: options.config,
      now: this.#now(),
      events: options.events,
      silenced: options.silenced,
      recording: options.recording,
    });
  }

  get state(): DetectionState {
    return this.#state;
  }

  onAction(listener: (action: DetectionAction) => void): () => void {
    this.#actionListeners.add(listener);
    return () => this.#actionListeners.delete(listener);
  }

  /** The mic-apps watch died on its own; call `start` again to resume. */
  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#watch = await this.#source.watch(
        (apps: MicAppProcess[]) => this.dispatch({ type: 'micApps', apps }),
        (error) => {
          this.#watch = undefined;
          for (const l of this.#errorListeners) l(error);
        },
      );
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    const watch = this.#watch;
    this.#watch = undefined;
    await watch?.stop();
  }

  setRecording(recording: boolean): void {
    this.dispatch({ type: 'recording', recording });
  }

  setEvents(events: readonly CalendarEvent[]): void {
    this.dispatch({ type: 'calendar', events });
  }

  setSilenced(appIds: readonly string[]): void {
    this.dispatch({ type: 'silenced', appIds });
  }

  promptClosed(promptId: string): void {
    this.dispatch({ type: 'promptClosed', promptId });
  }

  /** Applies one input now, emits the resulting actions and re-arms the timer. */
  dispatch(input: DetectionInput): void {
    const { state, actions } = detect(this.#state, input, this.#now());
    this.#state = state;
    this.#arm();
    for (const action of actions) for (const l of this.#actionListeners) l(action);
  }

  #arm(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    const at = nextDeadline(this.#state);
    if (at === null) return;
    const delay = Math.max(0, at - this.#now().getTime());
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.dispatch({ type: 'tick' });
    }, delay);
  }
}
