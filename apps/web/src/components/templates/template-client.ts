import type { TemplateSection } from '@oat/core';

import type { ApiErrorBody } from '@/lib/api-types';
import type { TemplateDetail } from '@/lib/templates';

/** Browser calls to `/api/templates` (cookie session; same-origin, so the CSRF check passes). */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new Error('Couldn’t reach Oat. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message = (json as Partial<ApiErrorBody> | null)?.error?.message;
    throw new Error(message ?? `Something went wrong (${res.status}).`);
  }
  return json as T;
}

export type TemplateFields = { name: string; instructions: string; sections: TemplateSection[] };

export const templateClient = {
  create: (workspaceId: string, fields: TemplateFields) =>
    request<TemplateDetail>('POST', '/api/templates', { workspaceId, ...fields }),
  duplicate: (workspaceId: string, fromTemplateId: string) =>
    request<TemplateDetail>('POST', '/api/templates', { workspaceId, fromTemplateId }),
  update: (id: string, fields: TemplateFields) =>
    request<TemplateDetail>('PATCH', `/api/templates/${encodeURIComponent(id)}`, fields),
  remove: (id: string) => request<void>('DELETE', `/api/templates/${encodeURIComponent(id)}`),
};
