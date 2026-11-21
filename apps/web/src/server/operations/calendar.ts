import type { OperationContext } from '../operation-context';

export type DisconnectResult = { ok: true } | { ok: false; error: string; status?: number };

/** Settings → Integrations → "Disconnect": revokes the Google Calendar grant and removes it. */
export async function disconnectGoogleCalendarAction(
  context: OperationContext,
): Promise<DisconnectResult> {
  const session = context;
  try {
    await context.disconnectCalendar(session.user.id);
  } catch (error) {
    console.error('calendar: disconnect failed:', error);
    return { ok: false, error: 'Couldn’t disconnect Google Calendar. Try again.' };
  }
  return { ok: true };
}
