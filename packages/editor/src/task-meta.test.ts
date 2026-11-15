import type { JSONContent } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';

import { renderDocumentHtml } from './html.ts';
import { createExtensions, ensureBlockIds, getEditorSchema, validateDoc } from './index.ts';
import { fromMarkdown, toMarkdown } from './markdown.ts';
import { parseTaskMetaSuffix } from './markdown/shared.ts';
import { addDays, daysUntil, dueState, formatDue, nextMonday } from './task-dates.ts';
import {
  cleanOwnerName,
  formatTaskMeta,
  isIsoDate,
  normalizeTaskOwner,
  taskMetaOf,
  taskOwnerError,
} from './task-meta.ts';

const p = (text: string): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
const task = (text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'taskItem',
  attrs: { checked: false, ...attrs },
  content: [p(text)],
});
const tasks = (...items: JSONContent[]): JSONContent => ({
  type: 'doc',
  content: [{ type: 'taskList', content: items }],
});

/** The task items' (text, checked, owner, due) after a schema round trip. */
function taskSummary(doc: JSONContent) {
  const out: { text: string; checked: boolean; owner: unknown; due: unknown }[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === 'taskItem') {
      const first = node.content?.[0];
      out.push({
        text: (first?.content ?? []).map((c) => c.text ?? '').join(''),
        checked: node.attrs?.checked === true,
        owner: node.attrs?.owner ?? null,
        due: node.attrs?.due ?? null,
      });
    }
    node.content?.forEach(visit);
  };
  visit(getEditorSchema().nodeFromJSON(doc).toJSON() as JSONContent);
  return out;
}

describe('task meta values', () => {
  it('accepts real calendar days only', () => {
    expect(isIsoDate('2026-11-20')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-1',
      '20261120',
      '2026-11-20T00:00',
      1,
      null,
    ]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });

  it('validates owners: name required, one line, only known keys', () => {
    expect(taskOwnerError(null)).toBeUndefined();
    expect(taskOwnerError({ name: 'Dana Lee' })).toBeUndefined();
    expect(
      taskOwnerError({ name: 'Dana', email: 'dana@example.com', userId: 'u1' }),
    ).toBeUndefined();
    expect(taskOwnerError({ name: '' })).toMatch(/name/);
    expect(taskOwnerError({ name: 'Dana\nLee' })).toMatch(/name/);
    expect(taskOwnerError({ name: ' Dana' })).toMatch(/name/);
    expect(taskOwnerError({ name: 'Dana', email: 'nope' })).toMatch(/email/);
    expect(taskOwnerError({ name: 'Dana', role: 'admin' })).toMatch(/role/);
    expect(taskOwnerError('Dana')).toMatch(/object/);
    expect(taskOwnerError({ name: 'x'.repeat(201) })).toMatch(/name/);
  });

  it('normalises untrusted owners', () => {
    expect(normalizeTaskOwner({ name: '  Dana \n Lee ', email: 'bad', userId: '', x: 1 })).toEqual({
      name: 'Dana Lee',
    });
    expect(normalizeTaskOwner({ name: '   ' })).toBeNull();
    expect(normalizeTaskOwner('Dana')).toBeNull();
    expect(cleanOwnerName('a b')).toBe('a b');
  });

  it('formats the shared text form', () => {
    expect(formatTaskMeta({ owner: { name: 'Dana' }, due: '2026-11-20' })).toBe(
      '@Dana, due 2026-11-20',
    );
    expect(formatTaskMeta({ owner: { name: 'Dana' }, due: null })).toBe('@Dana');
    expect(formatTaskMeta({ owner: null, due: '2026-11-20' })).toBe('due 2026-11-20');
    expect(formatTaskMeta(taskMetaOf({ owner: { name: '' }, due: 'Friday' }))).toBe('');
  });
});

