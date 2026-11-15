import { type JSONContent, validateDoc } from '@oat/editor';
import { describe, expect, it } from 'vitest';

import { buildMeetingContext } from './context.ts';
import type { EnhanceOutput } from './enhance.ts';
import { enhancementToDoc } from './enhance-doc.ts';
import { myNotesOnly, noteLinesFromDoc, reconcileWithNotes } from './enhance-origin.ts';
import {
  meetingDay,
  mergeTaskPeople,
  resolveDueDate,
  resolveTaskOwner,
  taskMappingFromContext,
  type TaskPerson,
} from './enhance-tasks.ts';

const people: TaskPerson[] = [
  { name: 'Dana Lee', email: 'dana@acme.test', userId: 'u_dana' },
  { name: 'Sam Park', email: 'sam@acme.test', userId: 'u_sam' },
  { name: 'Sam Rivera', email: 'srivera@client.test' },
  { name: 'José Núñez', email: 'jose@client.test' },
];

describe('resolveTaskOwner', () => {
  it('matches exact names (case/accents ignored) and emails', () => {
    expect(resolveTaskOwner('Dana Lee', people)).toEqual({
      name: 'Dana Lee',
      email: 'dana@acme.test',
      userId: 'u_dana',
    });
    expect(resolveTaskOwner('dana lee', people)?.userId).toBe('u_dana');
    expect(resolveTaskOwner('Jose Nunez', people)).toEqual({
      name: 'José Núñez',
      email: 'jose@client.test',
    });
    expect(resolveTaskOwner('sam@acme.test', people)?.userId).toBe('u_sam');
    expect(resolveTaskOwner('@Dana Lee', people)?.userId).toBe('u_dana');
  });

  it('matches an unambiguous first name, last name, initial or email local part', () => {
    expect(resolveTaskOwner('Dana', people)?.userId).toBe('u_dana');
    expect(resolveTaskOwner('Lee', people)?.userId).toBe('u_dana');
    expect(resolveTaskOwner('Dana L.', people)?.userId).toBe('u_dana');
    expect(resolveTaskOwner('srivera', people)?.email).toBe('srivera@client.test');
    expect(resolveTaskOwner('Sam P', people)?.userId).toBe('u_sam');
  });

  it('matches partial names only among the meeting’s people (never an absent member)', () => {
    const members: TaskPerson[] = [
      { name: 'Sam Park', email: 'sam@acme.test', userId: 'u_sam' },
      { name: 'Dana Lee', email: 'dana@acme.test', userId: 'u_dana' },
    ];
    // Sam Park is a member but not in this meeting; the attendee Sam is external.
    const inMeeting: TaskPerson[] = [
      { name: 'Dana Lee', email: 'dana@acme.test', userId: 'u_dana' },
      { name: 'Sam Rivera', email: 'srivera@client.test' },
    ];
    const all = mergeTaskPeople(members, inMeeting);
    expect(resolveTaskOwner('Sam', all, inMeeting)).toEqual({
      name: 'Sam Rivera',
      email: 'srivera@client.test',
    });
    expect(resolveTaskOwner('Park', all, inMeeting)).toEqual({ name: 'Park' });
    expect(resolveTaskOwner('sam', all, [inMeeting[0]!])).toEqual({ name: 'sam' });
    // An attending member keeps their user id on a partial match.
    expect(resolveTaskOwner('Dana', all, inMeeting)?.userId).toBe('u_dana');
    // Email and exact full name still reach any member.
    expect(resolveTaskOwner('Sam Park', all, inMeeting)?.userId).toBe('u_sam');
    expect(resolveTaskOwner('sam@acme.test', all, inMeeting)?.userId).toBe('u_sam');
  });

  it('keeps the name when nobody or several people match', () => {
    expect(resolveTaskOwner('Sam', people)).toEqual({ name: 'Sam' });
    expect(resolveTaskOwner('Riley', people)).toEqual({ name: 'Riley' });
    expect(resolveTaskOwner('riley@else.test', people)).toEqual({
      name: 'riley@else.test',
      email: 'riley@else.test',
    });
    expect(resolveTaskOwner('  Riley\nSmith ', [])).toEqual({ name: 'Riley Smith' });
    expect(resolveTaskOwner('', people)).toBeNull();
    expect(resolveTaskOwner(undefined, people)).toBeNull();
  });

  it('merges people by email: an attendee who is a member gets the user id', () => {
    const merged = mergeTaskPeople(
      [{ name: 'Dana Lee', email: 'DANA@acme.test', userId: 'u_dana' }],
      [
        { name: 'Dana', email: 'dana@acme.test' },
        { name: '', email: 'x@y.test' },
        { name: '', email: null },
      ],
    );
    expect(merged).toEqual([
      { name: 'Dana Lee', email: 'DANA@acme.test', userId: 'u_dana' },
      { name: 'x', email: 'x@y.test', userId: null },
    ]);
  });
});

