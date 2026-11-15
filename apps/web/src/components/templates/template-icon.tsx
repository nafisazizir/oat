import { getBuiltinTemplate } from '@oat/ai/templates';
import { cn } from '@oat/ui';
import {
  BriefcaseIcon,
  CalendarCheckIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  MessagesSquareIcon,
  NotebookTextIcon,
  UserRoundSearchIcon,
} from 'lucide-react';

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  general: NotebookTextIcon,
  'one-on-one': MessagesSquareIcon,
  'sales-discovery': BriefcaseIcon,
  standup: CalendarCheckIcon,
  interview: UserRoundSearchIcon,
};

/** A built-in's own icon; custom templates share one. */
export function TemplateIcon({ id, className }: { id: string; className?: string }) {
  const slug = getBuiltinTemplate(id)?.slug;
  const Icon = (slug && BUILTIN_ICONS[slug]) || LayoutTemplateIcon;
  return (
    <div
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-4" />
    </div>
  );
}
