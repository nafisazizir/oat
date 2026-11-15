import { fileURLToPath } from 'node:url';

/** Cookies of the user `auth.setup.ts` signs in; every `chromium` test starts with them. Git-ignored. */
export const STORAGE_STATE = fileURLToPath(new URL('./.auth/user.json', import.meta.url));

/** Evidence screenshots for task 1.6 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_1_6 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/1.6/', import.meta.url),
);

/** Evidence screenshots for task 7.4 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_7_4 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/7.4/', import.meta.url),
);

/** Evidence screenshots for task 3.3 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_3_3 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/3.3/', import.meta.url),
);
