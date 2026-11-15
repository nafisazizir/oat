/**
 * `@oat/detection` (task 7.2, D-21): notice when a call starts. Meeting-app allowlist + helper map (`apps.ts`),
 * the pure `detect` reducer with every rule (`detect.ts`), `Detector` (reducer + source + timer), the
 * `MicAppsSource` interface with an in-memory fixture source, and fixture timelines (`timeline.ts`).
 * Platform-neutral; the sidecar-backed source lives in `@oat/detection/node`.
 */
export {
  HELPER_PARENTS,
  HELPER_PREFIXES,
  MEETING_APPS,
  MESSAGING_MIN_HOLD_MS,
  meetingAppById,
  meetingAppForBundleId,
  MicAppProcessSchema,
  resolveMeetingApp,
  type MeetingApp,
  type MeetingAppKind,
  type MeetingNoun,
  type MicAppProcess,
  type MicAppProcessInput,
} from './apps.ts';
export {
  CLOCK_JUMP_MS,
  DEFAULT_DETECTION_CONFIG,
  detect,
  initialDetectionState,
  nextDeadline,
  promptTitle,
  rebaseClock,
  type ActivePrompt,
  type AppPresence,
  type DetectionAction,
  type DetectionConfig,
  type DetectionInput,
  type DetectionResult,
  type DetectionState,
  type DismissReason,
  type MeetingSpan,
} from './detect.ts';
export { Detector, type DetectorOptions, type DetectorTimers } from './detector.ts';
export {
  FixtureMicAppsSource,
  parseApps,
  type MicAppsSource,
  type MicAppsWatch,
} from './source.ts';
export {
  compactAction,
  DetectionTimelineSchema,
  runTimeline,
  timelineEvent,
  type DetectionTimeline,
  type ExpectedAction,
  type TimelineEvent,
  type TimelineRun,
} from './timeline.ts';
