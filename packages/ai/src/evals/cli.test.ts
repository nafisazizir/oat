import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_PATH, createSuites, ENHANCE_FIXTURES } from '../../evals/index.ts';
import { EVAL_TEMPLATES } from '../../evals/templates.ts';
import { type EnhanceFn, enhanceNotes } from '../enhance.ts';
import { createMockModel, promptText } from '../testing.ts';
import { parseBaseline } from './baseline.ts';
import { runCli } from './cli.ts';
import {
  createEnhanceSuite,
  type CreateEnhanceSuiteOptions,
  extractiveDraft,
  toEnhanceInput,
} from './enhance-suite.ts';
import type { EvalSuite } from './types.ts';

const NO_KEY = { NODE_ENV: 'test' };

async function cli(
  argv: string[],
  options: {
    suites?: Record<string, EvalSuite>;
    env?: Record<string, string>;
    baselinePath?: string;
    getModel?: Parameters<typeof runCli>[1]['getModel'];
  } = {},
) {
  const lines: string[] = [];
  const code = await runCli(argv, {
    suites: options.suites ?? createSuites(),
    baselinePath: options.baselinePath ?? BASELINE_PATH,
    env: options.env ?? NO_KEY,
    cwd: tmpdir(),
    log: (text) => lines.push(text),
    getModel:
      options.getModel ??
      (() => {
        throw new Error('real model requested');
      }),
  });
  return { code, out: lines.join('\n') };
}

/** The enhance suite with a different task / mock output (same fixtures and templates). */
const enhanceWith = (overrides: Partial<CreateEnhanceSuiteOptions>) => ({
  enhance: createEnhanceSuite({
    fixtures: ENHANCE_FIXTURES,
    templates: EVAL_TEMPLATES,
    ...overrides,
  }),
});

describe('eval harness (mock tier)', () => {
  it('runs every fixture offline: the stub passes the structural tier and matches the committed baseline', async () => {
    const { code, out } = await cli([]);
    expect(out).toMatch(/all\s+20\/20 pass/);
    expect(out).toContain('0 regression(s)');
    expect(out).toContain('Quality tier (LLM judge) skipped');
    expect(out).toMatch(/PASS$/);
    expect(code).toBe(0);
  });

  it('has a committed mock baseline covering every fixture', () => {
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
    expect(Object.keys(baseline.mock?.enhance ?? {}).sort()).toEqual(
      ENHANCE_FIXTURES.map((f) => f.id).sort(),
    );
  });

  it('detects a regression: weaker output fails against the committed baseline', async () => {
    // Keep the shape (structural tier still passes) but drop half of the AI-written content.
    const weaker = enhanceWith({
      mockOutput: (input) => {
        const draft = extractiveDraft(input);
        for (const s of draft.sections) {
          s.blocks = s.blocks.filter((b, i) => b.origin === 'me' || i % 2 === 0);
        }
        return draft;
      },
    });
    const { code, out } = await cli([], { suites: weaker });
    expect(code).toBe(1);
    expect(out).toMatch(/[1-9]\d* regression\(s\)/);
    expect(out).toMatch(/▼ enhance\/\S+ mention:\S+: 1\.00 → 0\.00/);
    expect(out).toMatch(/FAIL: 0 structural failure\(s\)\/error\(s\), [1-9]\d* regression\(s\)\.$/);

    // The tolerance is per check: allowing a full-point drop lets it through.
    const lenient = await cli(['--tolerance', '1'], { suites: weaker });
    expect(lenient.code).toBe(0);
  });

  it('fails on a structural failure even without a baseline', async () => {
    const wrongHeadings = enhanceWith({
      mockOutput: (input) => {
        const draft = extractiveDraft(input);
        draft.sections[0]!.heading = 'Something else';
        return draft;
      },
    });
    const { code, out } = await cli([], {
      suites: wrongHeadings,
      baselinePath: join(tmpdir(), 'no-such-baseline.json'),
    });
    expect(code).toBe(1);
    expect(out).toContain('Baseline: enhance not compared (no mock baseline).');
    expect(out).toMatch(/✗ one-on-one headings \(0\.75\): missing: Updates; extra: Something else/);
  });

  it('records a task that throws as an error and fails', async () => {
    const task: EnhanceFn = async () => {
      throw new Error('model unavailable');
    };
    const { code, out } = await cli(['--suite', 'enhance'], { suites: enhanceWith({ task }) });
    expect(code).toBe(1);
    expect(out).toContain('! interview: task: model unavailable');
  });

  it('feeds the in-process mock through the real enhance stub (prompt → structured output)', async () => {
    const seen: string[] = [];
    const task: EnhanceFn = (input, options) => {
      seen.push(options.model.modelId);
      return enhanceNotes(input, options);
    };
    const { code } = await cli([], { suites: enhanceWith({ task }) });
    expect(code).toBe(0);
    expect(new Set(seen)).toEqual(new Set(['mock-extractive-draft']));
  });

  it('writes JSON results and refuses usage errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oat-eval-'));
    const { code } = await cli(['--json', join(dir, 'out.json')]);
    expect(code).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    expect(json.mode).toBe('mock');
    expect(json.results[0].fixtures).toHaveLength(ENHANCE_FIXTURES.length);

    expect((await cli(['--suite', 'nope'])).code).toBe(2);
    expect((await cli(['--model', 'gpt'])).code).toBe(2);
    expect((await cli(['--tolerance', 'x'])).code).toBe(2);
    expect((await cli(['--bogus'])).code).toBe(2);
  });
});

