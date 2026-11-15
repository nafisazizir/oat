import { enhanceApi } from '@/server/enhance/routes';

// Long-lived SSE response.
export const maxDuration = 300;

export const { GET } = enhanceApi.enhancementStream;
