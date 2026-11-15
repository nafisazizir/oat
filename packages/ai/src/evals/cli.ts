/**
 * `pnpm --filter @oat/ai eval [--suite enhance] [--model mock|real] [--runs n] [--json out.json] [--tolerance n] [--verbose]`
 * `pnpm --filter @oat/ai eval:baseline [...]` (= `--update-baseline`)
 *
 * Exit codes: 0 ok · 1 structural failure, task/judge error or regression vs the baseline · 2 bad usage.
 * `--model real` without an AI Gateway key (or Vercel OIDC) runs the mock and skips the quality tier.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { AiEnv, LanguageRole } from '../models.ts';
import { createAi, resolveAiBackend } from '../provider.ts';
import {
  type Baseline,
  compareToBaseline,
  DEFAULT_TOLERANCE,
  parseBaseline,
  serializeBaseline,
  updateBaseline,
} from './baseline.ts';
import { formatReport } from './report.ts';
import { hardFailures, runSuite } from './runner.ts';
import type { EvalMode, EvalSuite, SuiteResult } from './types.ts';

/** Role whose model judges quality-tier checks with `--model real`. */
export const JUDGE_ROLE: LanguageRole = 'judge';

/** Real-mode sampling temperature for the task under test (the judge always uses 0). */
export const REAL_TEMPERATURE = 0;

export interface CliDeps {
  suites: Readonly<Record<string, EvalSuite>>;
  baselinePath: string;
  /** Default `process.env`. */
  env?: AiEnv;
  /** Base for a relative `--json` path. Default: `INIT_CWD` (where pnpm was invoked), else `process.cwd()`. */
  cwd?: string;
  /** Default `console.log`. */
  log?: (text: string) => void;
  /** Real-mode models (tests inject fakes). Default: `createAi({ env }).getModel`. */
  getModel?: (role: LanguageRole) => LanguageModelV4;
}

const USAGE = `Usage: eval [--suite <name>]... [--model mock|real] [--runs <n>] [--json <file>]
            [--tolerance <n>] [--update-baseline] [--verbose]`;

function realModeAvailable(env: AiEnv): boolean {
  try {
    return resolveAiBackend(env).kind === 'gateway';
  } catch {
    return false;
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((text: string) => console.log(text));

  let values;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        suite: { type: 'string', multiple: true },
        model: { type: 'string', default: 'mock' },
        json: { type: 'string' },
        tolerance: { type: 'string' },
        runs: { type: 'string', default: '1' },
        'update-baseline': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    log(`${USAGE}\nSuites: ${Object.keys(deps.suites).join(', ')}`);
    return 0;
  }
  if (values.model !== 'mock' && values.model !== 'real') {
    log(`--model must be "mock" or "real"\n${USAGE}`);
    return 2;
  }
  const names = values.suite ?? Object.keys(deps.suites);
  const unknown = names.filter((n) => !deps.suites[n]);
  if (unknown.length) {
    log(`unknown suite(s): ${unknown.join(', ')} (have ${Object.keys(deps.suites).join(', ')})`);
    return 2;
  }
  const tolerance = values.tolerance === undefined ? undefined : Number(values.tolerance);
  if (tolerance !== undefined && !(tolerance >= 0 && tolerance <= 1)) {
    log('--tolerance must be a number between 0 and 1');
    return 2;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    log('--runs must be an integer from 1 to 20');
    return 2;
  }

  const notices: string[] = [];
  let mode: EvalMode = values.model;
  if (mode === 'real' && !realModeAvailable(env)) {
    if (values['update-baseline']) {
      // Never let a real-baseline request silently rewrite the mock baseline.
      log(
        '--update-baseline --model real needs an AI key (AI_GATEWAY_API_KEY or Vercel OIDC); nothing written.',
      );
      return 2;
    }
    mode = 'mock';
    notices.push(
      '--model real requested but no AI key is configured (AI_GATEWAY_API_KEY or Vercel OIDC): ran against ' +
        'the mock instead. Quality tier (LLM judge) skipped.',
    );
  } else if (mode === 'mock') {
    notices.push(
      'Quality tier (LLM judge) skipped: running against the mock. Set AI_GATEWAY_API_KEY and pass ' +
        '--model real to run it (D-13).',
    );
  }
  const getModel = deps.getModel ?? ((role: LanguageRole) => createAi({ env }).getModel(role));

  const results: SuiteResult[] = [];
  for (const name of names) {
    const suite = deps.suites[name]!;
    if (mode === 'real') {
      const model = getModel(suite.role);
      const judgeModel = getModel(JUDGE_ROLE);
      if (judgeModel.modelId === model.modelId) {
        notices.push(
          `${name}: the judge is the model under test (${model.modelId}), so judge scores are self-graded. ` +
            'Set AI_MODEL_JUDGE to a different model.',
        );
      }
      results.push(
        await runSuite(suite, { mode, model, judgeModel, runs, temperature: REAL_TEMPERATURE }),
      );
    } else {
      results.push(await runSuite(suite, { mode, runs }));
    }
  }

  let baseline: Baseline | undefined;
  if (existsSync(deps.baselinePath)) {
    try {
      baseline = parseBaseline(readFileSync(deps.baselinePath, 'utf8'));
    } catch (error) {
      log(
        `invalid baseline ${deps.baselinePath}: ${error instanceof Error ? error.message : error}`,
      );
      return 2;
    }
  }
  const comparison = compareToBaseline(
    results,
    baseline,
    mode,
    tolerance ?? DEFAULT_TOLERANCE[mode],
  );
  const failures = hardFailures(results);
  log(formatReport(results, comparison, notices, { verbose: values.verbose }));

  if (values.json) {
    const path = resolve(deps.cwd ?? env.INIT_CWD ?? process.cwd(), values.json);
    writeFileSync(
      path,
      `${JSON.stringify({ mode, results, comparison, failures, notices }, null, 2)}\n`,
    );
    log(`Wrote ${path}`);
  }

  if (values['update-baseline']) {
    if (failures.length) {
      log(`Baseline not updated: ${failures.length} structural failure(s)/error(s).`);
      return 1;
    }
    writeFileSync(deps.baselinePath, serializeBaseline(updateBaseline(baseline, results, mode)));
    log(`Updated ${mode} baseline for ${names.join(', ')} → ${deps.baselinePath}`);
    return 0;
  }

  if (failures.length || comparison.regressions.length) {
    log(
      `FAIL: ${failures.length} structural failure(s)/error(s), ${comparison.regressions.length} regression(s).`,
    );
    return 1;
  }
  log('PASS');
  return 0;
}
