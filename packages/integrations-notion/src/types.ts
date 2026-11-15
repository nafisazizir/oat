/**
 * The subset of Notion's public API shapes (version 2022-06-28) Oat writes and reads. Request shapes are
 * what the converter produces; response shapes are parsed loosely (only the fields we use).
 */

/** The API version every request sends (`Notion-Version`). */
export const NOTION_VERSION = '2022-06-28';

/** Notion's documented request limits. */
export const NOTION_LIMITS = {
  /** Characters per rich-text `text.content` (and per link URL). */
  textContent: 2000,
  /** Rich-text objects per array. */
  richTextItems: 100,
  /** Blocks per `children` array (create page / append). */
  children: 100,
  /** Levels of nesting below a request's top-level blocks. */
  nesting: 2,
  /** Block elements (nested included) per request. */
  blocksPerRequest: 1000,
  /** Request payload; we stay well under Notion's 500 KB. */
  payloadChars: 400_000,
} as const;

export type NotionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'gray_background'
  | 'brown_background'
  | 'orange_background'
  | 'yellow_background'
  | 'green_background'
  | 'blue_background'
  | 'purple_background'
  | 'pink_background'
  | 'red_background';

export interface NotionAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: NotionColor;
}

export interface NotionRichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: NotionAnnotations;
}

export type NotionBlockType =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'to_do'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider';

/** The payload under a block's type key. */
export interface NotionBlockData {
  rich_text?: NotionRichText[];
  color?: NotionColor;
  children?: NotionBlock[];
  checked?: boolean;
  language?: string;
  icon?: { type: 'emoji'; emoji: string };
}

/** A block as sent to Notion: `{ object: 'block', type, [type]: data }`. */
export type NotionBlock = { object: 'block'; type: NotionBlockType } & {
  [K in NotionBlockType]?: NotionBlockData;
};

export function notionBlock(type: NotionBlockType, data: NotionBlockData): NotionBlock {
  return { object: 'block', type, [type]: data } as NotionBlock;
}

/** The data of a block (its type key). */
export function blockData(block: NotionBlock): NotionBlockData {
  return block[block.type] ?? {};
}

export type NotionParent =
  | { type: 'workspace'; workspace: true }
  | { type: 'page_id'; page_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'block_id'; block_id: string };

export interface NotionRichTextResponse {
  plain_text: string;
}

export interface NotionPage {
  object: 'page';
  id: string;
  url: string;
  parent: NotionParent;
  archived?: boolean;
  in_trash?: boolean;
  icon?: { type: string; emoji?: string } | null;
  last_edited_time: string;
  properties: Record<string, { id: string; type: string; title?: NotionRichTextResponse[] }>;
}

export interface NotionDatabaseProperty {
  id: string;
  name: string;
  type: string;
}

export interface NotionDatabase {
  object: 'database';
  id: string;
  url: string;
  parent: NotionParent;
  archived?: boolean;
  in_trash?: boolean;
  icon?: { type: string; emoji?: string } | null;
  last_edited_time: string;
  title: NotionRichTextResponse[];
  properties: Record<string, NotionDatabaseProperty>;
}

export interface NotionBlockResponse {
  object: 'block';
  id: string;
  type: string;
  has_children: boolean;
  archived?: boolean;
}

export interface NotionList<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Where notes go: a page (new notes become sub-pages) or a database (new notes become rows). */
export interface NotionTarget {
  type: 'page' | 'database';
  id: string;
}

/** Plain title of a page or database. */
export function notionTitle(obj: NotionPage | NotionDatabase): string {
  if (obj.object === 'database') return obj.title.map((t) => t.plain_text).join('');
  const prop = Object.values(obj.properties).find((p) => p.type === 'title');
  return (prop?.title ?? []).map((t) => t.plain_text).join('');
}
