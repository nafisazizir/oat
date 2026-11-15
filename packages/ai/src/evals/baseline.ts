/**
 * Committed baseline (`evals/baseline.json`).
 *
 * - `mock`: suite → fixture → check → score. The mock is deterministic, so every check is compared.
 * - `real`: suite → one entry recorded with a specific task model + judge model (and run count): per-fixture and
 *   overall **tier means** for `property` and `judge`. Real models are noisy and single checks move in big steps
 *   (0/0.5/1, 1/n), so only aggregates are gated; a run with different models is "not compared".
 *
 * Structural checks are never compared: they are an absolute gate in both modes.
 */
import { z } from 'zod';
import type { CheckResult, CheckTier, EvalMode, SuiteResult } from './types.ts';

const score = z.number().min(0).max(1);

const scoreTableSchema = z.record(z.string(), z.record(z.string(), z.record(z.string(), score)));
export type ScoreTable = z.infer<typeof scoreTableSchema>;

/** Tiers gated by tier mean in real mode. */
export const GATED_TIERS = ['property', 'judge'] as const satisfies readonly CheckTier[];
type GatedTier = (typeof GATED_TIERS)[number];

const tierMeansSchema = z.object({ property: score.optional(), judge: score.optional() });
export type TierMeans = z.infer<typeof tierMeansSchema>;

const realSuiteSchema = z.object({
  model: z.string().min(1),
  judgeModel: z.string().min(1),
  runs: z.int().positive(),
  overall: tierMeansSchema,
  fixtures: z.record(z.string(), tierMeansSchema),
});
export type RealSuiteBaseline = z.infer<typeof realSuiteSchema>;

export const baselineSchema = z.object({
  version: z.literal(1),
  mock: scoreTableSchema.optional(),
  real: z.record(z.string(), realSuiteSchema).optional(),
});
export type Baseline = z.infer<typeof baselineSchema>;

/** Default allowed drop (per check with the mock, per tier mean with a real model). */
export const DEFAULT_TOLERANCE: Readonly<Record<EvalMode, number>> = { mock: 0.01, real: 0.1 };

const round = (n: number) => Math.round(n * 1e4) / 1e4;

export function parseBaseline(json: string): Baseline {
  return baselineSchema.parse(JSON.parse(json));
}

export function serializeBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function toScoreTable(results: readonly SuiteResult[]): ScoreTable {
  return Object.fromEntries(
    results.map((r) => [
      r.suite,
      Object.fromEntries(
        r.fixtures.map((f) => [
          f.id,
          Object.fromEntries(f.checks.map((c) => [c.id, round(c.score)])),
        ]),
      ),
    ]),
  );
}

/** Mean score per gated tier (tiers without checks are omitted). */
export function tierMeans(checks: readonly CheckResult[]): TierMeans {
  const means: TierMeans = {};
  for (const tier of GATED_TIERS) {
    const scores = checks.filter((c) => c.tier === tier).map((c) => c.score);
    if (scores.length) means[tier] = round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
  return means;
}

export function toRealBaseline(result: SuiteResult): RealSuiteBaseline {
  if (!result.judgeModel) throw new Error(`${result.suite}: real baseline needs a judge model`);
  return {
    model: result.model,
    judgeModel: result.judgeModel,
    runs: result.runs,
    overall: tierMeans(result.fixtures.flatMap((f) => f.checks)),
    fixtures: Object.fromEntries(result.fixtures.map((f) => [f.id, tierMeans(f.checks)])),
  };
}

/** Replaces the suites that ran (for `mode`) and keeps everything else. */
export function updateBaseline(
  baseline: Baseline | undefined,
  results: readonly SuiteResult[],
  mode: EvalMode,
): Baseline {
  const next: Baseline = { version: 1, ...baseline };
  if (mode === 'mock') next.mock = { ...next.mock, ...toScoreTable(results) };
  else {
    next.real = {
      ...next.real,
      ...Object.fromEntries(results.map((r) => [r.suite, toRealBaseline(r)])),
    };
  }
  return next;
}

export interface Regression {
  suite: string;
  /** Fixture id, or `all` for a suite-wide tier mean. */
  fixture: string;
  /** Check id (mock) or `tier:<name>` (real). */
  check: string;
  baseline: number;
  /** `null`: the fixture or check no longer exists / produced no score. */
  current: number | null;
}

export interface Comparison {
  /** Suites that had a matching baseline for this mode and were compared. */
  compared: string[];
  /** Suites that ran but were not compared, with why. */
  uncompared: { suite: string; reason: string }[];
  regressions: Regression[];
  improvements: Regression[];
  /** Checks (or tier means) present now but not in the baseline. */
  added: number;
}

function compareEntries(
  comparison: Comparison,
  suite: string,
  expected: Readonly<Record<string, Readonly<Record<string, number | undefined>>>>,
  actual: Readonly<Record<string, Readonly<Record<string, number | undefined>>>>,
  tolerance: number,
) {
  for (const [fixture, checks] of Object.entries(expected)) {
    for (const [check, base] of Object.entries(checks)) {
      if (base === undefined) continue;
      const now = actual[fixture]?.[check];
      const entry = { suite, fixture, check, baseline: base, current: now ?? null };
      if (now === undefined || now < base - tolerance) comparison.regressions.push(entry);
      else if (now > base + tolerance) comparison.improvements.push(entry);
    }
  }
  for (const [fixture, checks] of Object.entries(actual)) {
    for (const [check, now] of Object.entries(checks)) {
      if (now !== undefined && expected[fixture]?.[check] === undefined) comparison.added++;
    }
  }
}

const prefixed = (means: TierMeans) =>
  Object.fromEntries(Object.entries(means).map(([tier, v]) => [`tier:${tier as GatedTier}`, v]));

export function compareToBaseline(
  results: readonly SuiteResult[],
  baseline: Baseline | undefined,
  mode: EvalMode,
  tolerance: number = DEFAULT_TOLERANCE[mode],
): Comparison {
  const comparison: Comparison = {
    compared: [],
    uncompared: [],
    regressions: [],
    improvements: [],
    added: 0,
  };
  const current = toScoreTable(results);
  for (const result of results) {
    if (mode === 'mock') {
      const expected = baseline?.mock?.[result.suite];
      if (!expected) {
        comparison.uncompared.push({ suite: result.suite, reason: 'no mock baseline' });
        continue;
      }
      comparison.compared.push(result.suite);
      compareEntries(comparison, result.suite, expected, current[result.suite] ?? {}, tolerance);
      continue;
    }
    const expected = baseline?.real?.[result.suite];
    if (!expected) {
      comparison.uncompared.push({ suite: result.suite, reason: 'no real baseline' });
      continue;
    }
    if (expected.model !== result.model || expected.judgeModel !== result.judgeModel) {
      comparison.uncompared.push({
        suite: result.suite,
        reason:
          `real baseline is for ${expected.model} judged by ${expected.judgeModel}; this run is ` +
          `${result.model} judged by ${result.judgeModel ?? '(none)'}`,
      });
      continue;
    }
    comparison.compared.push(result.suite);
    const actual = toRealBaseline(result);
    compareEntries(
      comparison,
      result.suite,
      {
        all: prefixed(expected.overall),
        ...Object.fromEntries(Object.entries(expected.fixtures).map(([f, m]) => [f, prefixed(m)])),
      },
      {
        all: prefixed(actual.overall),
        ...Object.fromEntries(Object.entries(actual.fixtures).map(([f, m]) => [f, prefixed(m)])),
      },
      tolerance,
    );
  }
  return comparison;
}
