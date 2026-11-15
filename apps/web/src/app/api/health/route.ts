import { appVersion } from '@/lib/version';
import { pingDb } from '@/server/db';
import { checkHealth } from '@/server/health';

/**
 * Health probe for load balancers, compose healthchecks and e2e: `{ ok, version, db }`. 200 when every
 * check passes, 503 otherwise (so `curl -f` and Docker healthchecks fail while Postgres is unreachable).
 */
export async function GET() {
  const report = await checkHealth({
    version: appVersion,
    pingDb,
    onError: (check, error) => console.error(`health: ${check} check failed:`, error),
  });
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
