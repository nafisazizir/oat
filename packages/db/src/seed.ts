/**
 * Dev seed: a demo user (`demo@oat.local`) with a workspace of their own and a team workspace, a few folders and
 * documents, and one meeting with a transcript. Idempotent: every row has a fixed id and is inserted with
 * `on conflict do nothing`, so re-running never duplicates or overwrites anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { TRANSCRIPT_SOURCES, type TranscriptSource } from '@oat/core';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  document,
  folder,
  meeting,
  membership,
  participant,
  template,
  transcriptSegment,
  user,
  workspace,
} from './schema/index.ts';

/** Fixed, valid UUIDv7-shaped ids so the seed is stable across runs and machines. */
const seedId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const SEED = {
  userId: seedId(1),
  email: 'demo@oat.local',
  ownWorkspaceId: seedId(10),
  teamWorkspaceId: seedId(11),
  folders: { projects: seedId(20), meetings: seedId(21), drafts: seedId(22) },
  documents: { welcome: seedId(30), roadmap: seedId(31), standup: seedId(32), draft: seedId(33) },
  templateId: seedId(40),
  meetingId: seedId(50),
} as const;

/** Repo-root transcript fixture (task 2.1); optional. */
export const SEGMENTS_FIXTURE = new URL(
  '../../../fixtures/audio/standup-short.segments.json',
  import.meta.url,
);

export interface SeedSegment {
  id?: string;
  source: TranscriptSource;
  speakerLabel?: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

const FALLBACK_SEGMENTS: SeedSegment[] = [
  { source: 'mic', startMs: 0, endMs: 4200, text: "Morning! Let's do a quick round." },
  { source: 'system', startMs: 4600, endMs: 9800, text: 'I finished the export flow yesterday.' },
  {
    source: 'system',
    startMs: 10_200,
    endMs: 15_100,
    text: 'Today I am picking up the share dialog.',
  },
  {
    source: 'mic',
    startMs: 15_500,
    endMs: 21_000,
    text: 'Great. I will review the schema PR after this.',
  },
];

/** Reads `[{ source, startMs, endMs, text, speakerLabel?, id? }]` (or `{ segments: [...] }`). */
export function parseSeedSegments(json: unknown): SeedSegment[] {
  const list = Array.isArray(json) ? json : (json as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) throw new Error('segments fixture: expected an array of segments');
  return list.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    const ok =
      typeof s.text === 'string' &&
      (TRANSCRIPT_SOURCES as readonly unknown[]).includes(s.source) &&
      Number.isInteger(s.startMs) &&
      Number.isInteger(s.endMs) &&
      (s.endMs as number) >= (s.startMs as number) &&
      (s.startMs as number) >= 0;
    if (!ok) throw new Error(`segments fixture: invalid segment at index ${i}`);
    return {
      id: typeof s.id === 'string' && s.id ? s.id : undefined,
      source: s.source as TranscriptSource,
      speakerLabel: typeof s.speakerLabel === 'string' ? s.speakerLabel : null,
      startMs: s.startMs as number,
      endMs: s.endMs as number,
      text: s.text as string,
    };
  });
}

function loadSegments(): SeedSegment[] {
  if (!existsSync(SEGMENTS_FIXTURE)) return FALLBACK_SEGMENTS;
  return parseSeedSegments(JSON.parse(readFileSync(SEGMENTS_FIXTURE, 'utf8')));
}

/** A TipTap doc of headings/paragraphs plus its Markdown. */
function doc(blocks: Array<{ h?: string; p?: string }>) {
  const content = blocks.map((b) =>
    b.h !== undefined
      ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: b.h }] }
      : { type: 'paragraph', content: [{ type: 'text', text: b.p ?? '' }] },
  );
  const md = blocks.map((b) => (b.h !== undefined ? `## ${b.h}` : (b.p ?? ''))).join('\n\n');
  return { contentJson: { type: 'doc', content }, contentMd: md };
}

export interface SeedResult {
  /** Rows inserted by this run (0 for every table on a re-run). */
  inserted: Record<string, number>;
  segmentsSource: 'fixture' | 'builtin';
}

