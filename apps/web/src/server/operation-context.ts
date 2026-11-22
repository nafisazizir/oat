import type { Auth, Mailer } from '@oat/auth';
import type { Db } from '@oat/db';

import { getAuth, getAuthConfig, getMailer } from './auth';
import { disconnectGoogleCalendarFor } from './calendar';
import { getDb } from './db';

export type OperationContext = {
  user: { id: string; email: string; emailVerified: boolean };
  headers: Headers;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  baseURL: string;
  disconnectCalendar(userId: string): Promise<unknown>;
};

export function operationContext(
  user: OperationContext['user'],
  headers: Headers,
): OperationContext {
  return {
    user,
    headers,
    db: getDb(),
    auth: getAuth(),
    mailer: getMailer(),
    baseURL: getAuthConfig().baseURL,
    disconnectCalendar: disconnectGoogleCalendarFor,
  };
}
