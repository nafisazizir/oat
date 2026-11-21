/**
 * Meeting notes on this Mac (task 3.4): what the main window's meeting view reads and writes, straight from
 * the signed-in user's local database (`@oat/local-store`). Every write lands in the outbox (triggers) and
 * nudges sync (2.6), which carries it to the server; the server re-checks every permission there.
 *
 * - "Editable" locally: not trashed, not in a workspace where I'm a viewer (3.9: roles sync), and mine or
 *   shared with the workspace. Anything the server still refuses is parked (D-28), never lost.
 * - `onChange` tells the windows to reload (list, header, participants). Content autosaves don't announce
 *   themselves: the window that typed them already shows them.
 */
import { notePrefill } from '@oat/calendar';
import type { CalendarEvent } from '@oat/core';
import type {
  MeetingNote,
  MeetingNoteSummary,
  MeetingParticipant,
  NoteCalendarEvent,
  StartNotesResult,
  StoredSegment,
} from '@oat/core/bridge';
import { sameDocumentContent } from '@oat/core/sync';
import { type LocalDocument, type LocalMeeting, type LocalStore, uuidv7 } from '@oat/local-store';

import { meetingTitle } from './meeting-persistence.ts';
import { noNoteWorkspaceMessage } from './workspaces.ts';

export interface MeetingNotesOptions {
  /** The signed-in user's local database (`null` while it isn't open). */
  store: () => LocalStore | null;
  /** The signed-in user (`null` when signed out). */
  userId: () => string | null;
  sync: { kick(): void };
  onChange: () => void;
  /** Whether this Mac has audio of the meeting (its parts are in the audio index). Default: no. */
  hasAudio?: (meetingId: string) => Promise<boolean>;
  /** 3.9: where a new note goes (`Workspaces.newNoteWorkspace`). Without it, or `null`: nowhere. */
  newNoteWorkspace?: (timeoutMs?: number) => Promise<string | null>;
  /** The calendar event a note was made from, by the key it carries (7.3), while the calendar has it. */
  calendarEvent?: (key: string) => CalendarEvent | null;
  newId?: () => string;
}

const normalizeTitle = (title: string) => title.replace(/\s+/g, ' ').trim();

export interface SaveResult {
  updatedAt: string;
  /** The note changed underneath the editor: the edit was kept as this page instead. */
  conflict: { documentId: string; title: string } | null;
}

/** A user-facing refusal (bridge `invalid_state` / `unavailable`). */
export class MeetingNotesError extends Error {
  override name = 'MeetingNotesError';
  constructor(
    readonly code: 'not_found' | 'read_only' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export class MeetingNotes {
  readonly #o: MeetingNotesOptions;

  constructor(options: MeetingNotesOptions) {
    this.#o = options;
  }

  #store(): LocalStore {
    const store = this.#o.store();
    if (!store || !this.#o.userId()) {
      throw new MeetingNotesError(
        'unavailable',
        'Your notes on this Mac aren’t available right now.',
      );
    }
    return store;
  }

  #document(store: LocalStore, documentId: string): LocalDocument {
    const doc = store.document(documentId);
    if (!doc || doc.kind !== 'meeting') {
      throw new MeetingNotesError('not_found', 'This note isn’t on this Mac.');
    }
    return doc;
  }

  #editable(doc: LocalDocument): boolean {
    // 3.9: a viewer's role is known locally now (pull scope 3): their notes there are view-only.
    if (this.#o.store()?.workspace(doc.workspaceId)?.role === 'viewer') return false;
    return (
      doc.deletedAt === null && (doc.ownerId === this.#o.userId() || doc.visibility !== 'private')
    );
  }

  #writable(store: LocalStore, documentId: string): LocalDocument {
    const doc = this.#document(store, documentId);
    if (!this.#editable(doc)) {
      throw new MeetingNotesError('read_only', 'You can’t edit this note.');
    }
    return doc;
  }

  list(): MeetingNoteSummary[] {
    const store = this.#o.store();
    const userId = this.#o.userId();
    if (!store || !userId) return [];
    return (
      store
        .meetingNotes()
        // Sync never sends another member's private note (D-22); should one be in the local database
        // all the same, it is not listed — Private is only ever my own (D-36).
        .filter((n) => n.visibility !== 'private' || n.ownerId === userId)
        .map((n) => ({
          documentId: n.documentId,
          meetingId: n.meetingId,
          workspaceId: n.workspaceId,
          ownerId: n.ownerId,
          title: n.title,
          visibility: n.visibility,
          startedAt: n.startedAt,
          endedAt: n.endedAt,
          createdAt: n.createdAt,
        }))
    );
  }

