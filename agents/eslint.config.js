// @ts-check
import { defineConfig } from 'eslint/config';

import root from '../eslint.config.js';

// The repo config plus eve's build output (`eve build` writes .eve/ and .output/ here).
export default defineConfig({ ignores: ['.eve/**', '.output/**'] }, root);
