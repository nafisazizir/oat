import type { LanguageModelV4 } from '@ai-sdk/provider';

/**
 * - `structural`: deterministic contract checks (schema, headings, origin, notes coverage). Always run; any failure
 *   fails the eval.
 * - `property`: deterministic content checks (must-mention / must-not-mention / length). Always run; compared to
 *   the baseline (per check with the mock, per fixture tier mean with a real model).
 * - `judge`: LLM-as-judge quality checks. Only with `--model real` (D-13); compared like property.
 */
export type CheckTier = 'structural' | 'property' | 'judge';

export interface CheckResult {
  /** Stable within a fixture (baseline key), e.g. `headings`, `mention:backfill`. */
  id: string;
  tier: CheckTier;
  /** 0..1. */
  score: number;
  pass: boolean;
  detail?: string;
}

export type EvalMode = 'mock' | 'real';

export interface RunContext {
  mode: EvalMode;
  /** The model the task under test calls (in-process mock per fixture, or the real role model). */
  model: LanguageModelV4;
  /** Real mode: 0, for repeatability where the model supports it. */
  temperature?: number;
}

/** One kind of AI behaviour under evaluation (enhance now, chat in 6.5). */
export interface EvalSuite<F extends { id: string } = { id: string }> {
  name: string;
  fixtures: readonly F[];
  /** Role whose model the task uses with `--model real`. */
  role: 'enhance' | 'chat' | 'fast';
  /** Deterministic in-process model for `--model mock`. */
  mockModel(fixture: F): LanguageModelV4;
  /** The task under test: fixture → output (anything; scorers validate it). */
  run(fixture: F, ctx: RunContext): Promise<unknown>;
  /** Structural + property checks. Must cope with any output, including invalid ones. */
  score(fixture: F, output: unknown): CheckResult[];
  /** Judge-tier checks; called only with a real judge model. */
  judge?(fixture: F, output: unknown, judgeModel: LanguageModelV4): Promise<CheckResult[]>;
}

export interface FixtureResult {
  id: string;
  checks: CheckResult[];
  /** The task threw (all checks then score 0). */
  error?: string;
  durationMs: number;
}

export interface SuiteResult {
  suite: string;
  mode: EvalMode;
  /** Model id the task ran against. */
  model: string;
  /** Model id that judged (real mode only). */
  judgeModel?: string;
  /** Runs per fixture; check scores are the mean over runs. */
  runs: number;
  fixtures: FixtureResult[];
}
