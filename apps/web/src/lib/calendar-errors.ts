/**
 * Copy for the `?error=` codes Better Auth (or Google) appends to `/settings/integrations` after a failed
 * "Connect Google Calendar".
 */
export function calendarConnectErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code.toLowerCase()) {
    case 'email_does_not_match':
      return 'That Google account uses a different email address than your Oat account. Choose the Google account you sign in to Oat with.';
    case 'account_already_linked_to_different_user':
      return 'That Google account is already connected to another Oat account.';
    case 'access_denied':
      return 'Google Calendar wasn’t connected because access wasn’t granted.';
    case 'email_not_verified':
      return 'That Google account’s email address isn’t verified.';
    default:
      return 'We couldn’t connect Google Calendar. Please try again.';
  }
}
