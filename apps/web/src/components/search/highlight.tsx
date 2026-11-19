import { highlightParts } from '@/lib/search';

/**
 * Renders a search highlight (safe HTML whose only markup is `<mark>`) as React text — never as HTML, so
 * nothing in a note or transcript can become markup.
 */
export function Highlight({ html, className }: { html: string; className?: string }) {
  return (
    <span className={className}>
      {highlightParts(html).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-xs bg-amber-300 px-px text-current">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