  async get(by: { documentId: string } | { meetingId: string }): Promise<MeetingNote | null> {
    const store = this.#o.store();
    if (!store || !this.#o.userId()) return null;
    const meeting =
      'meetingId' in by ? store.meeting(by.meetingId) : store.meetingOfDocument(by.documentId);
    const documentId = 'documentId' in by ? by.documentId : meeting?.documentId;
    const doc = documentId ? store.document(documentId) : undefined;
    if (!doc || doc.kind !== 'meeting') return null;
    const workspace = store.workspaces().find((w) => w.id === doc.workspaceId);
    const recordedHere = meeting ? await this.#recordable(store, meeting) : false;
    const event = meeting?.calendarEventId
      ? (this.#o.calendarEvent?.(meeting.calendarEventId) ?? null)
      : null;
    return {
      documentId: doc.id,
      meetingId: meeting?.id ?? null,
      workspaceId: doc.workspaceId,
      workspaceName: workspace?.name ?? null,
      title: doc.title,
      contentJson: doc.contentJson,
      visibility: doc.visibility,
      editable: this.#editable(doc),
      recordedHere,
      trashed: doc.deletedAt !== null,
      startedAt: meeting?.startedAt ?? null,
      endedAt: meeting?.endedAt ?? null,
      updatedAt: doc.updatedAt,
      participants: meeting ? store.participants(meeting.id).map(toParticipant) : [],
      calendarEvent: event && toNoteEvent(event),
    };
  }

  /**
   * D-24 + 7.3: recording on this Mac may add to a meeting whose audio is here, or to **my own** note nothing was
   * recorded for yet (made from a calendar event, or on the web): no start time and no transcript. A teammate's
   * never-recorded note isn't: their Mac may be starting it right now (sync hasn't told us), and two devices must
   * never record one meeting — "Start notes" then makes my own note for the event instead.
   */
  async #recordable(store: LocalStore, meeting: LocalMeeting): Promise<boolean> {
    if ((await this.#o.hasAudio?.(meeting.id)) ?? false) return true;
    const mine = store.document(meeting.documentId)?.ownerId === this.#o.userId();
    return mine && meeting.startedAt === null && store.segments(meeting.id).length === 0;
  }

  /**
   * The meeting note for one of these calendar keys (`calendarEventKey`, or an event id) — mine first, then
   * one shared with me; trashed notes don't count. `null` when there is none (or no database).
   */
  findByCalendarKeys(keys: readonly string[]): string | null {
    const store = this.#o.store();
    const userId = this.#o.userId();
    if (!store || !userId || keys.length === 0) return null;
    let shared: string | null = null;
    for (const n of store.meetingNotes()) {
      if (!n.meetingId) continue;
      const key = store.meeting(n.meetingId)?.calendarEventId;
      if (!key || !keys.includes(key)) continue;
      if (n.ownerId === userId) return n.documentId;
      shared ??= n.documentId;
    }
    return shared;
  }

  readonly #creating = new Map<string, Promise<StartNotesResult>>();

  /**
   * "Start notes" on an event (7.3): the note already made for this meeting, else a new private note in the
   * workspace new notes go to (3.9: the active one when I can create there, else the first one where I can) with the event's title, its key (`meeting.calendar_event_id`) and its attendees
   * (source `calendar`). Not started (no start time) until a recording starts. Concurrent calls for one event
   * share one creation.
   */
  fromEvent(event: CalendarEvent): Promise<StartNotesResult> {
    const prefill = notePrefill(event);
    const running = this.#creating.get(prefill.calendarEventKey);
    if (running) return running;
    const work = this.#fromEvent(event, prefill).finally(() =>
      this.#creating.delete(prefill.calendarEventKey),
    );
    this.#creating.set(prefill.calendarEventKey, work);
    return work;
  }

  async #fromEvent(
    event: CalendarEvent,
    prefill: ReturnType<typeof notePrefill>,
  ): Promise<StartNotesResult> {
    const keys =
      prefill.calendarEventKey === event.id ? [event.id] : [prefill.calendarEventKey, event.id];
    const existing = this.findByCalendarKeys(keys);
    if (existing) {
      const meeting = this.#store().meetingOfDocument(existing);
      return { documentId: existing, meetingId: meeting!.id, created: false };
    }
    const userId = this.#o.userId();
    const workspaceId = (await this.#o.newNoteWorkspace?.()) ?? null;
    const store = this.#store();
    if (!userId || !workspaceId) {
      throw new MeetingNotesError('unavailable', noNoteWorkspaceMessage(userId ? store : null));
    }
    const newId = this.#o.newId ?? uuidv7;
    const meetingId = newId();
    const documentId = newId();
    store.transaction(() => {
      store.createMeeting({
        meetingId,
        documentId,
        workspaceId,
        ownerId: userId,
        title: prefill.title.slice(0, 200) || meetingTitle(event.start.getTime()),
        startedAt: null,
      });
      store.updateMeeting(meetingId, {
        calendarEventId: prefill.calendarEventKey,
        platform: event.conferenceProvider,
      });
      for (const p of prefill.participants) {
        store.saveParticipant({
          id: newId(),
          meetingId,
          name: p.name,
          email: p.email,
          source: 'calendar',
        });
      }
    });
    this.#o.sync.kick();
    this.#o.onChange();
    return { documentId, meetingId, created: true };
  }

  transcript(documentId: string): StoredSegment[] {
    const store = this.#store();
    const meeting = store.meetingOfDocument(this.#document(store, documentId).id);
    if (!meeting) return [];
    return store.segments(meeting.id).map((s) => ({
      id: s.id,
      source: s.source,
      speaker: s.speakerLabel,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      ...(s.backfilled ? { backfilled: true } : {}),
    }));
  }

  /**
   * Can a recording continue this meeting (D-24)? Only an editable note whose audio is on this Mac: a
   * view-only or trashed note would get rows the server refuses, and a note recorded elsewhere has no parts
   * here to continue. Returns the reason it can't, or `null`.
   */
  async cannotContinue(meetingId: string): Promise<string | null> {
    const store = this.#store();
    const meeting = store.meeting(meetingId);
    const doc = meeting ? store.document(meeting.documentId) : undefined;
    if (!meeting || !doc) return 'This meeting isn’t on this Mac.';
    if (!this.#editable(doc)) return 'You can’t add to this note.';
    if (!(await this.#recordable(store, meeting))) {
      return 'This meeting was recorded on another device. Start a new note to record here.';
    }
    return null;
  }

  /**
   * Autosave. `base` is what the editor's state was built on; if the stored note has moved on since (sync
   * pulled someone's edit while I typed), it is not overwritten (D-19): my version becomes a conflicted copy.
   * A row that only differs by normalisation (key order, block ids — my own save coming back from the
   * server) is not a change.
   */
  save(
    documentId: string,
    base: { title: string; contentJson: LocalDocument['contentJson'] },
    patch: { title?: string; contentJson?: LocalDocument['contentJson'] },
  ): SaveResult {
    const store = this.#store();
    const doc = this.#writable(store, documentId);
    const title = patch.title === undefined ? undefined : normalizeTitle(patch.title);
    const moved =
      normalizeTitle(base.title) !== doc.title ||
      !sameDocumentContent(base.contentJson, doc.contentJson);
    if (moved) {
      const mine = {
        title: title ?? normalizeTitle(base.title),
        contentJson: patch.contentJson ?? base.contentJson,
      };
      if (mine.title === doc.title && sameDocumentContent(mine.contentJson, doc.contentJson)) {
        return { updatedAt: doc.updatedAt, conflict: null }; // same text either way
      }
      const copyId = store.saveConflictedCopy(documentId, this.#o.userId()!, mine);
      this.#o.sync.kick();
      this.#o.onChange(); // the view reloads the newer note
      return {
        updatedAt: doc.updatedAt,
        conflict: { documentId: copyId, title: store.document(copyId)!.title },
      };
    }
    const changed = store.updateDocument(documentId, {
      ...(title !== undefined ? { title } : {}),
      ...(patch.contentJson ? { contentJson: patch.contentJson } : {}),
    });
    if (changed) {
      this.#o.sync.kick();
      // The list shows titles; content changes are already on screen where they were typed.
      if (title !== undefined) this.#o.onChange();
    }
    return { updatedAt: store.document(documentId)!.updatedAt, conflict: null };
  }

  addParticipant(
    documentId: string,
    input: { name: string; email: string | null },
  ): MeetingParticipant {
    const store = this.#store();
    this.#writable(store, documentId);
    const meeting = store.meetingOfDocument(documentId);
    if (!meeting) {
      // A note made on the web gets its meeting row there (participants API); here only recorded notes.
      throw new MeetingNotesError('read_only', 'Add attendees to this note on the web for now.');
    }
    const participant = {
      id: (this.#o.newId ?? uuidv7)(),
      meetingId: meeting.id,
      name: input.name.trim(),
      email: input.email?.trim().toLowerCase() || null,
      source: 'manual' as const,
    };
    store.saveParticipant(participant);
    this.#o.sync.kick();
    this.#o.onChange();
    return toParticipant(participant);
  }

  removeParticipant(documentId: string, participantId: string): void {
    const store = this.#store();
    this.#writable(store, documentId);
    const meeting = store.meetingOfDocument(documentId);
    if (!meeting || !store.participants(meeting.id).some((p) => p.id === participantId)) {
      throw new MeetingNotesError('not_found', 'That attendee isn’t on this note.');
    }
    store.deleteParticipant(participantId);
    this.#o.sync.kick();
    this.#o.onChange();
  }
}

function toNoteEvent(event: CalendarEvent): NoteCalendarEvent {
  return {
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    conferenceUrl: event.conferenceUrl,
    conferenceProvider: event.conferenceProvider,
  };
}

function toParticipant(p: {
  id: string;
  name: string;
  email: string | null;
  source: 'calendar' | 'manual';
}): MeetingParticipant {
  return { id: p.id, name: p.name, email: p.email, source: p.source };
}