describe('eval baseline update', () => {
  it('writes the mode’s scores, and refuses while the structural tier fails', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oat-eval-')), 'baseline.json');
    const real = {
      model: 't',
      judgeModel: 'j',
      runs: 1,
      overall: { judge: 0.5 },
      fixtures: { x: { judge: 0.5 } },
    };
    writeFileSync(path, JSON.stringify({ version: 1, real: { enhance: real } }));
    expect((await cli(['--update-baseline'], { baselinePath: path })).code).toBe(0);
    const written = parseBaseline(readFileSync(path, 'utf8'));
    expect(written.real).toEqual({ enhance: real });
    expect(written.mock).toEqual(parseBaseline(readFileSync(BASELINE_PATH, 'utf8')).mock);

    const broken = enhanceWith({ mockOutput: () => ({ sections: [] }) });
    const refused = await cli(['--update-baseline'], { suites: broken, baselinePath: path });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('Baseline not updated');
  });

  it('refuses a real baseline update without a key (exit 2, nothing written)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oat-eval-')), 'baseline.json');
    const { code, out } = await cli(['--update-baseline', '--model', 'real'], {
      baselinePath: path,
    });
    expect(code).toBe(2);
    expect(out).toContain('needs an AI key');
    expect(existsSync(path)).toBe(false);
  });
});

/** Fake real-role models: the task answers with the extractive draft, the judge with fixed verdicts. */
function fakeModels(options: { judgeId?: string; covered?: (call: number) => string[] } = {}) {
  const roles: string[] = [];
  let coverageCalls = 0;
  const getModel = (role: string) => {
    roles.push(role);
    return role === 'enhance'
      ? createMockModel({
          modelId: 'fake-enhance',
          handler: (call) => {
            const fixture = ENHANCE_FIXTURES.find((f) => promptText(call).includes(f.meta.title))!;
            return JSON.stringify(extractiveDraft(toEnhanceInput(fixture, EVAL_TEMPLATES)));
          },
        })
      : createMockModel({
          modelId: options.judgeId ?? 'fake-judge',
          handler: (call) =>
            promptText(call).includes('Key points')
              ? JSON.stringify({ covered: options.covered?.(coverageCalls++) ?? [] })
              : JSON.stringify({ unsupported: [] }),
        });
  };
  return { roles, getModel };
}

const KEY = { AI_GATEWAY_API_KEY: 'test-key' };

