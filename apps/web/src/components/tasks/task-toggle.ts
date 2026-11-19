import { isApiError } from '@/lib/api-client';

type SetDone = (
  id: string,
  input: { done: boolean; baseVersion: number },
) => Promise<{ documentVersion: number }>;

/** Writes a tick at `baseVersion`; if the note changed meanwhile, retries once on the server's version. */
export async function setDoneRetryingOnce(
  setDone: SetDone,
  id: string,
  done: boolean,
  baseVersion: number,
): Promise<{ documentVersion: number }> {
  try {
    return await setDone(id, { done, baseVersion });
  } catch (error) {
    const fresh = isApiError(error, 'stale_version') ? error.body?.document?.version : undefined;
    if (fresh === undefined) throw error;
    return setDone(id, { done, baseVersion: fresh });
  }
}

/** What to tell the user after a tick was rolled back, and whether the list is out of date. */
export function toggleFailure(error: unknown): { description: string; reload: boolean } {
  const reload = isApiError(error, 'stale_version') || isApiError(error, 'not_found');
  return {
    reload,
    description: reload
      ? 'That note changed. The list is up to date now — try again.'
      : error instanceof Error
        ? error.message
        : 'Couldn’t update the task.',
  };
}
