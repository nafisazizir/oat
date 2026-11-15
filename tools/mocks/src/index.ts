/** Local stand-ins for third-party APIs. See docs/DEV.md "How mocks work". */
export { createApp, type CreateAppOptions, type MocksApp } from './app.ts';
export type {
  MockProvider,
  MockProviderFactory,
  MockUpgradeRejection,
  MockWebSocketRoute,
} from './provider.ts';
export {
  type CalendarFixture,
  fixtureAnchor,
  googleDataFromFixture,
} from './providers/gcal/fixture.ts';
export { GCAL_SCOPES, gcalProvider, type GcalProviderOptions } from './providers/gcal/index.ts';
export type * as GoogleCalendarApi from './providers/gcal/types.ts';
export { DEFAULT_EMBEDDING_DIMENSIONS, hashEmbedding } from './providers/llm/embedding.ts';
export { llmProvider, MOCK_LLM_MODELS } from './providers/llm/index.ts';
export {
  NOTION_API_VERSION,
  NOTION_MOCK_IDS,
  NOTION_MOCK_TOKEN_PREFIX,
  NOTION_MOCK_WORKSPACE,
  notionProvider,
  type NotionProviderOptions,
} from './providers/notion/index.ts';
export { RequestLog, type LoggedRequest } from './request-log.ts';
export { startMocks, type RunningMocks, type StartMocksOptions } from './server.ts';
