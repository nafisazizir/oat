/**
 * The meeting side of meeting notes (3.4) against a throwaway database: `GET /api/documents/:id/meeting`
 * (times, attendees, optional transcript) and the participants API (`POST …/participants`, `DELETE
 * …/participants/:participantId`) with their deny cases: readers read, editors change attendees, viewers and
 * trashed notes get 403, people who can't read the note get 404, anonymous 401, cross-site cookie writes 403.
 */
import { changeLog, document, meeting, participant, transcriptSegment } from '@oat/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';
import type { MeetingInfo, MeetingParticipant } from '@/lib/meeting';

import {
  BASE,
  call,
  type CallOptions,
  createHarness,
  denies,
  type Harness,
  type TestUser,
} from './api/test-harness';
import { createMeetingApi, MAX_PARTICIPANTS, type MeetingApi } from './meeting';

let h: Harness;
let api: MeetingApi;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;

beforeAll(async () => {
  h = await createHarness();
  api = createMeetingApi({
    db: () => h.db,
    getSession: (headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
  });
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('mt-owner'),
    h.signUp('mt-member'),
    h.signUp('mt-viewer'),
    h.signUp('mt-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

async function note(as: TestUser, body: Record<string, unknown> = {}): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body: { workspaceId: team, kind: 'meeting', title: 'Pilot sync', ...body },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

const info = (
  as: TestUser | null,
  id: string,
  opts: Partial<CallOptions> & { transcript?: boolean } = {},
) =>
  call<MeetingInfo>(
    api.meeting.GET,
    'GET',
    `/api/documents/${id}/meeting${opts.transcript ? '?transcript=1' : ''}`,
    { as, params: { id }, ...opts },
  );
const add = (as: TestUser | null, id: string, body: unknown, opts: Partial<CallOptions> = {}) =>
  call<MeetingParticipant>(api.participants.POST, 'POST', `/api/documents/${id}/participants`, {
    as,
    body,
    params: { id },
    ...opts,
  });
const remove = (
  as: TestUser | null,
  id: string,
  participantId: string,
  opts: Partial<CallOptions> = {},
) =>
  call(
    api.participant.DELETE as Parameters<typeof call>[0],
    'DELETE',
    `/api/documents/${id}/participants/${participantId}`,
    { as, params: { id, participantId }, ...opts },
  );

describe('meeting info', () => {
  it('a new web note has no meeting yet; a recorded one has times, attendees in order and a transcript', async () => {
    const fresh = await note(owner);
    expect((await info(owner, fresh.id)).body).toEqual({
      meetingId: null,
      startedAt: null,
      endedAt: null,
      participants: [],
    });

    const recorded = await note(owner);
    const [m] = await h.db
      .insert(meeting)
      .values({
        documentId: recorded.id,
        startedAt: new Date('2026-11-14T15:04:00Z'),
        endedAt: new Date('2026-11-14T15:16:00Z'),
      })
      .returning();
    await h.db
      .insert(participant)
      .values([{ meetingId: m!.id, name: 'Ada', email: 'ada@example.com', source: 'calendar' }]);
    await h.db.insert(transcriptSegment).values([
      {
        id: `${m!.id}-2`,
        meetingId: m!.id,
        source: 'system',
        startMs: 4000,
        endMs: 5000,
        text: 'Two',
      },
      {
        id: `${m!.id}-1`,
        meetingId: m!.id,
        source: 'mic',
        startMs: 1000,
        endMs: 2000,
        text: 'One',
      },
    ]);
    const res = await info(owner, recorded.id, { transcript: true, bearer: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      meetingId: m!.id,
      startedAt: '2026-11-14T15:04:00.000Z',
      endedAt: '2026-11-14T15:16:00.000Z',
      participants: [{ name: 'Ada', email: 'ada@example.com', source: 'calendar' }],
    });
    const resume = await call<MeetingInfo>(
      api.meeting.GET,
      'GET',
      `/api/documents/${recorded.id}/meeting?recording=1`,
      { as: owner, params: { id: recorded.id } },
    );
    expect(resume.body.recording?.lastSegmentEndMs).toBe(5000);
    expect(res.body.transcript?.map((l) => [l.speaker, l.text])).toEqual([
      ['Me', 'One'],
      ['Them', 'Two'],
    ]);
    // Without the flag, no transcript.
    expect((await info(owner, recorded.id)).body.transcript).toBeUndefined();
    // Live polling: only lines from `after` on.
    const since = await call<MeetingInfo>(
      api.meeting.GET,
      'GET',
      `/api/documents/${recorded.id}/meeting?transcript=1&after=4000`,
      { as: owner, params: { id: recorded.id } },
    );
    expect(since.body.transcript?.map((l) => l.text)).toEqual(['Two']);
  });

  it('a page has no meeting side', async () => {
    const page = await note(owner, { kind: 'page' });
    expect((await info(owner, page.id)).status).toBe(400);
    expect((await add(owner, page.id, { name: 'X' })).status).toBe(400);
  });
});

describe('participants', () => {
  it('editors add attendees (creating the meeting row once) and remove them', async () => {
    const doc = await note(owner, { visibility: 'workspace' });
    const ada = await add(owner, doc.id, { name: '  Ada   Lovelace ', email: ' Ada@Example.com ' });
    expect(ada.status, JSON.stringify(ada.error)).toBe(201);
    expect(ada.body).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'manual',
    });
    // A member edits a shared note too (bearer: the desktop app's way in).
    const lin = await add(member, doc.id, { name: '', email: 'lin@example.com' }, { bearer: true });
    expect(lin.status).toBe(201);
    expect(lin.body.name).toBe('lin@example.com');
    const grace = await add(member, doc.id, { name: 'Grace' });
    expect(grace.body.email).toBeNull();

    const meetings = await h.db.select().from(meeting).where(eq(meeting.documentId, doc.id));
    expect(meetings).toHaveLength(1);
    expect((await info(viewer, doc.id)).body.participants.map((p) => p.name)).toEqual([
      'Ada Lovelace',
      'lin@example.com',
      'Grace',
    ]);

    expect((await remove(owner, doc.id, lin.body.id)).status).toBe(204);
    expect((await remove(owner, doc.id, lin.body.id)).status).toBe(404);
    expect((await info(owner, doc.id)).body.participants.map((p) => p.name)).toEqual([
      'Ada Lovelace',
      'Grace',
    ]);
    // The change reaches the desktop through change_log (D-22) like any other row.
    const logged = await h.db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.tableName, 'participant'), eq(changeLog.rowId, ada.body.id)));
    expect(logged.length).toBeGreaterThan(0);
  });

  it('validates input', async () => {
    const doc = await note(owner);
    expect((await add(owner, doc.id, { name: '', email: null })).status).toBe(400);
    expect((await add(owner, doc.id, { name: 'X', email: 'nope' })).status).toBe(400);
    expect((await add(owner, doc.id, { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await add(owner, doc.id, { name: 'X', source: 'calendar' })).status).toBe(400);
    expect((await add(owner, doc.id, { name: 'X', email: '' })).body.email).toBeNull();
  });

  it(`caps a meeting at ${MAX_PARTICIPANTS} attendees`, async () => {
    const doc = await note(owner);
    expect((await add(owner, doc.id, { name: 'First' })).status).toBe(201);
    const [m] = await h.db.select().from(meeting).where(eq(meeting.documentId, doc.id));
    await h.db.insert(participant).values(
      Array.from({ length: MAX_PARTICIPANTS - 1 }, (_, i) => ({
        meetingId: m!.id,
        name: `P${i}`,
        source: 'calendar' as const,
      })),
    );
    expect((await add(owner, doc.id, { name: 'One too many' })).status).toBe(400);
  });

  it('deny: anonymous 401, unreadable 404, viewers and trashed notes 403, cross-site 403, other notes’ attendees 404', async () => {
    denies(
      'GET /api/documents/[id]/meeting',
      'POST /api/documents/[id]/participants',
      'DELETE /api/documents/[id]/participants/[participantId]',
    );
    const shared = await note(owner, { visibility: 'workspace' });
    const p = (await add(owner, shared.id, { name: 'Ada' })).body;
    const secret = await note(owner);
    const sp = (await add(owner, secret.id, { name: 'Hidden' })).body;

    // Anonymous.
    expect((await info(null, shared.id)).status).toBe(401);
    expect((await add(null, shared.id, { name: 'X' })).status).toBe(401);
    expect((await remove(null, shared.id, p.id)).status).toBe(401);

    // Can't read the note: 404, whether it exists or not.
    for (const u of [member, viewer, outsider]) {
      expect((await info(u, secret.id)).status).toBe(404);
      expect((await add(u, secret.id, { name: 'X' })).status).toBe(404);
      expect((await remove(u, secret.id, sp.id)).status).toBe(404);
    }
    expect((await info(outsider, shared.id)).status).toBe(404);
    expect((await add(outsider, shared.id, { name: 'X' })).status).toBe(404);
    expect((await info(owner, 'no-such-doc')).status).toBe(404);

    // Viewers read but can't change attendees.
    expect((await info(viewer, shared.id)).status).toBe(200);
    expect((await add(viewer, shared.id, { name: 'X' })).status).toBe(403);
    expect((await remove(viewer, shared.id, p.id)).status).toBe(403);

    // Another note's attendee can't be removed through this note.
    expect((await remove(owner, shared.id, sp.id)).status).toBe(404);
    expect((await info(owner, secret.id)).body.participants.map((x) => x.id)).toEqual([sp.id]);

    // Cookie writes from another site.
    expect(
      (await add(owner, shared.id, { name: 'X' }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await remove(owner, shared.id, p.id, { origin: 'https://evil.example' })).status).toBe(
      403,
    );

    // Trash is read-only for everyone.
    await h.db.update(document).set({ deletedAt: new Date() }).where(eq(document.id, shared.id));
    expect((await info(owner, shared.id)).status).toBe(200);
    expect((await add(owner, shared.id, { name: 'X' })).status).toBe(403);
    expect((await remove(owner, shared.id, p.id)).status).toBe(403);
  });
});
