import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  compareToBaseline,
  parseBaseline,
  serializeBaseline,
  tierMeans,
  toRealBaseline,
  toScoreTable,
  updateBaseline,
} from './baseline.ts';
import type { CheckTier, SuiteResult } from './types.ts';

function result(
  scores: Record<string, Record<string, number>>,
  options: { suite?: string; mode?: 'mock' | 'real'; model?: string; judgeModel?: string } = {},
): SuiteResult {
  const { suite = 'enhance', mode = 'mock', model = 'm', judgeModel } = options;
  return {
    suite,
    mode,
    model,
    ...(judgeModel ? { judgeModel } : {}),
    runs: 1,
    fixtures: Object.entries(scores).map(([id, checks]) => ({
      id,
      durationMs: 1,
      checks: Object.entries(checks).map(([check, score]) => ({
        id: check,
        // `j…` checks are judge-tier, `s…` structural, the rest property.
        tier: (check.startsWith('j')
          ? 'judge'
          : check.startsWith('s')
            ? 'structural'
            : 'property') as CheckTier,
        score,
        pass: score === 1,
      })),
    })),
  };
}

const baseline: Baseline = {
  version: 1,
  mock: { enhance: { a: { x: 1, y: 0.5 }, b: { x: 0.8 } } },
};

describe('compareToBaseline (mock: per check)', () => {
  it('reports no regressions for identical scores', () => {
    const c = compareToBaseline([result({ a: { x: 1, y: 0.5 }, b: { x: 0.8 } })], baseline, 'mock');
    expect(c).toEqual({
      compared: ['enhance'],
      uncompared: [],
      regressions: [],
      improvements: [],
      added: 0,
    });
  });

  it('flags a drop beyond the tolerance, and ignores one within it', () => {
    const dropped = compareToBaseline(
      [result({ a: { x: 1, y: 0.25 }, b: { x: 0.79 } })],
      baseline,
      'mock',
      0.05,
    );
    expect(dropped.regressions).toEqual([
      { suite: 'enhance', fixture: 'a', check: 'y', baseline: 0.5, current: 0.25 },
    ]);
  });

  it('treats a missing fixture or check as a regression', () => {
    const c = compareToBaseline([result({ a: { x: 1 } })], baseline, 'mock');
    expect(c.regressions.map((r) => [r.fixture, r.check, r.current])).toEqual([
      ['a', 'y', null],
      ['b', 'x', null],
    ]);
  });

  it('counts improvements and new checks without failing', () => {
    const c = compareToBaseline(
      [result({ a: { x: 1, y: 1, z: 0 }, b: { x: 0.8 }, c: { x: 1 } })],
      baseline,
      'mock',
    );
    expect(c.regressions).toEqual([]);
    expect(c.improvements.map((r) => r.check)).toEqual(['y']);
    expect(c.added).toBe(2);
  });

  it('does not compare suites without a baseline', () => {
    expect(
      compareToBaseline([result({ a: { x: 0 } }, { suite: 'chat' })], baseline, 'mock'),
    ).toMatchObject({
      compared: [],
      uncompared: [{ suite: 'chat', reason: 'no mock baseline' }],
      regressions: [],
    });
    expect(compareToBaseline([result({ a: { x: 0 } })], undefined, 'mock').uncompared).toEqual([
      { suite: 'enhance', reason: 'no mock baseline' },
    ]);
  });
});

