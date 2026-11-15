/**
 * @oat/integrations-notion — send Oat notes to Notion (8.1). Server-side (fetch + zod; no Notion SDK):
 * TipTap JSON → Notion blocks (`convert.ts`), meeting properties (`properties.ts`), the API/OAuth client
 * (`client.ts`), push / re-push (`push.ts`) and env config (`config.ts`).
 */
export {
  exchangeNotionCode,
  type FetchLike,
  NotionApiError,
  NotionAuthError,
  notionAuthorizeUrl,
  NotionClient,
  type NotionClientOptions,
  NotionOAuthError,
  NotionTokenResponse,
  type OAuthClientConfig,
  revokeNotionToken,
  type SearchParams,
} from './client.ts';
export { isRealNotion, NOTION_API_URL, type NotionConfig, resolveNotionConfig } from './config.ts';
export {
  batchBlocks,
  CALLOUT_COLORS,
  type ConvertOptions,
  countBlocks,
  notionLanguage,
  notionLink,
  plainRichText,
  splitText,
  toNotionBlocks,
  toRichText,
} from './convert.ts';
export {
  type BuiltProperties,
  buildProperties,
  type MetaOptions,
  metaBlocks,
  type NoteMeta,
} from './properties.ts';
export {
  NotionTargetMissingError,
  type PushInput,
  pushNote,
  type PushResult,
  type PushState,
} from './push.ts';
export {
  blockData,
  type NotionBlock,
  type NotionBlockType,
  type NotionDatabase,
  type NotionPage,
  type NotionRichText,
  type NotionTarget,
  notionTitle,
  NOTION_LIMITS,
  NOTION_VERSION,
} from './types.ts';
