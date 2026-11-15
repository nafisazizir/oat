import { defineOatConfig } from '../../vitest.shared.ts';

// Integration tests talk to Docker containers; give them more headroom than the 5s default.
export default defineOatConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
