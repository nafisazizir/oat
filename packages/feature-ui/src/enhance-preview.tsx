'use client';

import type { EnhanceBlock, EnhanceOutput, ListItemBlock } from '@oat/ai/enhance';
import { Skeleton } from '@oat/ui/components/skeleton';
import { IconSparkles } from '@tabler/icons-react';

/**
 * Read-only live view of the notes while the AI writes them (D-20): the same prose styles and my-vs-AI colours
 * as the editor (`.oat-editor` + `data-origin`), rebuilt from each preview snapshot. Swapped for the editor
 * when the run completes.
 */
export function EnhancePreview({ output }: { output: EnhanceOutput | null }) {
  const sections = output?.sections ?? [];
  return (
    <section
      aria-label="Enhanced notes (being written)"
      aria-busy="true"
      data-testid="enhance-preview"
      className="flex min-h-64 flex-col gap-4"
    >
      <p
        role="status"
        aria-live="polite"
        className="flex min-h-6 items-center gap-2 text-label-14 text-gray-900"
      >
        <IconSparkles className="size-4 animate-pulse text-brand-700" />
        Writing your notes from the transcript…
      </p>
      {sections.length === 0 ? (
        <div className="flex flex-col gap-3" aria-hidden>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <div className="oat-editor">
          {sections.map((section, i) => (
            <PreviewSection key={i} heading={section.heading} blocks={section.blocks} />
          ))}
        </div>
      )}
    </section>
  );
}

function PreviewSection({ heading, blocks }: { heading: string; blocks: EnhanceBlock[] }) {
  const groups: Array<EnhanceBlock | ListItemBlock[]> = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (block.kind === 'paragraph') groups.push(block);
    else if (Array.isArray(last) && last[0]!.kind === block.kind) last.push(block);
    else groups.push([block]);
  }
  return (
    <>
      <h2 data-origin="ai">{heading}</h2>
      {groups.map((group, i) =>
        Array.isArray(group) ? (
          <PreviewList key={i} items={group} />
        ) : (
          <p key={i} data-origin={group.origin}>
            {group.text}
          </p>
        ),
      )}
    </>
  );
}

function itemText(block: ListItemBlock): string {
  if (block.kind !== 'task' || block.origin !== 'ai') return block.text;
  const extra = [block.owner, block.due && `due ${block.due}`].filter(Boolean).join(', ');
  return extra ? `${block.text} — ${extra}` : block.text;
}

function PreviewList({ items }: { items: ListItemBlock[] }) {
  const tasks = items[0]!.kind === 'task';
  return (
    <ul data-type={tasks ? 'taskList' : undefined} data-origin={items[0]!.origin}>
      {items.map((item, i) => {
        const children = splitByKind(item.children ?? []);
        return (
          <li key={i} data-origin={item.origin}>
            {tasks && (
              <label>
                <input type="checkbox" disabled aria-label="Action item" />
              </label>
            )}
            <div>
              <p data-origin={item.origin}>{itemText(item)}</p>
              {children.map((group, j) => (
                <PreviewList key={j} items={group} />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function splitByKind(items: ListItemBlock[]): ListItemBlock[][] {
  const out: ListItemBlock[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last[0]!.kind === item.kind) last.push(item);
    else out.push([item]);
  }
  return out;
}
