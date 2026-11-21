import { OatApiError } from '@oat/client';

function isApiError(error: unknown, code: string): error is OatApiError {
  return error instanceof OatApiError && error.code === code;
}

function freshVersion(error: unknown): number | undefined {
  if (!isApiError(error, 'stale_version')) return undefined;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('document' in details)) return undefined;
  const document = details.document;
  if (!document || typeof document !== 'object' || !('version' in document)) return undefined;
  return typeof document.version === 'number' ? document.version : undefined;
}

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
    const fresh = freshVersion(error);
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
