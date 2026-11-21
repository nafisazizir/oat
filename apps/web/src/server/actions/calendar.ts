'use server';

import { refresh } from 'next/cache';
import { headers } from 'next/headers';

import { operationContext } from '../operation-context';
import * as operations from '../operations/calendar';
import { requireSession } from '../session';

export type DisconnectResult = { ok: true } | { ok: false; error: string };

export async function disconnectGoogleCalendarAction(): Promise<DisconnectResult> {
  const { user } = await requireSession();
  const result = await operations.disconnectGoogleCalendarAction(
    operationContext(user, await headers()),
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}
