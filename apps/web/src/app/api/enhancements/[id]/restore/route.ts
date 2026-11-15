import { enhanceApi } from '@/server/enhance/routes';

/** Sets the note body to a version's output, or back to the notes it started from (4.5). */
export const { POST } = enhanceApi.enhancementRestore;
