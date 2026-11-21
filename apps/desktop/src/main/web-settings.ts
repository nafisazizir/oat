import type { InvokeRequest } from '@oat/core/bridge';

const paths: Record<InvokeRequest<'settings:open-web'>['section'], string> = {
  profile: '/settings/profile',
  preferences: '/settings',
  integrations: '/settings/integrations',
  workspace: '/settings/workspace',
  members: '/settings/workspace/members',
};

export function webSettingsUrl(baseUrl: string, section: keyof typeof paths): string {
  return new URL(paths[section], baseUrl).toString();
}
