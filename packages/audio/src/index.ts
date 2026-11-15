/**
 * `@oat/audio`: the `AudioSource` abstraction shared by live capture (sidecar, task 2.4) and file replay,
 * plus WAV, resampling and level utilities. Importing this module has no Node-only side effects; only
 * `FileSource` with a path input touches `node:fs` (lazily).
 */
export * from './types.ts';
export {
  Fanout,
  framesOf,
  logListenerError,
  type FramesOfOptions,
  type ListenerErrorHandler,
} from './emitter.ts';
export {
  FileSource,
  type FileSourceInput,
  type FileSourceOptions,
  type FileSourceSpeed,
  type WavInput,
} from './file-source.ts';
export { LevelMeter, measureLevel, SILENCE_DB, toDbfs, type Level } from './level.ts';
export { downmixToMono, resampleInt16 } from './resample.ts';
export {
  decodeWav,
  encodeWav,
  floatToInt16,
  WavError,
  wavDurationMs,
  type DecodedWav,
  type WavAudio,
} from './wav.ts';
