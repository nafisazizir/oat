import { createOatClient, OatApiError, type OatClient } from '@oat/client';
import {
  syncBackfillResponseSchema,
  syncDocumentRowSchema,
  syncWorkspaceRowSchema,
  type SyncPullChange,
} from '@oat/core/sync';
import type { MeetingLoad } from '@oat/core/bridge-meetings';
import type { LocalStore } from '@oat/local-store';
import type { AuthController } from './auth';
import { ApiError, type createApiRequester } from './api-client';
import { apiProxyUrl } from './api-proxy';
import type { MeetingNotes } from './meeting-notes';

export function createMeetingReadClient({
  auth,
  request,
  baseUrl,
}: {
  auth: Pick<AuthController, 'withSession'>;
  request: ReturnType<typeof createApiRequester>;
  baseUrl: string;
}): OatClient {
  return createOatClient(async (input) => {
    const url = apiProxyUrl(input, baseUrl);
    try {
      const response = await auth.withSession(async (token) => {
        const response = await request(url.pathname + url.search, {
          method: input.method,
          token,
          signal: input.signal,
        });
        if (response.status === 401) throw new ApiError(401, 'Your session has ended.');
        return response;
      });
      return { status: response.status, json: () => response.json() };
    } catch (error) {
      if (error instanceof ApiError)
        throw new OatApiError(error.status, 'unavailable', error.message);
      throw error;
    }
  });
}

export class MeetingReadThrough {
  constructor(
    private readonly options: {
      store(): LocalStore | null;
      userId(): string | null;
      client: OatClient;
      notes: Pick<MeetingNotes, 'get'>;
      onChange(): void;
    },
  ) {}

  async load(documentId: string): Promise<MeetingLoad> {
    const { client, notes } = this.options;
    const store = this.options.store();
    const user = this.options.userId();
    if (!store || !user) return { state: 'error' };
    const current = () =>
      !!store && !!user && this.options.store() === store && this.options.userId() === user;
    try {
      if (!current()) return { state: 'error' };
      const local = await notes.get({ documentId });
      if (!current()) return { state: 'error' };
      if (local) return { state: 'ready', note: local };
      const detail = await client.documents.get(documentId);
      if (detail.id !== documentId || detail.kind !== 'meeting') return { state: 'missing' };
      const document = syncDocumentRowSchema.parse(detail);
      const list = await client.workspaces.list();
      const found = list.workspaces.find((w) => w.id === document.workspaceId);
      if (!found) return { state: 'missing' };
      const workspace = syncWorkspaceRowSchema.parse(found);
      const changes: SyncPullChange[] = [];
      const seen = new Set<string>();
      let after: string | undefined;
      do {
        const page = syncBackfillResponseSchema.parse(
          await client.sync.backfill(documentId, after),
        );
        changes.push(...page.changes);
        if (page.next !== null && seen.has(page.next)) throw new Error('Repeated backfill page.');
        if (page.next !== null) seen.add(page.next);
        after = page.next ?? undefined;
      } while (after !== undefined);
      if (!current()) return { state: 'error' };
      if (store.cacheMeeting(document, workspace, changes)) this.options.onChange();
      const note = await notes.get({ documentId });
      if (!current()) return { state: 'error' };
      return note ? { state: 'ready', note } : { state: 'missing' };
    } catch (error) {
      if (error instanceof OatApiError) {
        if (error.status === 403 || error.status === 404) return { state: 'missing' };
        if (error.status === 0) return { state: 'offline' };
      }
      return { state: 'error' };
    }
  }
}
