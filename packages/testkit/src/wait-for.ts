export interface WaitForOptions {
  /** Total time to keep trying, in ms. Default 5000. */
  timeout?: number;
  /** Delay between attempts, in ms. Default 100. */
  interval?: number;
  /** Prefix for the timeout error. */
  message?: string;
}

/**
 * Polls `check` until it returns a value other than `undefined`, `null` or `false`, and returns that value.
 * Errors thrown by `check` count as "not yet"; on timeout the last error (if any) is attached as `cause`.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<Exclude<T, undefined | null | false>> {
  const { timeout = 5_000, interval = 100, message = 'waitFor timed out' } = options;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) {
        return value as Exclude<T, undefined | null | false>;
      }
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`${message} after ${timeout}ms${detail}`, { cause: lastError });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
  }
}
