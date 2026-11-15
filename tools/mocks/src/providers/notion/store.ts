/**
 * In-memory Notion workspace for the mock: pages, databases and blocks keyed by dashed UUID, plus the seed
 * content an integration "can see" after OAuth (shared pages and databases). Response shapes follow the
 * public API (version 2022-06-28): full rich-text objects with `plain_text`/`href`/annotations, `parent`
 * objects, `archived`/`in_trash`, `has_children`.
 */
import { randomUUID } from 'node:crypto';

import type { PropertyType } from './validate.ts';

export type Json = Record<string, unknown>;

export type Parent =
  | { type: 'workspace'; workspace: true }
  | { type: 'page_id'; page_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'block_id'; block_id: string };

export interface RichText {
  type: 'text';
  text: { content: string; link: { url: string } | null };
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  plain_text: string;
  href: string | null;
}

export interface PageRec {
  kind: 'page';
  id: string;
  parent: Parent;
  /** Response form: `{ [name]: { id, type, [type]: value } }`. */
  properties: Record<string, Json>;
  icon: Json | null;
  archived: boolean;
  created: string;
  edited: string;
  children: string[];
}

export interface PropertySchema {
  id: string;
  name: string;
  type: PropertyType;
  [key: string]: unknown;
}

export interface DatabaseRec {
  kind: 'database';
  id: string;
  parent: Parent;
  title: RichText[];
  properties: Record<string, PropertySchema>;
  icon: Json | null;
  archived: boolean;
  created: string;
  edited: string;
}

export interface BlockRec {
  kind: 'block';
  id: string;
  parent: Parent;
  type: string;
  /** The type's payload without `children` (rich text in full form). */
  data: Json;
  archived: boolean;
  created: string;
  edited: string;
  children: string[];
}

export type NotionObject = PageRec | DatabaseRec | BlockRec;

/** Fixed ids of the seeded workspace content (so tests and docs can name them). */
export const NOTION_MOCK_IDS = {
  workspace: '0b5e6a41-7f1d-4c55-9a2e-5f0c1d2e3a40',
  bot: '0b5e6a41-7f1d-4c55-9a2e-5f0c1d2e3a41',
  owner: '0b5e6a41-7f1d-4c55-9a2e-5f0c1d2e3a42',
  teamHome: '6f1c2a10-0000-4000-8000-000000000001',
  meetingNotes: '6f1c2a10-0000-4000-8000-000000000002',
  meetingsDb: '6f1c2a10-0000-4000-8000-000000000003',
  readingListDb: '6f1c2a10-0000-4000-8000-000000000004',
  scratchpad: '6f1c2a10-0000-4000-8000-000000000005',
} as const;

export const NOTION_MOCK_WORKSPACE = {
  id: NOTION_MOCK_IDS.workspace,
  name: 'Oat Mock Notion',
  icon: '🗂️',
} as const;

/** Dashed lower-case UUID for a Notion id given with or without dashes; `undefined` if malformed. */
export function normalizeId(raw: string): string | undefined {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function fullRichText(items: readonly unknown[]): RichText[] {
  return items.map((raw) => {
    const item = raw as {
      text: { content: string; link?: { url: string } | null };
      annotations?: Partial<RichText['annotations']>;
    };
    const link = item.text.link ?? null;
    return {
      type: 'text',
      text: { content: item.text.content, link: link ? { url: link.url } : null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
        ...item.annotations,
      },
      plain_text: item.text.content,
      href: link?.url ?? null,
    };
  });
}

export const plainText = (items: readonly RichText[] | undefined) =>
  (items ?? []).map((t) => t.plain_text).join('');

const text = (content: string) => fullRichText([{ text: { content } }]);

export interface Store {
  objects: Map<string, NotionObject>;
  /** Monotonic clock for `created_time`/`last_edited_time` (distinct, ordered timestamps). */
  stamp(): string;
}

export function createStore(now: () => number): Store {
  let last = 0;
  const stamp = () => {
    // Notion timestamps have minute precision in places; the mock keeps ms but never repeats one.
    last = Math.max(last + 1, now());
    return new Date(last).toISOString();
  };
  const store: Store = { objects: new Map(), stamp };
  seed(store);
  return store;
}

function page(store: Store, id: string, parent: Parent, title: string, icon?: string): PageRec {
  const t = store.stamp();
  const rec: PageRec = {
    kind: 'page',
    id,
    parent,
    properties: { title: { id: 'title', type: 'title', title: text(title) } },
    icon: icon ? { type: 'emoji', emoji: icon } : null,
    archived: false,
    created: t,
    edited: t,
    children: [],
  };
  store.objects.set(id, rec);
  return rec;
}

function database(
  store: Store,
  id: string,
  parent: Parent,
  title: string,
  properties: Array<[string, PropertyType, Json?]>,
  icon?: string,
): DatabaseRec {
  const t = store.stamp();
  const rec: DatabaseRec = {
    kind: 'database',
    id,
    parent,
    title: text(title),
    properties: Object.fromEntries(
      properties.map(([name, type, config], i) => [
        name,
        { id: type === 'title' ? 'title' : `p${i}`, name, type, [type]: config ?? {} },
      ]),
    ),
    icon: icon ? { type: 'emoji', emoji: icon } : null,
    archived: false,
    created: t,
    edited: t,
  };
  store.objects.set(id, rec);
  return rec;
}

function paragraph(store: Store, parent: PageRec, content: string): void {
  const t = store.stamp();
  const id = randomUUID();
  store.objects.set(id, {
    kind: 'block',
    id,
    parent: { type: 'page_id', page_id: parent.id },
    type: 'paragraph',
    data: { rich_text: text(content), color: 'default' },
    archived: false,
    created: t,
    edited: t,
    children: [],
  });
  parent.children.push(id);
}

/**
 * What the integration was given access to during OAuth: a team home page with a meeting-notes page and a
 * "Meetings" database (title, date, attendees, Oat link, tags), a reading-list database with only a title
 * column, and a private scratchpad page.
 */
function seed(store: Store): void {
  const ids = NOTION_MOCK_IDS;
  const workspace: Parent = { type: 'workspace', workspace: true };
  const home = page(store, ids.teamHome, workspace, 'Team Home', '🏠');
  paragraph(store, home, 'Everything the team shares lives here.');
  const notes = page(
    store,
    ids.meetingNotes,
    { type: 'page_id', page_id: home.id },
    'Meeting notes',
    '📝',
  );
  paragraph(store, notes, 'Notes sent from Oat land under this page.');
  database(
    store,
    ids.meetingsDb,
    { type: 'page_id', page_id: home.id },
    'Meetings',
    [
      ['Name', 'title'],
      ['Date', 'date'],
      ['Attendees', 'rich_text'],
      ['Oat link', 'url'],
      [
        'Tags',
        'multi_select',
        {
          options: [
            { id: 't1', name: 'customer', color: 'blue' },
            { id: 't2', name: 'internal', color: 'gray' },
          ],
        },
      ],
    ],
    '📅',
  );
  database(
    store,
    ids.readingListDb,
    workspace,
    'Reading list',
    [
      ['Title', 'title'],
      ['Author', 'rich_text'],
    ],
    '📚',
  );
  page(store, ids.scratchpad, workspace, 'Scratchpad', '✏️');
}

/** The title of a page (its `title`-typed property) or database. */
export function titleOf(obj: PageRec | DatabaseRec): string {
  if (obj.kind === 'database') return plainText(obj.title);
  const prop = Object.values(obj.properties).find((p) => p.type === 'title');
  return plainText(prop?.title as RichText[] | undefined);
}