describe('eval harness (quality tier)', () => {
  it('cleanly skips the quality tier when --model real has no key', async () => {
    const { code, out } = await cli(['--model', 'real'], { env: { AI_GATEWAY_API_KEY: '  ' } });
    expect(code).toBe(0);
    expect(out).toContain('--model real requested but no AI key is configured');
    expect(out).toContain('enhance · mock ·');
    expect(out).not.toMatch(/judge:/);
  });

  it('runs the task and a separate judge role at temperature 0 when a key is set', async () => {
    const temperatures: (number | undefined)[] = [];
    const task: EnhanceFn = (input, options) => {
      temperatures.push(options.temperature);
      return enhanceNotes(input, options);
    };
    const { roles, getModel } = fakeModels();
    const { code, out } = await cli(['--model', 'real', '--verbose'], {
      suites: enhanceWith({ task }),
      env: KEY,
      getModel,
    });
    expect(roles).toEqual(['enhance', 'judge']);
    expect(new Set(temperatures)).toEqual(new Set([0]));
    expect(out).toContain('enhance · real · fake-enhance · judge fake-judge');
    expect(out).toMatch(/one-on-one\s+4\/4 pass\s+\S+\s+0\.50/);
    expect(out).toContain('✗ interview judge:coverage (0.00): not covered:');
    expect(out).toContain('Baseline: enhance not compared (no real baseline).');
    expect(out).not.toContain('self-graded');
    expect(code).toBe(0);
  });

  it('warns when the judge is the model under test', async () => {
    const { getModel } = fakeModels({ judgeId: 'fake-enhance' });
    const { out } = await cli(['--model', 'real'], { env: KEY, getModel });
    expect(out).toContain('the judge is the model under test (fake-enhance)');
  });

  it('gates real runs on tier means for the same model pair only', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oat-eval-')), 'baseline.json');
    const allPoints = (f: (typeof ENHANCE_FIXTURES)[number]) =>
      f.expect.mustMention.map((m) => m.id);
    const everything = () => ENHANCE_FIXTURES.flatMap(allPoints);
    const good = fakeModels({ covered: everything });
    expect(
      (
        await cli(['--update-baseline', '--suite', 'enhance', '--model', 'real'], {
          baselinePath: path,
          env: KEY,
          getModel: good.getModel,
        })
      ).code,
    ).toBe(0);
    const written = parseBaseline(readFileSync(path, 'utf8')).real!.enhance!;
    expect(written).toMatchObject({ model: 'fake-enhance', judgeModel: 'fake-judge', runs: 1 });
    expect(written.overall.judge).toBe(1);

    // Same models, same verdicts → compared, no regressions.
    const same = await cli(['--suite', 'enhance', '--model', 'real'], {
      baselinePath: path,
      env: KEY,
      getModel: fakeModels({ covered: everything }).getModel,
    });
    expect(same.out).toContain('Baseline: enhance — 0 regression(s)');
    expect(same.code).toBe(0);

    // The judge now finds nothing covered → tier means drop → regression.
    const worse = await cli(['--suite', 'enhance', '--model', 'real'], {
      baselinePath: path,
      env: KEY,
      getModel: fakeModels().getModel,
    });
    expect(worse.code).toBe(1);
    expect(worse.out).toMatch(/▼ enhance\/all tier:judge: 1\.00 → 0\.50/);

    // A different judge model is not compared against that baseline.
    const other = await cli(['--suite', 'enhance', '--model', 'real'], {
      baselinePath: path,
      env: KEY,
      getModel: fakeModels({ judgeId: 'other-judge' }).getModel,
    });
    expect(other.code).toBe(0);
    expect(other.out).toContain(
      'real baseline is for fake-enhance judged by fake-judge; this run is fake-enhance judged by other-judge',
    );
  }, 30_000); // four full real-mode runs of the enhance suite: slow on a loaded machine

  it('averages --runs and requires every run to pass', async () => {
    // Coverage judge alternates between "all covered" and "none covered" on each call.
    const { getModel } = fakeModels({
      covered: (n) =>
        n % 2 === 0 ? ENHANCE_FIXTURES.flatMap((f) => f.expect.mustMention.map((m) => m.id)) : [],
    });
    const dir = mkdtempSync(join(tmpdir(), 'oat-eval-'));
    const { code, out } = await cli(
      ['--suite', 'enhance', '--model', 'real', '--runs', '2', '--json', join(dir, 'r.json')],
      {
        env: KEY,
        getModel,
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('mean of 2 runs');
    const json = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
    const coverage = json.results[0].fixtures[0].checks.find(
      (c: { id: string }) => c.id === 'judge:coverage',
    );
    expect(coverage).toMatchObject({ score: 0.5, pass: false });
    expect(json.results[0].runs).toBe(2);
    expect((await cli(['--runs', '0'])).code).toBe(2);
  });
});
