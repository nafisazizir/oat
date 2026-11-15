import { describe, expect, it, vi } from 'vitest';

import {
  type AutosaveState,
  NoteAutosave,
  type NoteBase,
  type NotePatch,
} from './note-autosave.ts';

const BASE: NoteBase = { title: 'Standup', contentJson: { type: 'doc', content: [] } };

function harness(fail = () => false) {
  const saved: NotePatch[] = [];
  const states: AutosaveState[] = [];
  const delays: number[] = [];
  let timer: (() => void) | null = null;
  const autosave = new NoteAutosave({
    base: BASE,
    save: async (patch) => {
      if (fail()) throw new Error('disk full');
      saved.push(patch);
    },
    onState: (s) => states.push(s),
    setTimer: (fn, ms) => {
      delays.push(ms);
      return (timer = fn);
    },
    clearTimer: () => (timer = null),
  });
  return { autosave, saved, states, delays, fire: () => timer?.(), armed: () => timer !== null };
}

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('NoteAutosave', () => {
  it('each save carries the base it builds on; a conflict drops the base until the next rebase', async () => {
    const bases: NoteBase[] = [];
    let conflictNext = false;
    const conflicts: unknown[] = [];
    const autosave = new NoteAutosave({
      base: BASE,
      save: async (_patch, base) => {
        bases.push(base);
        return conflictNext ? { conflict: { documentId: 'copy' } } : { conflict: null };
      },
      onConflict: (c) => conflicts.push(c),
      setTimer: () => null,
      clearTimer: () => {},
    });
    autosave.queue({ contentJson: doc('a') });
    await autosave.flush();
    autosave.queue({ title: '  New   title ' });
    await autosave.flush();
    expect(bases).toEqual([BASE, { title: 'Standup', contentJson: doc('a') }]);
    expect(autosave.base).toEqual({ title: 'New title', contentJson: doc('a') });

    conflictNext = true;
    autosave.queue({ contentJson: doc('b') });
    await autosave.flush();
    expect(conflicts).toEqual([{ documentId: 'copy' }]);
    expect(autosave.base).toBeNull();
    autosave.rebase({ title: 'Theirs', contentJson: doc('web') });
    conflictNext = false;
    autosave.queue({ contentJson: doc('web + mine') });
    await autosave.flush();
    expect(bases.at(-1)).toEqual({ title: 'Theirs', contentJson: doc('web') });
  });

  it('a failed write retries by itself with backoff until it lands', async () => {
    let failing = 3;
    const h = harness(() => failing-- > 0);
    h.autosave.queue({ title: 'Kept' });
    await h.autosave.flush();
    expect(h.states.at(-1)).toBe('error');
    expect(h.delays.at(-1)).toBe(1_000);
    for (const delay of [2_000, 4_000]) {
      h.fire();
      await vi.waitFor(() => expect(h.delays.at(-1)).toBe(delay));
    }
    expect(h.saved).toEqual([]);
    h.fire();
    await vi.waitFor(() => expect(h.saved).toEqual([{ title: 'Kept' }]));
    expect(h.states.at(-1)).toBe('saved');
    expect(h.autosave.dirty).toBe(false);
    expect(h.delays).toEqual([400, 1_000, 2_000, 4_000]); // no retry after it landed
  });

  it('after dispose no retry is scheduled (a last flush still writes)', async () => {
    let failing = true;
    const h = harness(() => failing);
    h.autosave.queue({ title: 'x' });
    h.autosave.dispose();
    await h.autosave.flush();
    expect(h.delays).toEqual([400]); // no retry scheduled
    failing = false;
    await h.autosave.flush();
    expect(h.saved).toEqual([{ title: 'x' }]);
  });

  it('merges edits into one write after the delay', async () => {
    const h = harness();
    h.autosave.queue({ contentJson: doc('a') });
    h.autosave.queue({ title: 'T' });
    h.autosave.queue({ contentJson: doc('ab') });
    expect(h.autosave.dirty).toBe(true);
    h.fire();
    await h.autosave.flush();
    expect(h.saved).toEqual([{ title: 'T', contentJson: doc('ab') }]);
    expect(h.autosave.dirty).toBe(false);
    expect(h.states.at(-1)).toBe('saved');
  });

  it('flush writes at once; nothing pending is a no-op', async () => {
    const h = harness();
    await h.autosave.flush();
    expect(h.saved).toEqual([]);
    h.autosave.queue({ title: 'Now' });
    await h.autosave.flush();
    expect(h.saved).toEqual([{ title: 'Now' }]);
  });

  it('keeps a failed patch and retries it with newer edits on top', async () => {
    let failing = true;
    const h = harness(() => failing);
    h.autosave.queue({ title: 'Old', contentJson: doc('x') });
    await h.autosave.flush();
    expect(h.states.at(-1)).toBe('error');
    expect(h.autosave.dirty).toBe(true);
    failing = false;
    h.autosave.queue({ title: 'New' });
    await h.autosave.flush();
    expect(h.saved).toEqual([{ title: 'New', contentJson: doc('x') }]);
    expect(h.autosave.dirty).toBe(false);
  });

  it('an edit during a write is written next, not lost', async () => {
    let release!: () => void;
    const saved: NotePatch[] = [];
    const autosave = new NoteAutosave({
      base: BASE,
      save: (patch) =>
        new Promise<void>((resolve) => {
          saved.push(patch);
          release = resolve;
        }),
      setTimer: () => null,
      clearTimer: () => {},
    });
    autosave.queue({ title: 'one' });
    const first = autosave.flush();
    autosave.queue({ title: 'two' });
    const second = autosave.flush();
    release();
    await first;
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    release();
    await second;
    expect(saved).toEqual([{ title: 'one' }, { title: 'two' }]);
  });
});
