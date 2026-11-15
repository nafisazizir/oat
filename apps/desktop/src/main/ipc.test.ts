import { initialMainState } from '@oat/core/bridge';
import { describe, expect, it, vi } from 'vitest';

import {
  BridgeError,
  createBridge,
  type IpcEventLike,
  type IpcMainLike,
  type Logger,
  subscribePayload,
} from './ipc.ts';
import { APP_ORIGIN, type FrameLike, isTrustedFrame, trustedOrigins } from './security.ts';

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown;

/** Records what `createBridge` registers, so tests can play the renderer. */
function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener as Listener),
    on: (channel, listener) => void listeners.set(channel, listener as Listener),
  };
  return {
    ipcMain,
    invoke: (channel: string, event: IpcEventLike, ...args: unknown[]) =>
      handlers.get(channel)!(event, ...args),
    send: (channel: string, event: IpcEventLike, ...args: unknown[]) =>
      listeners.get(channel)!(event, ...args),
  };
}

const origins = trustedOrigins(undefined);
const frame = (url: string, parent: FrameLike | null = null): FrameLike => ({ url, parent });
const ours: IpcEventLike = { senderFrame: frame(`${APP_ORIGIN}/index.html#/main`) };

function setup() {
  const fake = fakeIpcMain();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bridge = createBridge({
    ipcMain: fake.ipcMain,
    isTrustedSender: (event) => isTrustedFrame(event.senderFrame, origins),
    log,
  });
  return { ...fake, bridge, log };
}

describe('invoke handlers', () => {
  it('runs the handler for our renderer and wraps the parsed response', async () => {
    const { bridge, invoke } = setup();
    const handler = vi.fn(() => ({ accepted: true }));
    bridge.handle('auth:complete-from-link', handler);
    const result = await invoke('auth:complete-from-link', ours, { url: 'oat://auth' });
    expect(result).toEqual({ ok: true, value: { accepted: true } });
    expect(handler).toHaveBeenCalledWith({ url: 'oat://auth' }, ours);
  });

  it.each([
    ['another origin', frame('https://evil.example/')],
    [
      'a subframe of our page',
      frame(`${APP_ORIGIN}/index.html`, frame(`${APP_ORIGIN}/index.html`)),
    ],
    ['a file: page', frame('file:///Users/x/index.html')],
    ['a data: page', frame('data:text/html,hi')],
    ['the dev server origin in a build', frame('http://localhost:5173/#/main')],
    ['a look-alike host', frame('app://oat.evil/index.html')],
    ['a destroyed frame', null],
  ])('refuses %s without running the handler', async (_label, senderFrame) => {
    const { bridge, invoke, log } = setup();
    const handler = vi.fn();
    bridge.handle('state:get', handler);
    const result = await invoke('state:get', { senderFrame });
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: expect.any(String) },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refused invoke state:get'));
  });

  it.each([
    ['a wrong type', [{ url: 42 }]],
    ['a missing field', [{}]],
    ['no payload', []],
    ['an oversized value', [{ url: 'x'.repeat(5000) }]],
    ['extra arguments', [{ url: 'oat://auth' }, 'extra']],
  ])('refuses a payload with %s without running the handler', async (_label, args) => {
    const { bridge, invoke } = setup();
    const handler = vi.fn();
    bridge.handle('auth:complete-from-link', handler);
    const result = await invoke('auth:complete-from-link', ours, ...args);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a payload on a channel that takes none', async () => {
    const { bridge, invoke } = setup();
    const handler = vi.fn();
    bridge.handle('auth:sign-out', handler);
    expect(await invoke('auth:sign-out', ours, { force: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('strips fields a handler should not have returned', async () => {
    const { bridge, invoke } = setup();
    bridge.handle('api:me', () => ({
      user: { id: 'u1', email: 'a@b.c', name: null, token: 'secret' },
      activeWorkspaceId: null,
      token: 'secret',
    }));
    const result = await invoke('api:me', ours);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toEqual({
      ok: true,
      value: { user: { id: 'u1', email: 'a@b.c', name: null }, activeWorkspaceId: null },
    });
  });

  it('maps an invalid response and thrown errors to codes', async () => {
    const { bridge, invoke, log } = setup();
    bridge.handle('state:get', () => ({ seq: -1 }) as never);
    bridge.handle('api:me', () => {
      throw new BridgeError('unauthorized', 'Not signed in.');
    });
    bridge.handle('app:info', () => {
      throw new Error('boom: /Users/secret/path');
    });
    expect(await invoke('state:get', ours)).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
    expect(await invoke('api:me', ours)).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'Not signed in.' },
    });
    const crash = await invoke('app:info', ours);
    expect(crash).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Something went wrong.' },
    });
    expect(log.error).toHaveBeenCalled();
  });
});

describe('send handlers', () => {
  it('delivers valid messages from our renderer only', () => {
    const { bridge, send, log } = setup();
    const handler = vi.fn();
    bridge.on('app:rendered', handler);
    send('app:rendered', ours, { window: 'main' });
    send('app:rendered', { senderFrame: frame('https://evil.example/') }, { window: 'main' });
    send('app:rendered', ours, { window: 'settings' });
    send('app:rendered', ours);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ window: 'main' }, ours);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('a throwing handler is logged, not propagated', () => {
    const { bridge, send, log } = setup();
    bridge.on('shell:open-external', () => {
      throw new Error('nope');
    });
    expect(() => send('shell:open-external', ours, { url: 'https://x.y' })).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });
});

describe('subscribe payloads', () => {
  it('validates pushes before they are sent', () => {
    const snapshot = { seq: 3, state: initialMainState() };
    expect(subscribePayload('state:changed', snapshot)).toEqual(snapshot);
    expect(() => subscribePayload('state:changed', { seq: 'x' } as never)).toThrow();
  });
});
