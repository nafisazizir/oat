import { appVersion } from '@/lib/version';

/** Liveness probe for load balancers, compose healthchecks and e2e: `{ ok: true, version }`. */
export function GET() {
  return Response.json(
    { ok: true, version: appVersion },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
