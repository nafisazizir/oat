/**
 * Preload (sandboxed, context-isolated): exposes `window.oat`, generated from the channel lists in
 * `@oat/core/bridge`. A channel that isn't in the contract never reaches IPC. Payload validation and the
 * sender check happen in main (`src/main/ipc.ts`); this layer only routes.
 *
 * Nothing secret is exposed: no token, no `ipcRenderer`, no Node APIs.
 */
import {
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  bridgeChannels,
  type InvokeChannel,
  type OatBridge,
  type SendChannel,
  type SubscribeChannel,
} from '@oat/core/bridge';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const invokeChannels = new Set<string>(bridgeChannels.invoke);
const sendChannels = new Set<string>(bridgeChannels.send);
const subscribeChannels = new Set<string>(bridgeChannels.subscribe);

const bridge: OatBridge = {
  version: BRIDGE_VERSION,
  platform: process.platform,
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeChannels.has(channel))
      return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args.slice(0, 1));
  },
  send(channel: SendChannel, payload: unknown) {
    if (!sendChannels.has(channel)) throw new Error(`Unknown channel ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  subscribe(channel: SubscribeChannel, listener: (payload: never) => void) {
    if (!subscribeChannels.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
} as OatBridge;

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge);