describe('compareToBaseline (real: tier means, keyed by models)', () => {
  const real = (scores: Record<string, Record<string, number>>, model = 'gw/task') =>
    result(scores, { mode: 'real', model, judgeModel: 'gw/judge' });
  // a: property mean 0.5, judge 1 · b: property 1, judge 0.5 · overall property 0.75, judge 0.75.
  const recorded = real({
    a: { s1: 1, p1: 1, p2: 0, j1: 1 },
    b: { s1: 1, p1: 1, p2: 1, j1: 0.5 },
  });
  const withReal: Baseline = { version: 1, real: { enhance: toRealBaseline(recorded) } };

  it('records models, runs and per-fixture/overall tier means (structural excluded)', () => {
    expect(withReal.real!.enhance).toEqual({
      model: 'gw/task',
      judgeModel: 'gw/judge',
      runs: 1,
      overall: { property: 0.75, judge: 0.75 },
      fixtures: { a: { property: 0.5, judge: 1 }, b: { property: 1, judge: 0.5 } },
    });
  });

  it('tolerates single-check swings that the per-check gate would flag', () => {
    // One property check flips 1 → 0 and another 0 → 1: the means don't move.
    const swung = real({
      a: { s1: 1, p1: 0, p2: 1, j1: 1 },
      b: { s1: 1, p1: 1, p2: 1, j1: 0.5 },
    });
    expect(compareToBaseline([swung], withReal, 'real').regressions).toEqual([]);
  });

  it('flags a tier mean that drops beyond the tolerance, per fixture and overall', () => {
    const worse = real({
      a: { s1: 1, p1: 1, p2: 0, j1: 0.5 },
      b: { s1: 1, p1: 1, p2: 1, j1: 0.5 },
    });
    expect(compareToBaseline([worse], withReal, 'real', 0.1).regressions).toEqual([
      { suite: 'enhance', fixture: 'all', check: 'tier:judge', baseline: 0.75, current: 0.5 },
      { suite: 'enhance', fixture: 'a', check: 'tier:judge', baseline: 1, current: 0.5 },
    ]);
  });

  it('does not compare a run with a different task or judge model', () => {
    const other = real({ a: { p1: 0 } }, 'gw/other');
    const c = compareToBaseline([other], withReal, 'real');
    expect(c.compared).toEqual([]);
    expect(c.regressions).toEqual([]);
    expect(c.uncompared[0]!.reason).toBe(
      'real baseline is for gw/task judged by gw/judge; this run is gw/other judged by gw/judge',
    );
    expect(compareToBaseline([recorded], baseline, 'real').uncompared).toEqual([
      { suite: 'enhance', reason: 'no real baseline' },
    ]);
  });
});

describe('baseline file', () => {
  it('rounds scores and round-trips through JSON', () => {
    const table = toScoreTable([result({ a: { x: 1 / 3 } })]);
    expect(table).toEqual({ enhance: { a: { x: 0.3333 } } });
    expect(tierMeans([{ id: 'x', tier: 'property', score: 1 / 3, pass: false }])).toEqual({
      property: 0.3333,
    });
    const next = updateBaseline(undefined, [result({ a: { x: 1 / 3 } })], 'mock');
    expect(parseBaseline(serializeBaseline(next))).toEqual(next);
  });

  it('replaces only the suites that ran, for the mode that ran', () => {
    const realEntry = toRealBaseline(
      result({ a: { j1: 0.9 } }, { mode: 'real', model: 't', judgeModel: 'j' }),
    );
    const start: Baseline = {
      version: 1,
      mock: { ...baseline.mock, chat: { q: { x: 1 } } },
      real: { enhance: realEntry },
    };
    const next = updateBaseline(start, [result({ a: { x: 0 } })], 'mock');
    expect(next.mock).toEqual({ enhance: { a: { x: 0 } }, chat: { q: { x: 1 } } });
    expect(next.real).toEqual(start.real);

    const nextReal = updateBaseline(
      start,
      [result({ a: { p: 0.5 } }, { mode: 'real', model: 't2', judgeModel: 'j' })],
      'real',
    );
    expect(nextReal.mock).toEqual(start.mock);
    expect(nextReal.real!.enhance!.model).toBe('t2');
  });

  it('refuses a real baseline without a judge model', () => {
    expect(() => toRealBaseline(result({ a: { p: 1 } }, { mode: 'real' }))).toThrow(/judge/);
  });

  it('rejects a malformed baseline', () => {
    expect(() => parseBaseline('{"version":2}')).toThrow();
    expect(() => parseBaseline('{"version":1,"mock":{"enhance":{"a":{"x":2}}}}')).toThrow();
    expect(() => parseBaseline('{"version":1,"real":{"enhance":{"model":"t"}}}')).toThrow();
  });
});
