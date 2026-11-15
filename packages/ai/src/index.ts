/**
 * Prompts, templates, tools and model config (Vercel AI SDK). Every AI call gets its model from here:
 * `getModel(role)` / `getEmbeddingModel()` pick AI Gateway or the mock LLM from the environment.
 * Test doubles live in `@oat/ai/testing`.
 */
export {
  AI_ROLES,
  type AiEnv,
  type AiRole,
  DEFAULT_MODELS,
  EMBEDDING_DIMENSIONS,
  isAiRole,
  type LanguageRole,
  modelEnvVar,
  resolveModelId,
  resolveModels,
} from './models.ts';
export {
  type AiBackend,
  type AiClient,
  AiConfigError,
  createAi,
  type CreateAiOptions,
  DEFAULT_AI_BASE_URL,
  getAi,
  getEmbeddingModel,
  getModel,
  resolveAiBackend,
} from './provider.ts';
export {
  BLOCK_KINDS,
  BLOCK_ORIGINS,
  type BlockKind,
  type BlockOrigin,
  buildEnhancePrompt,
  type EnhanceBlock,
  type EnhanceFn,
  type EnhanceInput,
  enhanceNotes,
  type EnhanceOptions,
  type EnhanceOutput,
  enhanceOutputSchema,
  type EnhanceSection,
  type EnhanceSegment,
  type EnhanceTemplate,
  formatTranscript,
  type MeetingMeta,
} from './enhance.ts';
