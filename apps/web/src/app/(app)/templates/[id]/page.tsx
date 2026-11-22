import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TemplateView } from '@oat/workspace-ui/template-view';
import { loadTemplate } from '@/server/templates/pages';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: (await loadTemplate(id))?.template.name ?? 'Template not found' };
}

export default async function TemplatePage({ params }: Props) {
  const { id } = await params;
  const initialData = await loadTemplate(id);
  if (!initialData) notFound();
  return <TemplateView templateId={id} initialData={initialData} />;
}