describe('taskItem owner/due attributes', () => {
  it('default to null and validate', () => {
    const doc = tasks(task('Send the deck'));
    const full = getEditorSchema().nodeFromJSON(doc).toJSON() as JSONContent;
    expect(full.content![0]!.content![0]!.attrs).toMatchObject({ owner: null, due: null });
    expect(validateDoc(full)).toEqual({ ok: true });
    expect(
      validateDoc(tasks(task('x', { owner: { name: 'Dana', userId: 'u1' }, due: '2026-11-20' }))),
    ).toEqual({ ok: true });
  });

  it('are refused by validateDoc when malformed', () => {
    const bad = [
      { owner: { name: 'Dana', isAdmin: true } },
      { owner: 'Dana' },
      { owner: { name: '' } },
      { due: 'Friday' },
      { due: '2026-02-30' },
    ];
    for (const attrs of bad) {
      const result = validateDoc(tasks(task('x', attrs)));
      expect(result.ok, JSON.stringify(attrs)).toBe(false);
    }
  });

  it('survive HTML (copy-paste inside the editor) and the parser ignores the visible meta text', () => {
    const extensions = createExtensions({ placeholder: false });
    const doc = tasks(
      task('Send the deck', {
        owner: { name: 'Dana Lee', email: 'dana@example.com' },
        due: '2026-11-20',
      }),
    );
    const html = generateHTML(doc, extensions);
    expect(html).toContain('data-task-meta');
    expect(html).toContain('@Dana Lee, due 2026-11-20');
    const back = generateJSON(html, extensions) as JSONContent;
    expect(taskSummary(back)).toEqual([
      {
        text: 'Send the deck',
        checked: false,
        owner: { name: 'Dana Lee', email: 'dana@example.com' },
        due: '2026-11-20',
      },
    ]);
  });

  it('drop malformed data-owner / data-due on paste', () => {
    const extensions = createExtensions({ placeholder: false });
    const html =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-owner="{oops" data-due="Friday"><label><input type="checkbox"></label><div><p>x</p></div></li></ul>';
    expect(taskSummary(generateJSON(html, extensions) as JSONContent)).toEqual([
      { text: 'x', checked: false, owner: null, due: null },
    ]);
  });

  it('show as text in the share view without the owner email or user id', () => {
    const html = renderDocumentHtml(
      ensureBlockIds(
        tasks(
          task('Send the deck', {
            owner: { name: 'Dana', email: 'dana@example.com', userId: 'user_123' },
            due: '2026-11-20',
          }),
        ),
      ),
    );
    expect(html).toContain('<span data-task-meta>@Dana, due 2026-11-20</span>');
    expect(html).not.toContain('dana@example.com');
    expect(html).not.toContain('user_123');
    expect(html).not.toContain('data-owner');
  });
});

