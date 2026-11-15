import type { Comparison } from './baseline.ts';
import type { CheckResult, CheckTier, SuiteResult } from './types.ts';

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;

function tierCell(checks: readonly CheckResult[], tier: CheckTier): string {
  const inTier = checks.filter((c) => c.tier === tier);
  if (inTier.length === 0) return '—';
  if (tier === 'structural') return `${inTier.filter((c) => c.pass).length}/${inTier.length} pass`;
  return mean(inTier.map((c) => c.score))!.toFixed(2);
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .trimEnd(),
  );
}

const fmt = (n: number | null) => (n === null ? 'missing' : n.toFixed(2));

export interface ReportOptions {
  /** Also list every non-passing check, not just structural failures. */
  verbose?: boolean;
}

/** Human-readable results: one table per suite, then failures, regressions and notices. */
export function formatReport(
  results: readonly SuiteResult[],
  comparison: Comparison,
  notices: readonly string[],
  options: ReportOptions = {},
): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(
      `\n${result.suite} · ${result.mode} · ${result.model}` +
        (result.judgeModel ? ` · judge ${result.judgeModel}` : '') +
        (result.runs > 1 ? ` · mean of ${result.runs} runs` : ''),
    );
    const all = result.fixtures.flatMap((f) => f.checks);
    lines.push(
      ...table([
        ['fixture', 'structural', 'property', 'judge', 'time', ''],
        ...result.fixtures.map((f) => [
          f.id,
          tierCell(f.checks, 'structural'),
          tierCell(f.checks, 'property'),
          tierCell(f.checks, 'judge'),
          `${f.durationMs}ms`,
          f.error ? 'ERROR' : '',
        ]),
        [
          'all',
          tierCell(all, 'structural'),
          tierCell(all, 'property'),
          tierCell(all, 'judge'),
          '',
          '',
        ],
      ]),
    );
    const shown = result.fixtures.flatMap((f) =>
      f.checks
        .filter((c) => !c.pass && (options.verbose || c.tier === 'structural'))
        .map((c) => `  ✗ ${f.id} ${c.id} (${c.score.toFixed(2)}): ${c.detail ?? 'failed'}`),
    );
    const errors = result.fixtures.filter((f) => f.error).map((f) => `  ! ${f.id}: ${f.error}`);
    if (errors.length || shown.length) lines.push('', ...errors, ...shown);
  }

  lines.push('');
  if (comparison.compared.length) {
    lines.push(
      `Baseline: ${comparison.compared.join(', ')} — ${comparison.regressions.length} regression(s), ` +
        `${comparison.improvements.length} improvement(s), ${comparison.added} new check(s).`,
    );
    for (const r of comparison.regressions) {
      lines.push(`  ▼ ${r.suite}/${r.fixture} ${r.check}: ${fmt(r.baseline)} → ${fmt(r.current)}`);
    }
    for (const r of comparison.improvements) {
      lines.push(`  ▲ ${r.suite}/${r.fixture} ${r.check}: ${fmt(r.baseline)} → ${fmt(r.current)}`);
    }
  }
  for (const { suite, reason } of comparison.uncompared) {
    lines.push(`Baseline: ${suite} not compared (${reason}).`);
  }
  for (const notice of notices) lines.push(`Note: ${notice}`);
  return lines.join('\n');
}
