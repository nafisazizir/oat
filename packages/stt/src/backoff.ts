export interface BackoffOptions {
  /** Delay before the first retry. Default 500 ms. */
  initialDelayMs: number;
  /** Cap. Default 10 s. */
  maxDelayMs: number;
  /** Growth per consecutive failure. Default 2. */
  factor: number;
  /** ± fraction of randomness so many clients don't redial in lockstep. Default 0.2. */
  jitter: number;
  /** Consecutive failed attempts before giving up (fatal error). Default `Infinity`: never stop silently. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/** Delay before retry number `failures` (1 = first retry). */
export function backoffDelay(
  failures: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    options.maxDelayMs,
    options.initialDelayMs * options.factor ** Math.max(0, failures - 1),
  );
  const spread = 1 + options.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(base * spread));
}
