/**
 * The one place main-process IPC handlers are registered (task 1.8). Every handler:
 * 1. checks the sender is our renderer's main frame (`isTrustedSender`), else `forbidden`;
 * 2. parses the payload with the channel's schema from `@oat/core/bridge`, else `invalid_payload`;
 * 3. runs, then parses its own response (a bug can't leak extra fields), mapping errors to codes.
 *
 * Electron-free (takes an `ipcMain`-like object), so the checks are unit-tested with fake events.
 */
import {
  type BridgeErrorCode,
  bridgeContract,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type InvokeResult,
  type SendChannel,
  type SendPayload,
  type SubscribeChannel,
  type SubscribePayload,
} from '@oat/core/bridge';

import type { FrameLike } from './security.ts';

export interface IpcEventLike {
  readonly senderFrame: FrameLike | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** Throw from a handler to answer with a specific code and a user-facing message. */
export class BridgeError extends Error {
  override name = 'BridgeError';
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Channels whose response is `undefined` may return nothing. */
type HandlerResult<T> = undefined extends T ? T | void : T;

export type InvokeHandler<C extends InvokeChannel> = (
  payload: InvokeRequest<C>,
  event: IpcEventLike,
) => HandlerResult<InvokeResponse<C>> | Promise<HandlerResult<InvokeResponse<C>>>;

export type SendHandler<C extends SendChannel> = (
  payload: SendPayload<C>,
  event: IpcEventLike,
) => void;

const fail = <C extends InvokeChannel>(
  code: BridgeErrorCode,
  message: string,
): InvokeResult<C> => ({
  ok: false,
  error: { code, message },
});

function describeSender(event: IpcEventLike): string {
  const frame = event.senderFrame;
  if (!frame) return 'a destroyed frame';
  return `${frame.parent ? 'a subframe' : 'a main frame'} at ${frame.url.slice(0, 200)}`;
}

export interface BridgeOptions {
  ipcMain: IpcMainLike;
  isTrustedSender: (event: IpcEventLike) => boolean;
  log: Logger;
}

export function createBridge({ ipcMain, isTrustedSender, log }: BridgeOptions) {
  return {
    handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
      const { request, response } = bridgeContract.invoke[channel];
      ipcMain.handle(channel, async (event: IpcEventLike, ...args: unknown[]) => {
        if (!isTrustedSender(event)) {
          log.warn(`ipc: refused invoke ${channel} from ${describeSender(event)}`);
          return fail<C>('forbidden', 'This window may not call the app.');
        }
        const parsed = args.length <= 1 ? request.safeParse(args[0]) : null;
        if (!parsed?.success) {
          log.warn(`ipc: invalid payload for ${channel}`);
          return fail<C>('invalid_payload', 'Invalid request.');
        }
        try {
          const value = await handler(parsed.data as InvokeRequest<C>, event);
          const checked = response.safeParse(value);
          if (!checked.success) {
            log.error(`ipc: ${channel} produced an invalid response`, checked.error);
            return fail<C>('internal', 'Something went wrong.');
          }
          return { ok: true, value: checked.data } as InvokeResult<C>;
        } catch (error) {
          if (error instanceof BridgeError) return fail<C>(error.code, error.message);
          log.error(`ipc: ${channel} failed`, error);
          return fail<C>('internal', 'Something went wrong.');
        }
      });
    },

    on<C extends SendChannel>(channel: C, handler: SendHandler<C>): void {
      const schema = bridgeContract.send[channel];
      ipcMain.on(channel, (event: IpcEventLike, ...args: unknown[]) => {
        if (!isTrustedSender(event)) {
          log.warn(`ipc: refused send ${channel} from ${describeSender(event)}`);
          return;
        }
        const parsed = args.length <= 1 ? schema.safeParse(args[0]) : null;
        if (!parsed?.success) {
          log.warn(`ipc: invalid payload for ${channel}`);
          return;
        }
        try {
          handler(parsed.data as SendPayload<C>, event);
        } catch (error) {
          log.error(`ipc: ${channel} failed`, error);
        }
      });
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;

/** Validates a main → renderer push before it is sent (throws on a bug). */
export function subscribePayload<C extends SubscribeChannel>(
  channel: C,
  payload: SubscribePayload<C>,
): SubscribePayload<C> {
  return bridgeContract.subscribe[channel].parse(payload) as SubscribePayload<C>;
}
