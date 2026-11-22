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
      <article className="flex flex-col gap-6 rounded-xl border border-gray-alpha-400 p-6 sm:p-8">
        <header className="flex flex-col gap-1">
          <p className="text-label-12 text-gray-900">Enhanced notes · {name || 'Untitled'}</p>
          <div className="h-6 w-1/2 rounded-md bg-gray-100" aria-hidden />
        </header>
        {sections.map((section, i) => (
          <section key={`${i}-${section.heading}`} className="flex flex-col gap-2">
            <h3 className="text-heading-16 text-gray-1000">
              {section.heading || <span className="text-gray-900">Untitled section</span>}
            </h3>
            <p className="text-copy-14 text-gray-900 italic">
              {section.instructions || 'No instructions: the AI decides what belongs here.'}
            </p>
            <div className="flex flex-col gap-1.5 pt-1" aria-hidden>
              {LINES.slice(0, 2 + (i % 2)).map((width) => (
                <div key={width} className={cn('h-2.5 rounded-sm bg-gray-100', width)} />
              ))}
            </div>
          </section>
        ))}
      </article>
      <details className="group rounded-lg border border-gray-alpha-400 px-4 py-3 text-copy-14">
        <summary className="cursor-pointer rounded-sm text-label-14 text-gray-900 outline-none select-none group-open:mb-3 hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50">
          What the AI reads
        </summary>
        <pre className="text-copy-13-mono whitespace-pre-wrap text-gray-900">
          {renderTemplate({ name: name || 'Untitled', instructions, sections })}
        </pre>
      </details>
    </div>
  );
}
