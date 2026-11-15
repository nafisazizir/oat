/**
 * `@oat/calendar/node`: Node-only parts (child processes) for the Electron main process and tests. Never import
 * this from renderer code. Re-exports everything from `@oat/calendar`.
 */
export * from './index.ts';
export {
  EXIT_NO_ACCESS,
  SidecarCalendarSource,
  type SidecarCalendarSourceOptions,
} from './sidecar-source.ts';
