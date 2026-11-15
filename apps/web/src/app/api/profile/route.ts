import { profileApi } from '@/server/api';

/** The signed-in user's "About me" profile (4.6). See `src/server/profile.ts`. */
export const { GET, PUT } = profileApi.profile;
