import { getBuiltinTemplate } from '@oat/ai/templates';
import { cn } from '@oat/ui';
import {
  IconBriefcase,
  IconCalendarCheck,
  IconLayout,
  IconMessages,
  IconNotebook,
  IconUserSearch,
  type Icon as TablerIcon,
} from '@tabler/icons-react';

const BUILTIN_ICONS: Record<string, TablerIcon> = {
  general: IconNotebook,
  'one-on-one': IconMessages,
  'sales-discovery': IconBriefcase,
  standup: IconCalendarCheck,
  interview: IconUserSearch,
};

/** A built-in's own icon; custom templates share one. */
export function TemplateIcon({ id, className }: { id: string; className?: string }) {
  const slug = getBuiltinTemplate(id)?.slug;
  const Icon = (slug && BUILTIN_ICONS[slug]) || IconLayout;
  return (
    <div
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-1000',
        className,
      )}
    >
      <Icon aria-hidden className="size-4" />
    </div>
  );
}
