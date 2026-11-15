import type { CalendarAccess, CalendarEvent } from '@oat/core';

export type Unsubscribe = () => void;

/** Half-open range `[from, to)`: events overlapping it are returned. */
export interface CalendarRange {
  from: Date;
  to: Date;
}

/** A running change subscription. */
export interface CalendarWatch {
  /** Stops watching; resolves once the underlying process/subscription is gone. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Where events come from — EventKit through the sidecar, a fixture, Google (7.4). Implementations are
 * stateless readers; `CalendarCache` adds the window, caching and change events on top.
 *
 * Contract: `status()` never prompts for permission. `fetchEvents` / `watch` reject with
 * `CalendarAccessError` when access is missing (they never prompt either).
 */
export interface CalendarSource {
  /** For logs, e.g. `eventkit`, `fixture`. */
  readonly name: string;
  status(): Promise<CalendarAccess>;
  /** Normalised events overlapping the range, sorted by start, end, id. */
  fetchEvents(range: CalendarRange): Promise<CalendarEvent[]>;
  /**
   * Calls `onChange` (debounced by the source) whenever events may have changed. `onError` reports a watch
   * that died on its own (it is then over; the caller decides whether to watch again).
   */
  watch(onChange: () => void, onError: (error: Error) => void): Promise<CalendarWatch>;
}

/** Calendar access is not granted (`status` says why); nothing prompted. */
export class CalendarAccessError extends Error {
  override readonly name = 'CalendarAccessError';
}
