/**
 * Meeting metadata on the Notion side. A page parent only takes a `title` property, so date, attendees and the
 * Oat link go into a short line at the top of the page body. A database parent gets them as properties when
 * it has suitable columns (we never change the database's schema): the title column, a `date` column, a
 * `rich_text` column for attendees (plain text: Notion `people` need Notion user ids) and a `url` column for
 * the link; whatever has no column still goes into the body line.
 */
import { plainRichText } from './convert.ts';
import {
  type NotionBlock,
  notionBlock,
  type NotionDatabase,
  type NotionDatabaseProperty,
  type NotionRichText,
} from './types.ts';

export interface NoteMeta {
  title: string;
  /** Meeting start, else the note's creation time. */
  date: Date | null;
  attendees: readonly string[];
  /** Absolute link back to the note in Oat. */
  oatUrl: string;
}

export interface MetaOptions {
  /** IANA zone for the date in the body line (the sender's). Default UTC. */
  timeZone?: string;
}

export type PropertyValues = Record<string, unknown>;

export interface BuiltProperties {
  properties: PropertyValues;
  /** Fields set as database properties (the rest go into the body line). */
  covered: { date: boolean; attendees: boolean; link: boolean };
}

const UNTITLED = 'Untitled';

const titleText = (title: string) => plainRichText(title.trim() || UNTITLED);

/** The property of `type` whose name best matches `pattern` (else the first of that type). */
function pick(
  properties: Record<string, NotionDatabaseProperty>,
  type: string,
  pattern?: RegExp,
): NotionDatabaseProperty | undefined {
  const candidates = Object.values(properties).filter((p) => p.type === type);
  return (
    (pattern && candidates.find((p) => pattern.test(p.name))) ??
    (pattern ? undefined : candidates[0])
  );
}

/**
 * Page properties for a note. `database` = the parent database's schema (omit for a page parent).
 */
export function buildProperties(
  meta: NoteMeta,
  database?: Pick<NotionDatabase, 'properties'>,
): BuiltProperties {
  if (!database) {
    return {
      properties: { title: { title: titleText(meta.title) } },
      covered: { date: false, attendees: false, link: false },
    };
  }
  const props = database.properties;
  const properties: PropertyValues = {};
  const title = pick(props, 'title');
  if (title) properties[title.name] = { title: titleText(meta.title) };

  const date = pick(props, 'date', /date|when|time|day/i) ?? pick(props, 'date');
  if (date && meta.date) properties[date.name] = { date: { start: meta.date.toISOString() } };

  const attendees = pick(props, 'rich_text', /attendee|participant|people|who|guest/i);
  if (attendees && meta.attendees.length > 0) {
    properties[attendees.name] = { rich_text: plainRichText(meta.attendees.join(', ')) };
  }

  // Only a column that is clearly for a link back (never e.g. "Recording").
  const link = pick(props, 'url', /oat|link|url|source|note/i);
  if (link) properties[link.name] = { url: meta.oatUrl };

  return {
    properties,
    covered: {
      date: !!date && !!meta.date,
      attendees: !!attendees && meta.attendees.length > 0,
      link: !!link,
    },
  };
}

function formatDate(date: Date, timeZone: string | undefined): string {
  let zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const formatted = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(date);
  return zone === 'UTC' ? `${formatted} UTC` : formatted;
}

/**
 * The metadata line for the top of the page body (date · attendees · "Open in Oat"), followed by a divider.
 * Empty when everything is already a database property.
 */
export function metaBlocks(
  meta: NoteMeta,
  covered: BuiltProperties['covered'],
  options: MetaOptions = {},
): NotionBlock[] {
  const parts: NotionRichText[][] = [];
  if (!covered.date && meta.date)
    parts.push(plainRichText(formatDate(meta.date, options.timeZone)));
  if (!covered.attendees && meta.attendees.length > 0) {
    parts.push(plainRichText(`Attendees: ${meta.attendees.join(', ')}`));
  }
  if (!covered.link) {
    parts.push([{ type: 'text', text: { content: 'Open in Oat', link: { url: meta.oatUrl } } }]);
  }
  if (parts.length === 0) return [];
  const richText = parts.flatMap((part, i) =>
    i === 0 ? part : [{ type: 'text', text: { content: ' · ' } } as NotionRichText, ...part],
  );
  const styled = richText.map((item) => ({ ...item, annotations: { color: 'gray' as const } }));
  return [notionBlock('paragraph', { rich_text: styled }), notionBlock('divider', {})];
}
