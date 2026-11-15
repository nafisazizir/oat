/**
 * `@oat/stt`: live speech-to-text behind one interface (`SttProvider` → `SttStream` per audio source), a
 * deterministic `FakeSttProvider` for tests and the `DeepgramProvider` streaming adapter (Node only; works
 * against the Deepgram-compatible mock in `tools/mocks` in dev and real Deepgram in prod).
 */
export * from './types.ts';
export { BaseSttStream } from './stream-base.ts';
export { uuidv7 } from './ids.ts';
export {
  FakeSttProvider,
  parseGroundTruth,
  wordsOf,
  type FakeSttOptions,
  type GroundTruthSegment,
} from './fake.ts';
export {
  DeepgramProvider,
  type DeepgramConnectContext,
  type DeepgramProviderOptions,
} from './deepgram.ts';
export {
  apiKeyToken,
  buildListenUrl,
  DEEPGRAM_API_URL,
  DEFAULT_MOCKS_URL,
  grantTokenSource,
  resolveDeepgramEndpoints,
  type DeepgramEndpoints,
  type DeepgramToken,
  type Env,
  type GetDeepgramToken,
  type GetTokenOptions,
  type GrantTokenSourceOptions,
  type ListenParams,
} from './deepgram-config.ts';
export {
  isDeepgramResults,
  mapDeepgramResults,
  type DeepgramResults,
  type DeepgramWord,
  type MapResultsContext,
  type MappedResults,
} from './deepgram-results.ts';
export {
  batchUrlFor,
  buildBatchUrl,
  mapBatchResponse,
  transcribeDeepgram,
  UTTERANCE_GAP_MS,
  type DeepgramBatchOptions,
} from './deepgram-batch.ts';
export { ReplayBuffer, SocketTimeline } from './replay.ts';
export { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts';
