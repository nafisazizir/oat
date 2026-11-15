import { renderTemplate } from '@oat/ai/templates';
import type { TemplateSection } from '@oat/core';
import { cn } from '@oat/ui';

/** Placeholder line widths so each section looks like written notes, not a form. */
const LINES = ['w-11/12', 'w-4/5', 'w-2/3'];

/**
 * What enhanced notes made with this template look like: each section as a heading, its instructions as
 * the hint for what goes there, and grey lines standing in for content. Plus, folded away, the exact text
 * the AI is given.
 */
export function TemplatePreview({
  name,
  instructions,
  sections,
  className,
}: {
  name: string;
  instructions: string;
  sections: readonly TemplateSection[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="template-preview">
      <article className="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-xs sm:p-8">
        <header className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Enhanced notes · {name || 'Untitled'}</p>
          <div className="h-6 w-1/2 rounded-md bg-muted" aria-hidden />
        </header>
        {sections.map((section, i) => (
          <section key={`${i}-${section.heading}`} className="flex flex-col gap-2">
            <h3 className="text-lg font-medium">
              {section.heading || <span className="text-muted-foreground">Untitled section</span>}
            </h3>
            <p className="text-sm text-muted-foreground italic">
              {section.instructions || 'No instructions: the AI decides what belongs here.'}
            </p>
            <div className="flex flex-col gap-1.5 pt-1" aria-hidden>
              {LINES.slice(0, 2 + (i % 2)).map((width) => (
                <div key={width} className={cn('h-2.5 rounded-full bg-muted', width)} />
              ))}
            </div>
          </section>
        ))}
      </article>
      <details className="group rounded-lg border px-4 py-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground select-none group-open:mb-3">
          What the AI reads
        </summary>
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {renderTemplate({ name: name || 'Untitled', instructions, sections })}
        </pre>
      </details>
    </div>
  );
}
