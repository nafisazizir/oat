import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { CheckResult, EvalMode, EvalSuite, FixtureResult, SuiteResult } from './types.ts';

export interface RunSuiteOptions {
  mode: EvalMode;
  /** Real mode: the model the task calls. Mock mode uses `suite.mockModel(fixture)`. */
  model?: LanguageModelV4;
  /** Present only in real mode: enables the judge tier. */
  judgeModel?: LanguageModelV4;
  /** Runs per fixture (default 1); scores are averaged, a check passes only if it passed every run. */
  runs?: number;
  /** Passed to the task (real mode: 0). */
  temperature?: number;
  /** Called after each fixture (progress output). */
  onFixture?: (result: FixtureResult) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Mean score per check id over runs (first-seen order); `pass` only if every run passed; details deduped. */
export function averageChecks(runs: readonly CheckResult[][]): CheckResult[] {
  const byId = new Map<string, CheckResult[]>();
  for (const run of runs) {
    for (const c of run) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  }
  return [...byId.values()].map((cs) => {
    const first = cs[0]!;
    // A check missing from some run (e.g. the judge threw) counts as 0 for that run.
    const score = cs.reduce((sum, c) => sum + c.score, 0) / runs.length;
    const details = [...new Set(cs.map((c) => c.detail).filter(Boolean))];
    return {
      id: first.id,
      tier: first.tier,
      score,
      pass: cs.length === runs.length && cs.every((c) => c.pass),
      ...(details.length ? { detail: details.join(' | ') } : {}),
    };
  });
}

/** Runs every fixture of a suite sequentially: task → deterministic scorers → judge (real mode only). */
export async function runSuite(suite: EvalSuite, options: RunSuiteOptions): Promise<SuiteResult> {
  const { mode, judgeModel, temperature } = options;
  const runs = Math.max(1, Math.floor(options.runs ?? 1));
  if (mode === 'real' && !options.model) throw new Error('real mode needs a model');
  const fixtures: FixtureResult[] = [];
  let modelId = '';
  for (const fixture of suite.fixtures) {
    const started = performance.now();
    const errors: string[] = [];
    const perRun: CheckResult[][] = [];
    for (let run = 0; run < runs; run++) {
      const model = mode === 'real' ? options.model! : suite.mockModel(fixture);
      modelId ||= model.modelId;
      const tag = runs > 1 ? ` (run ${run + 1})` : '';
      let output: unknown;
      try {
        output = await suite.run(fixture, { mode, model, temperature });
      } catch (error) {
        errors.push(`task${tag}: ${message(error)}`);
      }
      const checks = suite.score(fixture, output);
      if (judgeModel && suite.judge) {
        try {
          checks.push(...(await suite.judge(fixture, output, judgeModel)));
        } catch (error) {
          errors.push(`judge${tag}: ${message(error)}`);
        }
      }
      perRun.push(checks);
    }
    const result: FixtureResult = {
      id: fixture.id,
      checks: averageChecks(perRun),
      durationMs: Math.round(performance.now() - started),
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
    fixtures.push(result);
    options.onFixture?.(result);
  }
  return {
    suite: suite.name,
    mode,
    model: modelId,
    ...(judgeModel ? { judgeModel: judgeModel.modelId } : {}),
    runs,
    fixtures,
  };
}

/** Structural failures and task/judge errors: these fail the eval regardless of the baseline. */
export function hardFailures(results: readonly SuiteResult[]): string[] {
  return results.flatMap((r) =>
    r.fixtures.flatMap((f) => [
      ...(f.error ? [`${r.suite}/${f.id}: ${f.error}`] : []),
      ...f.checks
        .filter((c) => c.tier === 'structural' && !c.pass)
        .map((c) => `${r.suite}/${f.id} ${c.id}: ${c.detail ?? 'failed'}`),
    ]),
  );
}