describe('resolveDueDate', () => {
  const base = '2026-11-18'; // Wednesday
  it.each([
    ['2026-11-20', '2026-11-20'],
    ['by 2026-12-01', '2026-12-01'],
    ['today', base],
    ['end of day', base],
    ['EOD', base],
    ['tomorrow', '2026-11-19'],
    ['day after tomorrow', '2026-11-20'],
    ['Friday', '2026-11-20'],
    ['by Friday', '2026-11-20'],
    ['next Tuesday', '2026-11-24'],
    ['Wednesday', '2026-11-25'],
    ['this Wednesday', '2026-11-18'],
    ['next Wednesday', '2026-11-25'],
    ['Feb 29', '2028-02-29'],
    ['fri', '2026-11-20'],
    ['end of week', '2026-11-20'],
    ['EOW', '2026-11-20'],
    ['next week', '2026-11-23'],
    ['end of month', '2026-11-30'],
    ['in 3 days', '2026-11-21'],
    ['in two weeks', '2026-12-02'],
    ['Nov 20', '2026-11-20'],
    ['November 20th', '2026-11-20'],
    ['20 November', '2026-11-20'],
    ['Jan 5', '2027-01-05'],
    ['March 3, 2027', '2027-03-03'],
  ])('%s → %s', (phrase, expected) => {
    expect(resolveDueDate(phrase, base)).toBe(expected);
  });

  it.each(['after the offsite', 'soon', 'Q1', 'Feb 30', 'ASAP', '11/20', '2026-02-30'])(
    '%s → null',
    (phrase) => {
      expect(resolveDueDate(phrase, base)).toBeNull();
    },
  );

  it('needs the meeting day for relative phrases', () => {
    expect(resolveDueDate('Friday', null)).toBeNull();
    expect(resolveDueDate('2026-11-20', null)).toBe('2026-11-20');
  });

  it('takes the meeting day in its own time zone', () => {
    expect(meetingDay('2026-11-19T02:00:00Z', 'America/Los_Angeles')).toBe('2026-11-18');
    expect(meetingDay('2026-11-19T02:00:00Z', 'UTC')).toBe('2026-11-19');
    expect(meetingDay('2026-11-19T02:00:00Z', 'Not/AZone')).toBe('2026-11-19');
    expect(meetingDay('nope')).toBeNull();
  });
});

describe('enhancementToDoc task mapping (8.4)', () => {
  const notes: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: {
              checked: false,
              owner: { name: 'Sam Park', userId: 'u_sam' },
              due: '2026-12-01',
            },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'book the venue' }] }],
          },
        ],
      },
    ],
  };
  const output: EnhanceOutput = {
    sections: [
      {
        heading: 'Next steps',
        blocks: [
          { kind: 'task', text: 'book the venue', origin: 'me', owner: 'Riley', due: 'today' },
          { kind: 'task', text: 'Send the deck', origin: 'ai', owner: 'Dana', due: 'Friday' },
          {
            kind: 'task',
            text: 'Draft pricing',
            origin: 'ai',
            owner: 'Sam',
            due: 'after the offsite',
          },
          { kind: 'task', text: 'Follow up', origin: 'ai' },
          { kind: 'task', text: 'Order lunch', origin: 'ai', owner: 'Riley' },
        ],
      },
    ],
  };

  const context = buildMeetingContext({
    meeting: { title: 'Sync', startedAt: '2026-11-18T16:00:00Z', endedAt: null, platform: null },
    attendees: [{ name: 'Sam Rivera', email: 'srivera@client.test' }],
    me: { name: 'Dana Lee', email: 'dana@acme.test' },
    notesDoc: notes,
    segments: [],
    aboutMe: null,
    locale: 'en-US',
    timeZone: 'UTC',
    vocabulary: [],
    sectionCount: 1,
  });
  const mapping = taskMappingFromContext(context, [
    { name: 'Dana Lee', email: 'dana@acme.test', userId: 'u_dana' },
    { name: 'Sam Park', email: 'sam@acme.test', userId: 'u_sam' },
    // A member who wasn't in the meeting, sharing an attendee's first name.
    { name: 'Riley Stone', email: 'riley.stone@acme.test', userId: 'u_riley' },
  ]);

  const reconciled = reconcileWithNotes(output, noteLinesFromDoc(notes));
  const { doc } = enhancementToDoc(reconciled.output, {
    sourceLine: reconciled.sourceLine,
    tasks: mapping,
  });
  const items = doc.content![1]!.content!;

  it('builds a valid document', () => {
    expect(validateDoc(doc)).toEqual({ ok: true });
    expect(mapping.meetingDay).toBe('2026-11-18');
  });

  it('keeps the owner/due I set on my own task (the model cannot change them)', () => {
    expect(items[0]!.attrs).toMatchObject({
      origin: 'me',
      owner: { name: 'Sam Park', userId: 'u_sam' },
      due: '2026-12-01',
    });
  });

  it('resolves AI task owners to members and relative dues to days', () => {
    expect(items[1]!.attrs).toMatchObject({
      origin: 'ai',
      owner: { name: 'Dana Lee', email: 'dana@acme.test', userId: 'u_dana' },
      due: '2026-11-20',
    });
    expect(items[1]!.content![0]!.content![0]!.text).toBe('Send the deck');
  });

  it('partial names match the meeting’s people only; undatable dues stay text', () => {
    // "Sam": the attendee Sam Rivera, not the member Sam Park who wasn't in the meeting.
    expect(items[2]!.attrs).toMatchObject({
      owner: { name: 'Sam Rivera', email: 'srivera@client.test' },
      due: null,
    });
    expect(items[2]!.attrs!.owner.userId).toBeUndefined();
    expect(items[2]!.content![0]!.content![0]!.text).toBe('Draft pricing — due after the offsite');
    expect(items[3]!.attrs).toMatchObject({ owner: null, due: null });
    // "Riley": only an absent member (Riley Stone) has that name → kept as a name, never their user id.
    expect(items[4]!.attrs).toMatchObject({ owner: { name: 'Riley' } });
  });

  it('re-enhancing keeps my task attributes in the notes snapshot', () => {
    const mine = myNotesOnly(doc)!;
    const task = mine.content![0]!.content![0]!;
    expect(task.attrs).toMatchObject({
      owner: { name: 'Sam Park', userId: 'u_sam' },
      due: '2026-12-01',
    });
  });
});
