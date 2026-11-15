import {
  initialMainState,
  type InvokeResult,
  type MainStateSnapshot,
  type OatBridge,
} from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { createMainStateClient } from './main-state.ts';
import { windowKindFromHash } from './routes.ts';

function fakeBridge() {
  let push: ((s: MainStateSnapshot) => void) | null = null;
  let resolveGet!: (r: InvokeResult<'state:get'>) => void;
  let unsubscribed = false;
  const oat = {
    invoke: () => new Promise<InvokeResult<'state:get'>>((r) => (resolveGet = r)),
    subscribe: (_channel: string, listener: (s: MainStateSnapshot) => void) => {
      push = listener;
      return () => void (unsubscribed = true);
    },
  } as unknown as Pick<OatBridge, 'invoke' | 'subscribe'>;
  return {
    oat,
    push: (s: MainStateSnapshot) => push!(s),
    reply: (s: MainStateSnapshot) => resolveGet({ ok: true, value: s }),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

const snap = (seq: number, activeMeetingId: string | null = null): MainStateSnapshot => ({
  seq,
  state: { ...initialMainState(), activeMeetingId },
});

describe('createMainStateClient', () => {
  it('takes the initial snapshot from state:get', async () => {
    const fake = fakeBridge();
    const client = createMainStateClient(fake.oat);
    expect(client.getSnapshot()).toBeNull();
    fake.reply(snap(4));
    await client.ready;
    expect(client.getSnapshot()?.seq).toBe(4);
  });

  it('a push that overtakes the state:get reply wins; the stale reply is ignored', async () => {
    const fake = fakeBridge();
    const client = createMainStateClient(fake.oat);
    let notified = 0;
    client.subscribe(() => notified++);
    fake.push(snap(5, 'new'));
    fake.reply(snap(4, 'old'));
    await client.ready;
    expect(client.getSnapshot()).toEqual(snap(5, 'new'));
    expect(notified).toBe(1);
  });

  it('ignores duplicate and out-of-order pushes', async () => {
    const fake = fakeBridge();
    const client = createMainStateClient(fake.oat);
    fake.reply(snap(1));
    await client.ready;
    fake.push(snap(3, 'c'));
    fake.push(snap(2, 'b'));
    fake.push(snap(3, 'again'));
    expect(client.getSnapshot()).toEqual(snap(3, 'c'));
    client.dispose();
    expect(fake.unsubscribed).toBe(true);
  });
});

describe('windowKindFromHash', () => {
  it('routes by hash; anything unknown is the main window', () => {
    expect(windowKindFromHash('#/widget')).toBe('widget');
    expect(windowKindFromHash('#widget')).toBe('widget');
    expect(windowKindFromHash('#/widget/x?y')).toBe('widget');
    expect(windowKindFromHash('#/main')).toBe('main');
    expect(windowKindFromHash('')).toBe('main');
    expect(windowKindFromHash('#/settings')).toBe('main');
  });
});
