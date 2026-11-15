import { defineOatConfig } from '../../vitest.shared.ts';

// Unit tests for main-process logic (bridge helper, store, auth, security, config) and renderer helpers.
// Electron itself is never imported by these modules; app flows are Playwright `_electron` e2e (`pnpm e2e`).
export default defineOatConfig();
