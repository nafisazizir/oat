import { describe, expect, it } from 'vitest';

import {
  agentsDispatcherFromEnv,
  createAgentsDispatcher,
  DEFAULT_AGENTS_URL,
  DispatchError,
  dispatchBackoffMs,
  type PostMeetingJob,
} from './pipeline.ts';

const job: PostMeetingJob = { pipelineRunId: 'r1', attempt: 2, meetingId: 'm1', workspaceId: 'w1' };
const TOKEN = 't'.repeat(40);

function fakeFetch(answer: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('createAgentsDispatcher (the web app → agents /jobs contract, D-29)', () => {
  it('posts the job with the service token and returns the Workflow run id', async () => {
    const f = fakeFetch(Response.json({ runId: 'wrun_1' }, { status: 202 }));
    const d = createAgentsDispatcher({ url: 'http://agents:3100/', token: TOKEN, fetch: f.fn });
    expect(await d.dispatch(job)).toEqual({ workflowRunId: 'wrun_1' });
    expect(f.calls[0]!.url).toBe('http://agents:3100/jobs/post-meeting');
    expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual(job);
  });

  it('a refused job is permanent; anything else is retried', async () => {
    const refused = async (status: number) => {
      const f = fakeFetch(Response.json({ error: 'x' }, { status }));
      const d = createAgentsDispatcher({ url: 'http://a', token: TOKEN, fetch: f.fn });
      return d.dispatch(job).catch((e: unknown) => e as DispatchError);
    };
    for (const status of [400, 404, 409]) {
      const error = await refused(status);
      expect(error).toBeInstanceOf(DispatchError);
      expect((error as DispatchError).permanent).toBe(true);
    }
    for (const status of [401, 500, 503]) {
      expect(((await refused(status)) as DispatchError).permanent).toBe(false);
    }
    const down = createAgentsDispatcher({
      url: 'http://a',
      token: TOKEN,
      fetch: fakeFetch(new TypeError('fetch failed')).fn,
    });
    const error = (await down.dispatch(job).catch((e: unknown) => e)) as DispatchError;
    expect(error.permanent).toBe(false);
    expect(error.message).toMatch(/unreachable/);
  });

  it('from env: needs a token of ≥ 32 characters; the URL defaults to the local agents server', () => {
    expect(agentsDispatcherFromEnv({})).toBeNull();
    expect(agentsDispatcherFromEnv({ OAT_AGENTS_TOKEN: 'short' })).toBeNull();
    expect(agentsDispatcherFromEnv({ OAT_AGENTS_TOKEN: TOKEN })).not.toBeNull();
    expect(DEFAULT_AGENTS_URL).toBe('http://127.0.0.1:3100');
  });
});

describe('dispatchBackoffMs', () => {
  it('doubles from 5 s up to 5 min', () => {
    expect([1, 2, 3, 4].map(dispatchBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(dispatchBackoffMs(20)).toBe(5 * 60_000);
  });
});