export async function seed(
  db: Db,
  options: { segments?: SeedSegment[] } = {},
): Promise<SeedResult> {
  const segmentsSource = options.segments
    ? 'fixture'
    : existsSync(SEGMENTS_FIXTURE)
      ? 'fixture'
      : 'builtin';
  const segments = options.segments ?? loadSegments();
  return db.transaction(async (tx) => {
    const inserted: Record<string, number> = {};
    const count = (table: string, rows: unknown[]) => {
      inserted[table] = (inserted[table] ?? 0) + rows.length;
    };

    count(
      'user',
      await tx
        .insert(user)
        .values({ id: SEED.userId, email: SEED.email, name: 'Demo User', emailVerified: true })
        .onConflictDoNothing()
        .returning({ id: user.id }),
    );
    // The demo user may already exist with another id (e.g. signed up through auth): use that one.
    const [demo] = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${SEED.email}`);
    if (!demo) throw new Error('seed: demo user missing after insert');
    const userId = demo.id;
    const ownSlug = 'oat-demo-own';
    const teamSlug = 'oat-demo-team';

    // Likewise reuse the workspace the demo user already has (auth creates one on sign-up, D-36): their
    // oldest membership. Only a user without one gets the seeded workspace of their own.
    const firstWorkspace = () =>
      tx
        .select({ id: workspace.id })
        .from(membership)
        .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
        .where(and(eq(membership.userId, userId), ne(workspace.slug, teamSlug)))
        .orderBy(asc(membership.createdAt), asc(membership.id))
        .limit(1);
    const [existing] = await firstWorkspace();
    count(
      'workspace',
      await tx
        .insert(workspace)
        .values([
          ...(existing
            ? []
            : [
                {
                  id: SEED.ownWorkspaceId,
                  name: 'Demo’s workspace',
                  slug: ownSlug,
                  createdBy: userId,
                },
              ]),
          { id: SEED.teamWorkspaceId, name: 'Oat Demo Team', slug: teamSlug, createdBy: userId },
        ])
        .onConflictDoNothing()
        .returning({ id: workspace.id }),
    );
    const slugId = async (slug: string) =>
      (await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, slug)))[0]?.id;
    const ownWs = existing?.id ?? (await slugId(ownSlug));
    const teamWs = await slugId(teamSlug);
    if (!ownWs || !teamWs) throw new Error('seed: demo workspaces missing after insert');

    count(
      'membership',
      await tx
        .insert(membership)
        .values([
          { id: seedId(12), workspaceId: ownWs, userId, role: 'owner' },
          { id: seedId(13), workspaceId: teamWs, userId, role: 'owner' },
        ])
        .onConflictDoNothing()
        .returning({ id: membership.id }),
    );

    count(
      'folder',
      await tx
        .insert(folder)
        .values([
          {
            id: SEED.folders.projects,
            workspaceId: ownWs,
            name: 'Projects',
            visibility: 'private',
            ownerId: userId,
          },
          {
            id: SEED.folders.meetings,
            workspaceId: teamWs,
            name: 'Meetings',
            visibility: 'workspace',
            ownerId: userId,
          },
          {
            id: SEED.folders.drafts,
            workspaceId: teamWs,
            name: 'My drafts',
            visibility: 'private',
            ownerId: userId,
          },
        ])
        .onConflictDoNothing()
        .returning({ id: folder.id }),
    );

    count(
      'template',
      await tx
        .insert(template)
        .values({
          id: SEED.templateId,
          workspaceId: teamWs,
          name: 'Team standup',
          instructions: 'Summarise progress, plans and blockers per person.',
          sectionsJson: [
            { heading: 'Updates', instructions: 'What each person finished.' },
            { heading: 'Plans', instructions: 'What each person is doing next.' },
            { heading: 'Blockers', instructions: 'Anything blocking progress, with owners.' },
          ],
          isBuiltin: false,
        })
        .onConflictDoNothing()
        .returning({ id: template.id }),
    );

    count(
      'document',
      await tx
        .insert(document)
        .values([
          {
            id: SEED.documents.welcome,
            workspaceId: ownWs,
            ownerId: userId,
            kind: 'page',
            title: 'Welcome to Oat',
            visibility: 'private',
            ...doc([
              { h: 'Welcome' },
              { p: 'This page is private. Only you can see it.' },
            ]),
          },
          {
            id: SEED.documents.roadmap,
            workspaceId: ownWs,
            folderId: SEED.folders.projects,
            ownerId: userId,
            kind: 'page',
            title: 'Side project roadmap',
            visibility: 'private',
            ...doc([{ h: 'Next up' }, { p: 'Ship the notes export.' }]),
          },
          {
            id: SEED.documents.standup,
            workspaceId: teamWs,
            folderId: SEED.folders.meetings,
            ownerId: userId,
            kind: 'meeting',
            title: 'Daily standup',
            visibility: 'workspace',
            ...doc([{ p: 'export flow done; share dialog next' }]),
          },
          {
            id: SEED.documents.draft,
            workspaceId: teamWs,
            folderId: SEED.folders.drafts,
            ownerId: userId,
            kind: 'page',
            title: 'Draft: Q3 planning',
            visibility: 'private',
            ...doc([{ p: 'Rough ideas, not ready to share.' }]),
          },
        ])
        .onConflictDoNothing()
        .returning({ id: document.id }),
    );

    count(
      'meeting',
      await tx
        .insert(meeting)
        .values({
          id: SEED.meetingId,
          documentId: SEED.documents.standup,
          startedAt: new Date('2026-11-02T09:30:00Z'),
          endedAt: new Date('2026-11-02T09:45:00Z'),
          platform: 'zoom',
          templateId: SEED.templateId,
        })
        .onConflictDoNothing()
        .returning({ id: meeting.id }),
    );

    count(
      'participant',
      await tx
        .insert(participant)
        .values([
          {
            id: seedId(51),
            meetingId: SEED.meetingId,
            name: 'Demo User',
            email: SEED.email,
            source: 'calendar',
          },
          { id: seedId(52), meetingId: SEED.meetingId, name: 'Sam Teammate', source: 'manual' },
        ])
        .onConflictDoNothing()
        .returning({ id: participant.id }),
    );

    if (segments.length > 0) {
      count(
        'transcript_segment',
        await tx
          .insert(transcriptSegment)
          .values(
            segments.map((s, i) => ({
              id: s.id ?? `${SEED.meetingId}-seg-${i}`,
              meetingId: SEED.meetingId,
              source: s.source,
              speakerLabel: s.speakerLabel ?? null,
              startMs: s.startMs,
              endMs: s.endMs,
              text: s.text,
              isFinal: true,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: transcriptSegment.id }),
      );
    }

    return { inserted, segmentsSource };
  });
}
