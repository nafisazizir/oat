'use server';

import { refresh } from 'next/cache';

import { disconnectGoogleCalendarFor } from '../calendar';
import { requireSession } from '../session';

export type DisconnectResult = { ok: true } | { ok: false; error: string };

/** Settings → Integrations → "Disconnect": revokes the Google Calendar grant and removes it. */
export async function disconnectGoogleCalendarAction(): Promise<DisconnectResult> {
  const session = await requireSession();
  try {
    await disconnectGoogleCalendarFor(session.user.id);
  } catch (error) {
    console.error('calendar: disconnect failed:', error);
    return { ok: false, error: 'Couldn’t disconnect Google Calendar. Try again.' };
  }
  refresh();
  return { ok: true };
}
