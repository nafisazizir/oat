/**
 * `AutoStopper`: the `autoStop` reducer (7.5) with a timer, like `Detector` for `detect`. The desktop main
 * process feeds it the recording's state and levels, detection's `meetingEnded` / call span, the calendar and
 * the settings, and acts on its actions (toast, question, stop). All decisions are in `autoStop`.
 */
import {
  autoStop,
  type AutoStopAction,
  type AutoStopConfig,
  type AutoStopInput,
  type AutoStopSettings,
  type AutoStopState,
  initialAutoStopState,
  nextAutoStopDeadline,
} from './auto-stop.ts';
import type { DetectorTimers } from './detector.ts';

export interface AutoStopperOptions {
  config?: Partial<AutoStopConfig>;
  settings?: Partial<AutoStopSettings>;
  now?: () => Date;
  timers?: DetectorTimers;
}

export class AutoStopper {
  #state: AutoStopState;
  readonly #now: () => Date;
  readonly #timers: DetectorTimers;
  #timer: unknown;
  readonly #listeners = new Set<(action: AutoStopAction) => void>();

  constructor(options: AutoStopperOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.#state = initialAutoStopState({
      now: this.#now(),
      ...(options.config ? { config: options.config } : {}),
      ...(options.settings ? { settings: options.settings } : {}),
    });
  }

  get state(): AutoStopState {
    return this.#state;
  }

  onAction(listener: (action: AutoStopAction) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Applies one input now, emits the resulting actions and re-arms the timer. */
  dispatch(input: AutoStopInput): void {
    const { state, actions } = autoStop(this.#state, input, this.#now());
    this.#state = state;
    this.#arm();
    for (const action of actions) for (const l of this.#listeners) l(action);
  }

  dispose(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
  }

  #arm(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    const at = nextAutoStopDeadline(this.#state);
    if (at === null) return;
    const delay = Math.max(0, at - this.#now().getTime());
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.dispatch({ type: 'tick' });
    }, delay);
  }
}