describe('task meta in Markdown', () => {
  it('emits (@Owner, due …) after the task text', () => {
    const md = toMarkdown(
      tasks(
        task('Send the deck', { owner: { name: 'Dana Lee' }, due: '2026-11-20' }),
        task('Book a room', { owner: { name: 'Sam' }, checked: true }),
        task('Draft the memo', { due: '2026-12-01' }),
        task('Plain'),
      ),
    );
    expect(md).toBe(
      [
        '- [ ] Send the deck (@Dana Lee, due 2026-11-20)',
        '- [x] Book a room (@Sam)',
        '- [ ] Draft the memo (due 2026-12-01)',
        '- [ ] Plain',
      ].join('\n'),
    );
  });

  it('round-trips owner name and due (email / user id are not in Markdown)', () => {
    const doc = tasks(
      task('Send the deck', { owner: { name: 'Dana Lee', email: 'd@x.io' }, due: '2026-11-20' }),
      task('Book a room', { owner: { name: 'Sam' }, checked: true }),
      task('Draft the memo', { due: '2026-12-01' }),
      task('', { owner: { name: 'Nobody' } }),
      task('Plain'),
    );
    const md = toMarkdown(doc);
    const back = fromMarkdown(md);
    expect(validateDoc(back)).toEqual({ ok: true });
    expect(taskSummary(back)).toEqual([
      { text: 'Send the deck', checked: false, owner: { name: 'Dana Lee' }, due: '2026-11-20' },
      { text: 'Book a room', checked: true, owner: { name: 'Sam' }, due: null },
      { text: 'Draft the memo', checked: false, owner: null, due: '2026-12-01' },
      { text: '', checked: false, owner: { name: 'Nobody' }, due: null },
      { text: 'Plain', checked: false, owner: null, due: null },
    ]);
    expect(toMarkdown(back)).toBe(md);
  });

  it('keeps the suffix before block markers', () => {
    const doc = ensureBlockIds(
      tasks(task('Send', { owner: { name: 'Dana' }, due: '2026-11-20', origin: 'ai' })),
    );
    const md = toMarkdown(doc, { blockIds: true, includeOrigin: true });
    expect(md).toMatch(/^- \[ \] Send \(@Dana, due 2026-11-20\) <!-- id=[\w-]+ -->$/);
    const back = fromMarkdown(md, { trustMarkers: true, preserveIds: true });
    expect(taskSummary(back)[0]).toMatchObject({ text: 'Send', owner: { name: 'Dana' } });
  });

  it('escapes names so they cannot end the suffix or add structure', () => {
    const tricky = ['Dana (PM), Lee', 'A) (@B', '*bold* [x](y) <b>', '# heading'];
    for (const name of tricky) {
      const doc = tasks(task('Do it', { owner: { name }, due: '2026-11-20' }));
      const back = fromMarkdown(toMarkdown(doc));
      expect(taskSummary(back), name).toEqual([
        { text: 'Do it', checked: false, owner: { name }, due: '2026-11-20' },
      ]);
    }
  });

  it('text that merely looks like a suffix stays text', () => {
    for (const text of ['Call (due 2026-01-01)', 'Ping (@Sam)', '(@Sam)']) {
      const doc = tasks(task(text));
      const md = toMarkdown(doc);
      const back = fromMarkdown(md);
      expect(taskSummary(back), md).toEqual([{ text, checked: false, owner: null, due: null }]);
      expect(toMarkdown(back)).toBe(md);
    }
    // …and with real meta after it.
    const doc = tasks(task('Ping (@Sam)', { owner: { name: 'Dana' } }));
    expect(taskSummary(fromMarkdown(toMarkdown(doc)))[0]).toMatchObject({
      text: 'Ping (@Sam)',
      owner: { name: 'Dana' },
    });
  });

  it('reads hand-written suffixes; an impossible date stays text; plain lists ignore them', () => {
    expect(taskSummary(fromMarkdown('- [ ] Ship it (@Priya, due 2026-11-20)'))).toEqual([
      { text: 'Ship it', checked: false, owner: { name: 'Priya' }, due: '2026-11-20' },
    ]);
    expect(taskSummary(fromMarkdown('- [ ] Ship it (due 2026-02-30)'))).toEqual([
      { text: 'Ship it (due 2026-02-30)', checked: false, owner: null, due: null },
    ]);
    const bullet = fromMarkdown('- Ship it (@Priya)');
    expect(JSON.stringify(bullet)).toContain('Ship it (@Priya)');
  });

  it('suffix detection stays fast on hostile input (no regex blow-up)', () => {
    const start = performance.now();
    for (const source of [
      `x${' '.repeat(100_000)}y`,
      `x${' ('.repeat(50_000)}y`,
      `x${' (@a'.repeat(50_000)}y`,
      `x${' (@a, due 2026-11-20'.repeat(10_000)}`,
    ]) {
      expect(parseTaskMetaSuffix(source)).toBeUndefined();
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('task due dates', () => {
  const today = '2026-11-18'; // a Wednesday
  it('does calendar arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysUntil('2026-11-20', today)).toBe(2);
    expect(nextMonday(today)).toBe('2026-11-23');
    expect(nextMonday('2026-11-23')).toBe('2026-11-30');
  });

  it('classifies and labels', () => {
    expect(dueState('2026-11-17', today)).toBe('overdue');
    expect(dueState(today, today)).toBe('today');
    expect(dueState('2026-11-25', today)).toBe('soon');
    expect(dueState('2026-11-26', today)).toBe('later');
    expect(formatDue(today, today, 'en-US')).toBe('Today');
    expect(formatDue('2026-11-19', today, 'en-US')).toBe('Tomorrow');
    expect(formatDue('2026-11-17', today, 'en-US')).toBe('Yesterday');
    expect(formatDue('2026-11-20', today, 'en-US')).toBe('Fri');
    expect(formatDue('2026-12-04', today, 'en-US')).toBe('Dec 4');
    expect(formatDue('2027-01-04', today, 'en-US')).toBe('Jan 4, 2027');
  });
});
