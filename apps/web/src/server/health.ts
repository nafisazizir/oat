/**
 * `/api/health` logic: liveness + a database round-trip, so compose healthchecks, load balancers and e2e
 * see "up" only when the app can actually serve data. Dependencies are passed in, so it is unit-tested
 * without a server or a database.
 */

export type CheckStatus = 'ok' | 'error';

export interface HealthReport {
  ok: boolean;
  version: string;
  db: CheckStatus;
}

export interface HealthDeps {
  version: string;
  /** Resolves when the database answers; rejects (or hangs) when it doesn't. */
  pingDb: () => Promise<unknown>;
  /** A hung connection counts as down after this long. Default 2000 ms (compose healthcheck timeout is 3 s). */
  timeoutMs?: number;
  /** Where failure reasons go. They are logged, never returned (no hostnames or errors in the response). */
  onError?: (check: string, error: unknown) => void;
}

async function withTimeout(run: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth({
  version,
  pingDb,
  timeoutMs = 2000,
  onError = () => {},
}: HealthDeps): Promise<HealthReport> {
  let db: CheckStatus = 'ok';
  try {
    await withTimeout(pingDb, timeoutMs);
  } catch (error) {
    db = 'error';
    onError('db', error);
  }
  return { ok: db === 'ok', version, db };
}
