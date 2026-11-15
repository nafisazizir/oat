import 'server-only';

import { apiDeps } from '../api';
import { createTasksApi } from './api';

/** The tasks API bound to the app's database and Better Auth (route files re-export these). */
export const tasksApi = createTasksApi(apiDeps);
