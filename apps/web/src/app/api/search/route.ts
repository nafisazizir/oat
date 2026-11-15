import { apiDeps } from '@/server/api';
import { createSearchApi } from '@/server/search';

export const { GET } = createSearchApi(apiDeps);
