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
