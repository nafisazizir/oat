/**
 * Recording → local database (task 2.6): what `RecordingService` hands over is written to `@oat/local-store`
 * the moment it is final, and every write nudges sync (its outbox triggers queue the row; `SyncService`
 * pushes it).
 *
 * - Start: the meeting row and its `meeting` document (private, workspace root, owned by the user, in
 *   their personal workspace) are created before the audio starts; resuming a meeting reuses them.
 * - Finals only (D-19: a final replaces its interim; interims never reach the database). An empty final is
 *   a retraction and deletes the segment.
 * - Stop: `ended_at` is stamped.
 */
import type { LiveSegment } from '@oat/core/bridge';
import { type LocalStore, uuidv7 } from '@oat/local-store';

import type { TranscriptPersistence } from './recording-service.ts';

export interface MeetingPersistenceOptions {
  /** The signed-in user's local database (`null` when it isn't open). */
  store: () => LocalStore | null;
  sync: { kick(): void; personalWorkspace(timeoutMs?: number): Promise<string | null> };
  /** The signed-in user (`null` when signed out). */
  userId: () => string | null;
  newId?: () => string;
  /** How long a start waits to learn the workspace on a fresh cache. Default: SyncService's (10 s). */
  workspaceTimeoutMs?: number;
  /** A meeting note was created or ended (3.4: the windows reload their list). */
  onChange?: () => void;
}

/** Thrown by `beginMeeting`; the message is shown to the user. */
export class PersistenceError extends Error {
  override name = 'PersistenceError';
}

const TITLE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Default title of a new meeting note, e.g. "Meeting, Nov 14, 3:04 PM". */
export function meetingTitle(startedAt: number): string {
  return `Meeting, ${TITLE_FORMAT.format(startedAt)}`;
}

export class MeetingPersistence implements TranscriptPersistence {
  readonly #o: MeetingPersistenceOptions;

  constructor(options: MeetingPersistenceOptions) {
    this.#o = options;
  }

  #store(): LocalStore {
    const store = this.#o.store();
    if (!store) {
      throw new PersistenceError(
        'The local database on this Mac can’t be opened right now. Try again in a moment.',
      );
    }
    return store;
  }

  async beginMeeting(meetingId: string, startedAt: number): Promise<void> {
    const userId = this.#o.userId();
    if (!userId) throw new PersistenceError('Sign in to record.');
    const existing = this.#store().meeting(meetingId);
    if (existing) {
      // Resuming (D-24): same meeting, same note — and it is in progress again.
      if (existing.endedAt !== null && this.#store().updateMeeting(meetingId, { endedAt: null })) {
        this.#o.sync.kick();
        this.#o.onChange?.();
      }
      return;
    }
    const workspaceId = await this.#o.sync.personalWorkspace(this.#o.workspaceTimeoutMs);
    const store = this.#store();
    if (!workspaceId) {
      throw new PersistenceError(
        'Oat needs to connect once to set up your notes on this Mac. Check your connection and try again.',
      );
    }
    store.createMeeting({
      meetingId,
      documentId: (this.#o.newId ?? (() => uuidv7()))(),
      workspaceId,
      ownerId: userId,
      title: meetingTitle(startedAt),
      startedAt: new Date(startedAt).toISOString(),
    });
    this.#o.sync.kick();
    this.#o.onChange?.();
  }

  saveSegment(meetingId: string, segment: LiveSegment): void {
    if (!segment.isFinal) return;
    const store = this.#store();
    if (segment.text === '') {
      if (store.deleteSegment(segment.id)) this.#o.sync.kick();
      return;
    }
    const startMs = Math.max(0, Math.round(segment.startMs));
    const result = store.saveSegment({
      id: segment.id,
      meetingId,
      source: segment.source,
      speakerLabel: null,
      startMs,
      endMs: Math.max(startMs, Math.round(segment.endMs)),
      text: segment.text,
    });
    if (result !== 'unchanged') this.#o.sync.kick();
  }

  /** Where the meeting's stored transcript ends (ms, meeting clock): a resumed recording starts after it. */
  meetingEndMs(meetingId: string): number {
    const store = this.#o.store();
    if (!store) return 0;
    return store.segments(meetingId).reduce((end, s) => Math.max(end, s.endMs), 0);
  }

  endMeeting(meetingId: string, endedAt: number): void {
    if (this.#store().updateMeeting(meetingId, { endedAt: new Date(endedAt).toISOString() })) {
      this.#o.sync.kick();
      this.#o.onChange?.();
    }
  }
}
