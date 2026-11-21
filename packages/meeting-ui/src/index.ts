/**
 * @oat/meeting-ui — the meeting note view's pieces shared by desktop (live) and web (synced). Import
 * `@oat/meeting-ui/styles.css` after `@oat/ui/styles.css` in the app's Tailwind entry.
 */
export {
  activeSegmentAt,
  clampWidth,
  compareTranscriptItems,
  formatClock,
  formatDuration,
  initials,
  isNearBottom,
  isPlausibleEmail,
  meetingWhen,
  mergeTranscripts,
  type MeetingWhen,
  type Participant,
  shortWhen,
  speakerOf,
  startsGroup,
  type TranscriptItem,
} from './format.ts';
export { MeetingTime } from './meeting-time.tsx';
export { groupNotesByDate } from './note-groups.ts';
export { usePanelEscape } from './panel-escape.ts';
export { TranscriptToggle } from './transcript-toggle.tsx';
export { PlaybackBar, playerKey, type MeetingPlayback } from './playback-bar.tsx';
export {
  PlaybackClock,
  type PlaybackInfo,
  type PlaybackPart,
  type PlaybackSource,
} from './playback.ts';
export { NoteColumn, TRANSCRIPT_PANEL_SIZE } from './note-column.tsx';
export {
  MAX_PARTICIPANT_NAME,
  ParticipantChips,
  ParticipantSummary,
  type ParticipantChipsProps,
} from './participants.tsx';
export { SidePanel, type SidePanelProps, useStoredState } from './side-panel.tsx';
export { TranscriptList, type TranscriptListProps } from './transcript-list.tsx';
