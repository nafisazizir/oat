import { notionApi } from '@/server/api';
import { completeDesktopNotion } from '@/server/desktop-consent';

export const GET: typeof notionApi.callback.GET = async (request, context) =>
  (await completeDesktopNotion(request)) ?? notionApi.callback.GET(request, context);
