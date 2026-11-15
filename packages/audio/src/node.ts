/**
 * `@oat/audio/node`: Node-only parts (child processes, filesystem) for the Electron main process and tests.
 * Never import this from renderer code. Re-exports everything from `@oat/audio` for convenience.
 */
export * from './index.ts';
export {
  captureArgs,
  DEV_SIDECAR_PATH,
  locateSidecarBinary,
  readSidecarVersion,
  SidecarError,
  SidecarSource,
  type LocateOptions,
  type RestartPolicy,
  type SidecarBinary,
  type SidecarSourceOptions,
} from './sidecar-source.ts';
export {
  decodePcm,
  encodeFrame,
  FrameParser,
  HEADER_SIZE,
  KIND,
  ProtocolError,
  SIDECAR_PROTOCOL,
  SOURCE,
  toAudioEvent,
  toAudioFrame,
  validateFrames,
  type RawFrame,
  type ValidateOptions,
  type ValidationResult,
} from './sidecar-protocol.ts';
export {
  ARCHIVE_BITRATE,
  ARCHIVE_FRAME_MS,
  ARCHIVE_FSYNC_MS,
  ARCHIVE_PAGE_MS,
  OpusArchiveWriter,
  type ArchiveFile,
  type OpusArchiveStats,
  type OpusArchiveWriterOptions,
} from './opus-archive.ts';
export {
  decodeOggOpus,
  inspectOggOpus,
  OPUS_PREROLL_MS,
  opusSeekOffset,
  opusSeekPage,
  probeOpusFile,
  readOpusRange,
  type OggOpusStream,
  type OpusRange,
  type OpusRangeOptions,
} from './opus-reader.ts';
export {
  recoverRecordings,
  repairOpusFile,
  type OpusRepairResult,
  type RecoveredRecording,
  type RecoverRecordingsOptions,
} from './archive-recovery.ts';
export {
  ArchiveError,
  audioArchivePath,
  defaultOatDataDir,
  RecordingArchive,
  type ArchiveErrorCode,
  type ArchiveWriterTuning,
  type RecordingArchiveOptions,
} from './recording-archive.ts';
export {
  meetingSeek,
  readMeetingRange,
  type MeetingRange,
  type MeetingRangeOptions,
  type MeetingSeek,
} from './meeting-audio.ts';
