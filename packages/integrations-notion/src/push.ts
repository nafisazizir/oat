/**
 * Send a note to Notion (create) or send it again (update the same Notion page).
 *
 * Oat only ever removes what it wrote: the caller keeps the ids of the top-level blocks Oat put on the page
 * (`ownedBlockIds`, reported through `checkpoint`) and a re-push archives only those. Blocks the user added in
 * Notion (their own paragraphs, sub-pages = `child_page`, inline databases = `child_database`) stay; a
 * `child_page`/`child_database` block is never archived, even if its id were listed.
 *
 * Create: properties for the target (page parent → title only; database parent → matching columns, see
 * `properties.ts`), `POST /pages` without content, `checkpoint` (the caller stores the page id), then the content
 * appended in batches, with a `checkpoint` before and after each (so the written ids are stored as they land).
 *
 * Update (`existingPageId`): if Notion no longer has the page (404) or it is archived/in the trash, a new page is
 * created in the current target. Otherwise the page's properties are updated (against its *own* parent, which may
 * differ from the current target), the new content appended, then the owned old blocks archived (`DELETE
 * /blocks/{id}`, a few at a time). New before old: a failure leaves duplicates (still owned, so the next push
 * removes them), never an empty page.
 *
 * `checkpoint` is the caller's fence (e.g. renewing a lease): if it throws, the push stops; blocks appended by the
 * batch just before are archived again (best effort) so a push that lost its lease leaves nothing behind.
 */
import type { JSONContent } from '@oat/editor';

import { type NotionClient, NotionApiError } from './client.ts';
import { batchBlocks, toNotionBlocks } from './convert.ts';
import { buildProperties, type MetaOptions, metaBlocks, type NoteMeta } from './properties.ts';
import type { NotionBlockResponse, NotionDatabase, NotionPage, NotionTarget } from './types.ts';

/** What a push has written so far: the page and the top-level block ids Oat owns on it. */
export interface PushState {
  page: NotionPage;
  blockIds: string[];
}

export interface PushInput extends MetaOptions {
  client: NotionClient;
  target: NotionTarget;
  /** Notion page id of an earlier push of this note. */
  existingPageId?: string | null;
  /**
   * Top-level block ids an earlier push wrote on that page. `null`/omitted = unknown (rows from before
   * tracking): then every top-level block except sub-pages and databases is treated as Oat's.
   */
  ownedBlockIds?: readonly string[] | null;
  doc: JSONContent;
  meta: NoteMeta;
  /** Origin for relative links in the note. */
  baseUrl?: string;
  /** Called after the page exists and before/after every write; throw to stop the push. */
  checkpoint?: (state: PushState) => Promise<void> | void;
  /** Parallel `DELETE /blocks` calls when replacing content. Default 3 (Notion's average rate). */
  deleteConcurrency?: number;
}

export interface PushResult {
  pageId: string;
  url: string;
  /** `true` when a new Notion page was created (first push, or the old page was gone). */
  created: boolean;
  /** Top-level blocks written. */
  blocks: number;
  /** Their ids (store them for the next push). */
  blockIds: string[];
}

/** Creating in the chosen target failed because Notion doesn't have it (or no longer shares it). */
export class NotionTargetMissingError extends NotionApiError {
  override name = 'NotionTargetMissingError';
}

/** Block types that are pages/databases in their own right: never archived by a re-push. */
const NEVER_ARCHIVE = new Set(['child_page', 'child_database']);

async function existingPage(client: NotionClient, id: string): Promise<NotionPage | undefined> {
  try {
    const page = await client.retrievePage(id);
    return page.archived || page.in_trash ? undefined : page;
  } catch (error) {
    if (error instanceof NotionApiError && error.isNotFound()) return undefined;
    throw error;
  }
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Archives a block; already gone or already archived is fine. */
async function archive(client: NotionClient, id: string) {
  try {
    await client.deleteBlock(id);
  } catch (error) {
    if (!(error instanceof NotionApiError && (error.isNotFound() || error.status === 400))) {
      throw error;
    }
  }
}

/** Appends `blocks` in batches, tracking ids in `state.blockIds` and checkpointing around each write. */
async function appendAll(
  input: PushInput,
  state: PushState,
  blocks: ReturnType<typeof toNotionBlocks>,
) {
  const written: string[] = [];
  for (const batch of batchBlocks(blocks)) {
    await input.checkpoint?.(state);
    const res = await input.client.appendChildren(state.page.id, batch);
    const ids = res.results.map((b) => b.id);
    written.push(...ids);
    state.blockIds = [...state.blockIds, ...ids];
    try {
      await input.checkpoint?.(state);
    } catch (error) {
      // We lost the right to write (e.g. the lease): take back what this batch added, then stop.
      await Promise.allSettled(ids.map((id) => archive(input.client, id)));
      throw error;
    }
  }
  return written;
}

export async function pushNote(input: PushInput): Promise<PushResult> {
  const { client, meta } = input;
  const content = toNotionBlocks(input.doc, { baseUrl: input.baseUrl });

  const current = input.existingPageId
    ? await existingPage(client, input.existingPageId)
    : undefined;
  if (current) {
    const parent = current.parent;
    const schema =
      parent.type === 'database_id' ? await client.retrieveDatabase(parent.database_id) : undefined;
    const { properties, covered } = buildProperties(meta, schema);
    const blocks = [...metaBlocks(meta, covered, input), ...content];
    const children: NotionBlockResponse[] = await client.listChildren(current.id);
    const owned = input.ownedBlockIds ? new Set(input.ownedBlockIds) : undefined;
    const old = children
      .filter((b) => !NEVER_ARCHIVE.has(b.type))
      .filter((b) => (owned ? owned.has(b.id) : true))
      .map((b) => b.id);
    const state: PushState = { page: current, blockIds: old };
    await input.checkpoint?.(state);
    const updated = await client.updatePage(current.id, { properties });
    state.page = updated;
    const written = await appendAll(input, state, blocks);
    await input.checkpoint?.(state);
    await eachLimited(old, input.deleteConcurrency ?? 3, (id) => archive(client, id));
    state.blockIds = written;
    await input.checkpoint?.(state);
    return {
      pageId: current.id,
      url: updated.url,
      created: false,
      blocks: blocks.length,
      blockIds: written,
    };
  }

  let schema: NotionDatabase | undefined;
  let page: NotionPage;
  const { target } = input;
  try {
    schema = target.type === 'database' ? await client.retrieveDatabase(target.id) : undefined;
    const { properties } = buildProperties(meta, schema);
    const parent = target.type === 'database' ? { database_id: target.id } : { page_id: target.id };
    page = await client.createPage({ parent, properties });
  } catch (error) {
    if (error instanceof NotionApiError && error.isNotFound()) {
      throw new NotionTargetMissingError(error.status, error.code, error.message);
    }
    throw error;
  }
  const { covered } = buildProperties(meta, schema);
  const blocks = [...metaBlocks(meta, covered, input), ...content];
  const state: PushState = { page, blockIds: [] };
  try {
    await input.checkpoint?.(state);
  } catch (error) {
    await archive(client, page.id).catch(() => undefined);
    throw error;
  }
  const written = await appendAll(input, state, blocks);
  return {
    pageId: page.id,
    url: page.url,
    created: true,
    blocks: blocks.length,
    blockIds: written,
  };
}
