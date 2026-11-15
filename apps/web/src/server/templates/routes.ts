import 'server-only';

import { apiDeps } from '../api';
import { createTemplatesApi } from './api';

/** The templates API bound to the app's database and Better Auth (route files re-export these). */
export const templatesApi = createTemplatesApi(apiDeps);
