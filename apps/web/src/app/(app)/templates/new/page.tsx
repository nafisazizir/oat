import type { Metadata } from 'next';
import { NewTemplateView } from '@oat/workspace-ui/template-view';
import { loadNewTemplate } from '@/server/templates/pages';

export const metadata: Metadata = { title: 'New template' };

export default async function NewTemplatePage() {
  return <NewTemplateView initialData={await loadNewTemplate()} />;
}
