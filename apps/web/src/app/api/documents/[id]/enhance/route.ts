import { enhanceApi } from '@/server/enhance/routes';

// The POST runs the enhancement job after responding (`after()`), within this function's time budget: it must
// cover the job's 2-min timeout + completion (ENHANCE_TIMEOUT_MS). Vercel caps it by plan (see task 4.4 notes).
export const maxDuration = 300;

export const { GET, POST } = enhanceApi.documentEnhance;
