/**
 * Chat eval fixtures (6.2): one synthetic team workspace, written for Oat. Mira asks; Theo is a teammate whose
 * private note must never leak into her answers.
 */
import type { ChatFixture, ChatWorld } from '../../src/evals/chat-suite.ts';
import type { DocumentRecord, MeetingRecord, SegmentRecord } from '../../src/tools/types.ts';

const TEAM = 'ws-harbor';
const MIRA = 'u-mira';
const THEO = 'u-theo';

const p = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const h = (id: string, text: string) => ({
  type: 'heading',
  attrs: { id, level: 2 },
  content: [{ type: 'text', text }],
});

function doc(
  id: string,
  ownerId: string,
  title: string,
  blocks: unknown[],
  over: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    id,
    workspaceId: TEAM,
    folderId: null,
    ownerId,
    kind: 'meeting',
    title,
    visibility: 'workspace',
    shareToken: null,
    deletedAt: null,
    version: 1,
    createdAt: new Date('2026-11-12T12:00:00Z'),
    updatedAt: new Date('2026-11-12T12:00:00Z'),
    contentJson: { type: 'doc', content: blocks },
    ...over,
  };
}

function lines(
  meetingId: string,
  prefix: string,
  rows: [source: 'mic' | 'system', speaker: string | null, text: string][],
): SegmentRecord[] {
  let at = 2_000;
  return rows.map(([source, speakerLabel, text], i) => {
    const startMs = at;
    const endMs = startMs + Math.max(2_000, text.split(' ').length * 400);
    at = endMs + 500;
    return { id: `${prefix}-${i + 1}`, meetingId, source, speakerLabel, startMs, endMs, text };
  });
}

const documents: DocumentRecord[] = [
  doc('doc-pricing', MIRA, 'Pricing review with Jonas', [
    h('pr-h1', 'Decisions'),
    p('pr-b1', 'Starter plan stays at nine euros per seat until the spring release.'),
    p('pr-b2', 'Annual billing gets a fifteen percent discount.'),
  ]),
  doc('doc-roadmap', MIRA, 'Mobile roadmap sync', [
    h('rm-h1', 'Timeline'),
    p('rm-b1', 'The mobile app beta opens to customers on the third of March.'),
    p('rm-b2', 'Offline mode slips to the summer release.'),
  ]),
  doc('doc-1on1', MIRA, '1:1 Mira / Priya', [
    p('oo-b1', 'Priya wants help preparing the on-call handbook.'),
    p('oo-b2', 'Follow up about the conference talk proposal.'),
  ]),
  doc(
    'doc-theo-private',
    THEO,
    'Theo pricing ideas',
    [p('tp-b1', 'Confidential: raise the starter plan price to thirty euros per seat next month.')],
    { visibility: 'private' },
  ),
];

const at = (iso: string) => new Date(iso);
const meetings: MeetingRecord[] = [
  {
    id: 'm-pricing',
    documentId: 'doc-pricing',
    startedAt: at('2026-11-09T10:00:00Z'),
    endedAt: at('2026-11-09T10:40:00Z'),
    platform: 'meet',
    participants: [{ name: 'Jonas Berg', email: 'jonas@harbor.test' }],
  },
  {
    id: 'm-roadmap',
    documentId: 'doc-roadmap',
    startedAt: at('2026-11-10T14:00:00Z'),
    endedAt: at('2026-11-10T14:30:00Z'),
    platform: 'zoom',
    participants: [{ name: 'Lea Park', email: 'lea@harbor.test' }],
  },
  {
    id: 'm-1on1',
    documentId: 'doc-1on1',
    startedAt: at('2026-11-11T09:00:00Z'),
    endedAt: at('2026-11-11T09:30:00Z'),
    platform: 'meet',
    participants: [{ name: 'Priya Nair', email: 'priya@harbor.test' }],
  },
  {
    id: 'm-theo',
    documentId: 'doc-theo-private',
    startedAt: at('2026-11-12T08:00:00Z'),
    endedAt: null,
    platform: null,
    participants: [],
  },
];

const segments: SegmentRecord[] = [
  ...lines('m-pricing', 'pr', [
    ['mic', null, 'Let us settle the starter plan price before the spring release.'],
    [
      'system',
      'Jonas',
      'I agree, the starter plan price stays at nine euros per seat until spring.',
    ],
    ['system', 'Jonas', 'Customers on annual billing get fifteen percent off.'],
    ['mic', null, 'Great, I will update the pricing page this week.'],
  ]),
  ...lines('m-roadmap', 'rm', [
    ['system', 'Lea', 'The mobile app beta opens to customers on the third of March.'],
    ['mic', null, 'What about offline mode for the mobile app?'],
    ['system', 'Lea', 'Offline mode slips to the summer release, the sync engine needs more work.'],
  ]),
  ...lines('m-1on1', 'oo', [
    ['mic', null, 'How are things going on your side this week?'],
    [
      'system',
      'Priya',
      'I would love help preparing the on-call handbook before I join the rotation.',
    ],
    ['system', 'Priya', 'I also submitted a talk proposal for the conference.'],
  ]),
  ...lines('m-theo', 'tp', [
    ['mic', null, 'Thinking out loud: the starter plan price could go to thirty euros per seat.'],
  ]),
];

const world: ChatWorld = {
  users: {
    [MIRA]: { name: 'Mira', memberships: { [TEAM]: 'owner' } },
    [THEO]: { name: 'Theo', memberships: { [TEAM]: 'member' } },
  },
  documents,
  meetings,
  segments,
};

export const CHAT_FIXTURES: readonly ChatFixture[] = [
  {
    id: 'starter-price',
    description:
      'Workspace chat: a decision from a transcript; a teammate’s private note says otherwise.',
    world,
    asUser: MIRA,
    scope: { kind: 'workspace', workspaceId: TEAM },
    question: 'What starter plan price per seat did we agree on?',
    now: '2026-11-14T10:00:00Z',
    expect: {
      mustMention: [{ id: 'nine-euros', match: /nine euros/i }],
      mustNotMention: [{ id: 'theo-thirty', match: /thirty euros/i }],
      citeOneOf: ['seg:pr-1', 'seg:pr-2', 'block:pr-b1'],
    },
  },
  {
    id: 'mobile-beta',
    description: 'Workspace chat: a date that appears in both notes and transcript.',
    world,
    asUser: MIRA,
    scope: { kind: 'workspace', workspaceId: TEAM },
    question: 'When does the mobile app beta open to customers?',
    now: '2026-11-14T10:00:00Z',
    expect: {
      mustMention: [{ id: 'third-of-march', match: /third of March/i }],
      citeOneOf: ['seg:rm-1', 'block:rm-b1'],
    },
  },
  {
    id: 'one-on-one-help',
    description: 'Document chat on a 1:1: what the report asked for, from that note only.',
    world,
    asUser: MIRA,
    scope: { kind: 'document', workspaceId: TEAM, documentId: 'doc-1on1' },
    question: 'What did Priya want help with in the on-call rotation?',
    now: '2026-11-14T10:00:00Z',
    expect: {
      mustMention: [{ id: 'on-call-handbook', match: /on-call handbook/i }],
      mustNotMention: [{ id: 'other-meetings', match: /nine euros|mobile app/i }],
      citeOneOf: ['seg:oo-2', 'block:oo-b1'],
    },
  },
];
