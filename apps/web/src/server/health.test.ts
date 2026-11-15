import { describe, expect, it, vi } from 'vitest';

import { checkHealth } from './health';

describe('checkHealth', () => {
  it('is ok when the database answers', async () => {
    const report = await checkHealth({ version: '1.2.3', pingDb: async () => [{ '?column?': 1 }] });
    expect(report).toEqual({ ok: true, version: '1.2.3', db: 'ok' });
  });

  it('reports db: error and logs the reason (not in the report) when the ping fails', async () => {
    const onError = vi.fn();
    const failure = new Error('connect ECONNREFUSED postgres:5432');
    const report = await checkHealth({
      version: '1',
      pingDb: () => Promise.reject(failure),
      onError,
    });
    expect(report).toEqual({ ok: false, version: '1', db: 'error' });
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    expect(onError).toHaveBeenCalledWith('db', failure);
  });

  it('treats a hung database as down after the timeout', async () => {
    const onError = vi.fn();
    const report = await checkHealth({
      version: '1',
      pingDb: () => new Promise(() => {}),
      timeoutMs: 20,
      onError,
    });
    expect(report.db).toBe('error');
    expect(String(onError.mock.calls[0]?.[1])).toContain('timed out');
  });
});
