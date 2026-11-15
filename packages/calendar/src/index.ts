/**
 * `@oat/calendar`: the `CalendarSource` interface, `CalendarCache` (window, change events) and
 * `FixtureCalendarSource`. Platform-neutral; the sidecar-backed source lives in `@oat/calendar/node`.
 * Event shape and pure helpers (`currentMeetingFor`, `upcoming`, `startingSoon`, …) are in `@oat/core`.
 */
export { CalendarCache, type CalendarCacheOptions } from './cache.ts';
export {
  filterRange,
  FixtureCalendarSource,
  parseEventLines,
  parseEvents,
  type FixtureCalendarSourceOptions,
} from './fixture-source.ts';
export {
  CalendarAccessError,
  type CalendarRange,
  type CalendarSource,
  type CalendarWatch,
  type Unsubscribe,
} from './types.ts';
