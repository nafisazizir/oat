/** Local stand-ins for third-party APIs. See docs/DEV.md "How mocks work". */
export { createApp, type CreateAppOptions, type MocksApp } from './app.ts';
export type { MockProvider, MockProviderFactory, MockWebSocketRoute } from './provider.ts';
export { DEFAULT_EMBEDDING_DIMENSIONS, hashEmbedding } from './providers/llm/embedding.ts';
export { llmProvider, MOCK_LLM_MODELS } from './providers/llm/index.ts';
export { RequestLog, type LoggedRequest } from './request-log.ts';
export { startMocks, type RunningMocks, type StartMocksOptions } from './server.ts';
