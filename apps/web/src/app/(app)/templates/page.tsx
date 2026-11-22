import type { Metadata } from 'next';
import { TemplatesGallery } from '@oat/workspace-ui/templates-gallery';
import { loadTemplateList } from '@/server/templates/pages';

export const metadata: Metadata = { title: 'Templates' };

export default async function TemplatesPage() {
  const initialData = await loadTemplateList();
  return <TemplatesGallery initialData={initialData} workspace={initialData.workspace} />;
}
