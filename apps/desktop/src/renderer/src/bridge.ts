/**
 * Renderer access to `window.oat` (exposed by the preload script). `call` unwraps the result envelope and
 * throws a `BridgeCallError` with the code, so components can `try/catch`.
 */
import type {
  BridgeErrorCode,
  InvokeArgs,
  InvokeChannel,
  InvokeResponse,
  OatBridge,
} from '@oat/core/bridge';

declare global {
  interface Window {
    oat: OatBridge;
  }
}

export class BridgeCallError extends Error {
  override name = 'BridgeCallError';
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function bridge(): OatBridge {
  return window.oat;
}

export async function call<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResponse<C>> {
  const result = await bridge().invoke(channel, ...args);
  if (!result.ok) throw new BridgeCallError(result.error.code, result.error.message);
  return result.value;
}
