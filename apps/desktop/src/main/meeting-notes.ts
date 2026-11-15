/**
 * Meeting notes on this Mac (task 3.4): what the main window's meeting view reads and writes, straight from
 * the signed-in user's local database (`@oat/local-store`). Every write lands in the outbox (triggers) and
 * nudges sync (2.6), which carries it to the server; the server re-checks every permission there.
 *
 * - "Editable" locally: not trashed, and mine or shared with the workspace. The local cache doesn't know my
 *   role in a team workspace, so a viewer's edit is refused by the server and parked (D-28), never lost.
 * - `onChange` tells the windows to reload (list, header, participants). Content autosaves don't announce
 *   themselves: the window that typed them already shows them.
 */
import type {
  MeetingNote,
  MeetingNoteSummary,
  MeetingParticipant,
  StoredSegment,
} from '@oat/core/bridge';
import { sameDocumentContent } from '@oat/core/sync';
import { type LocalDocument, type LocalStore, uuidv7 } from '@oat/local-store';

export interface MeetingNotesOptions {
  /** The signed-in user's local database (`null` while it isn't open). */
  store: () => LocalStore | null;
  /** The signed-in user (`null` when signed out). */
  userId: () => string | null;
  sync: { kick(): void };
  onChange: () => void;
  /** Whether this Mac has audio of the meeting (its parts are in the audio index). Default: no. */
  hasAudio?: (meetingId: string) => Promise<boolean>;
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
    if (!store || !this.#o.userId()) return [];
    return store.meetingNotes().map((n) => ({
      documentId: n.documentId,
      meetingId: n.meetingId,
      workspaceId: n.workspaceId,
      title: n.title,
      visibility: n.visibility,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      createdAt: n.createdAt,
    }));
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
    const recordedHere = meeting ? ((await this.#o.hasAudio?.(meeting.id)) ?? false) : false;
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
    };
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
    if (!(await this.#o.hasAudio?.(meetingId))) {
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

function toParticipant(p: {
  id: string;
  name: string;
  email: string | null;
  source: 'calendar' | 'manual';
}): MeetingParticipant {
  return { id: p.id, name: p.name, email: p.email, source: p.source };
}
