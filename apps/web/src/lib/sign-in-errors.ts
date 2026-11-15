/** Copy for the `?error=` codes Better Auth appends to the sign-in page after a failed attempt. */
export function signInErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code.toUpperCase()) {
    case 'INVALID_TOKEN':
    case 'EXPIRED_TOKEN':
      return 'That sign-in link has expired or was already used. Request a new one below.';
    case 'NEW_USER_SIGNUP_DISABLED':
    case 'SIGNUP_DISABLED':
      return 'New accounts can’t be created right now.';
    default:
      return 'We couldn’t sign you in. Please try again.';
  }
}
