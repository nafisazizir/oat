import { integrationModes, serverEnv } from '@/lib/env';
import { getSession } from '@/server/session';

export async function GET() {
  if (!(await getSession())) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Not signed in.' } },
      { status: 401 },
    );
  }
  return Response.json(integrationModes(serverEnv()), { headers: { 'cache-control': 'no-store' } });
}
