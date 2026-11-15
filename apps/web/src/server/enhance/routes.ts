import 'server-only';

import { getAi } from '@oat/ai';
import { after } from 'next/server';

import { serverEnv } from '@/lib/env';

import { apiDeps } from '../api';
import { createEnhanceApi } from './api';
import { createRedisBroker, type EnhanceBroker } from './broker';
import type { EnhanceDeps } from './service';

// One broker per server process, kept across `next dev` module reloads.
const holder = globalThis as typeof globalThis & { __oatEnhanceBroker?: EnhanceBroker };

function broker(): EnhanceBroker {
  holder.__oatEnhanceBroker ??= createRedisBroker(serverEnv().REDIS_URL);
  return holder.__oatEnhanceBroker;
}

const enhanceDeps: EnhanceDeps = {
  get broker() {
    return broker();
  },
  model: () => {
    const ai = getAi();
    return { model: ai.getModel('enhance'), id: ai.models.enhance };
  },
  // Keeps the job alive after the response (waitUntil on Vercel); durable workflows come with 8.x.
  runInBackground: (task) => after(task),
};

/** The enhance API bound to the app's database, Better Auth, Redis and AI backend. */
export const enhanceApi = createEnhanceApi(apiDeps, enhanceDeps);
