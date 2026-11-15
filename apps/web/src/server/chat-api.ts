import 'server-only';

import { apiDeps, apiRateLimiter } from './api';
import { createChatApi, defaultChatDeps } from './chat';

/** The assistant routes (`/api/chat…`) bound to the real deps; route files re-export these. */
export const chatApi = createChatApi(apiDeps, { ...defaultChatDeps, rateLimiter: apiRateLimiter });
