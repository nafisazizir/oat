import { readFileSync } from 'node:fs';

import { createDb, meeting, participant, transcriptSegment } from '@oat/db';
import { expect, type Page } from '@playwright/test';

import type { DocumentDetail } from '../src/lib/api-types';
import { apiCreateDocument, apiCreateFolder, apiUpdateDocument } from './docs-helpers';
import { databaseUrlFile } from './paths';

/**
 * Realistic content for the 9.3 design sweep and the axe scan: a page with rich text, a recorded meeting
 * note (attendees, transcript, action items), a folder with a page in it, and a link-shared page. Meetings
 * and transcripts have no web write API (desktop sync), so they go into the e2e database directly.
 */

const text = (value: string, marks?: { type: string }[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const heading = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const bullets = (...items: string[]) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [paragraph(text(item))] })),
});

const PAGE_CONTENT = {
  type: 'doc',
  content: [
    paragraph(
      text('What we are building next quarter, and why. '),
      text('Owners update this weekly.', [{ type: 'italic' }]),
    ),
    heading(2, 'Themes'),
    bullets(
      'Calmer capture: fewer prompts, smarter defaults.',
      'Notes people want to share without editing first.',
      'A workspace that remembers decisions.',
    ),
    heading(2, 'Open questions'),
    paragraph(text('Do we ship the share viewer before the assistant panel?')),
  ],
};

const MEETING_CONTENT = {
  type: 'doc',
  content: [
    heading(2, 'Summary'),
    paragraph(text('Lakeside wants a two-clinic pilot starting in early March.')),
    heading(2, 'Decisions'),
    bullets('Pilot runs in two clinics.', 'Security review is signed before kickoff.'),
    heading(2, 'Action items'),
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [paragraph(text('Send the security questionnaire back by Friday'))],
        },
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [paragraph(text('Book a room for the kickoff'))],
        },
      ],
    },
  ],
};

const TALK = [
  ['system', 'Thanks for joining. Let us go through the pilot timeline first.'],
  ['mic', 'Sure. We planned the Lakeside rollout for early March.'],
  ['system', 'Procurement still needs the security review signed.'],
  ['mic', 'I will send the questionnaire back by Friday.'],
] as const;

export type SweepContent = {
  folderId: string;
  page: DocumentDetail;
  meeting: DocumentDetail;
  shareUrl: string;
};

async function withContent(page: Page, doc: DocumentDetail, content: unknown) {
  const res = await apiUpdateDocument(page, doc.id, {
    baseVersion: doc.version,
    contentJson: content,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as DocumentDetail;
}

/** Seeds the signed-in user's workspace (the page must be on an app route). */
export async function seedSweepContent(page: Page): Promise<SweepContent> {
  const folder = await apiCreateFolder(page, { name: 'Projects' });
  await apiCreateDocument(page, { title: 'Hiring plan', folderId: folder.id });
  const roadmap = await withContent(
    page,
    await apiCreateDocument(page, { title: 'Product roadmap' }),
    PAGE_CONTENT,
  );
  const meetingDoc = await withContent(
    page,
    await apiCreateDocument(page, { title: 'Lakeside pilot sync', kind: 'meeting' }),
    MEETING_CONTENT,
  );

  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  try {
    const [m] = await db
      .insert(meeting)
      .values({
        documentId: meetingDoc.id,
        startedAt: new Date('2026-11-12T15:04:00Z'),
        endedAt: new Date('2026-11-12T15:34:20Z'),
      })
      .returning();
    await db.insert(participant).values([
      { meetingId: m!.id, name: 'Riley Chen', email: 'riley@example.com', source: 'calendar' },
      { meetingId: m!.id, name: 'Sam Ortiz', email: 'sam@example.com', source: 'calendar' },
    ]);
    await db.insert(transcriptSegment).values(
      Array.from({ length: 16 }, (_, i) => {
        const [source, line] = TALK[i % TALK.length]!;
        return {
          id: `${meetingDoc.id}-l${String(i).padStart(2, '0')}`,
          meetingId: m!.id,
          source,
          startMs: i * 20_000,
          endMs: i * 20_000 + 6_000,
          text: line,
        };
      }),
    );
  } finally {
    await db.$client.end();
  }

  const share = await page.request.patch(`/api/documents/${roadmap.id}/share`, {
    data: { visibility: 'link' },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(share.status(), await share.text()).toBe(200);
  const { sharePath } = (await share.json()) as { sharePath: string };
  return { folderId: folder.id, page: roadmap, meeting: meetingDoc, shareUrl: sharePath };
}
