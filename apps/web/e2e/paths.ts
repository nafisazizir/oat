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

/** Evidence screenshots for task 7.3 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_7_3 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/7.3/', import.meta.url),
);

/** Evidence screenshots for task 3.3 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_3_3 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/3.3/', import.meta.url),
);

/** Evidence screenshots for task 3.5 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_3_5 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/3.5/', import.meta.url),
);

/** Evidence screenshots for task 3.6 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_3_6 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/3.6/', import.meta.url),
);

/**
 * URL of the throwaway database of the e2e server on `port`, written by `web-server.ts` (git-ignored). One
 * file per port, so concurrent runs in one checkout don't overwrite each other's.
 */
export const databaseUrlFile = (port: string | number) =>
  fileURLToPath(new URL(`./.auth/database-url-${port}`, import.meta.url));

/** Evidence screenshots for task 5.3 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_5_3 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/5.3/', import.meta.url),
);

/** Evidence screenshots for task 8.1 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_8_1 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/8.1/', import.meta.url),
);

/** Evidence screenshots for task 4.4 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_4_4 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/4.4/', import.meta.url),
);

/** Evidence screenshots for task 8.4 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_8_4 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/8.4/', import.meta.url),
);

/** Evidence screenshots for task 6.4 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_6_4 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/6.4/', import.meta.url),
);

/**
 * Base URL of the e2e server's in-process mocks (`web-server.ts`, git-ignored), one file per port: specs read
 * the mock LLM's request log (`GET <url>/_requests?provider=llm`) to check what a prompt contained.
 */
export const mocksUrlFile = (port: string | number) =>
  fileURLToPath(new URL(`./.auth/mocks-url-${port}`, import.meta.url));

/** Evidence screenshots for task 8.3 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_8_3 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/8.3/', import.meta.url),
);

/** Evidence screenshots for task 4.5/4.6 (written only with `E2E_SCREENSHOTS=1`). */
export const EVIDENCE_4_5 = fileURLToPath(
  new URL('../../../docs/tasks/evidence/4.5/', import.meta.url),
);
