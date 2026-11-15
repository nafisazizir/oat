import { Badge } from '@oat/ui/components/badge';
import {
  BriefcaseIcon,
  CalendarCheckIcon,
  MessagesSquareIcon,
  NotebookTextIcon,
  UserRoundSearchIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';

import { PageContainer, PageHeader } from '@/components/page';

export const metadata: Metadata = { title: 'Templates' };

/** Built-in templates from SPEC §4 (Enhance). Placeholders until templates are real data (M4). */
const builtIns: { name: string; blurb: string; icon: LucideIcon }[] = [
  { name: 'General', blurb: 'Key points, decisions and next steps.', icon: NotebookTextIcon },
  {
    name: '1:1',
    blurb: 'Updates, feedback and follow-ups for both sides.',
    icon: MessagesSquareIcon,
  },
  {
    name: 'Sales discovery',
    blurb: 'Needs, budget, timeline and objections.',
    icon: BriefcaseIcon,
  },
  { name: 'Standup', blurb: 'Done, doing next, and blockers per person.', icon: CalendarCheckIcon },
  { name: 'Interview', blurb: 'Signals by competency, with quotes.', icon: UserRoundSearchIcon },
];

export default function TemplatesPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Templates"
        description="Templates shape how Oat turns your notes and the transcript into clean notes."
      />
      <ul className="grid gap-3 sm:grid-cols-2">
        {builtIns.map(({ name, blurb, icon: Icon }) => (
          <li key={name} className="flex gap-3 rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{name}</span>
                <Badge variant="outline">Built-in</Badge>
              </div>
              <p className="text-muted-foreground">{blurb}</p>
            </div>
          </li>
        ))}
      </ul>
    </PageContainer>
  );
}
