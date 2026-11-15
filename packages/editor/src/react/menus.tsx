'use client';

import {
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  LightbulbIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  MinusIcon,
  TextIcon,
  TextQuoteIcon,
} from 'lucide-react';

import type { MentionItem } from '../extensions.ts';
import type { SlashIcon, SlashItem } from '../slash-items.ts';
import { MenuList, type SuggestionMenuProps } from './suggestion-popup.tsx';

const SLASH_ICONS: Record<SlashIcon, LucideIcon> = {
  text: TextIcon,
  'heading-1': Heading1Icon,
  'heading-2': Heading2Icon,
  'heading-3': Heading3Icon,
  'bullet-list': ListIcon,
  'ordered-list': ListOrderedIcon,
  'task-list': ListChecksIcon,
  quote: TextQuoteIcon,
  code: CodeIcon,
  divider: MinusIcon,
  callout: LightbulbIcon,
};

/** The `/` block menu. */
export function SlashMenu({ items, command, editor, ref }: SuggestionMenuProps<SlashItem>) {
  return (
    <MenuList
      handleRef={ref}
      controller={editor.view.dom}
      items={items}
      onSelect={command}
      getKey={(item) => item.id}
      label="Insert block"
      empty="No matching blocks"
      renderItem={(item) => {
        const Icon = SLASH_ICONS[item.icon];
        return (
          <>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.title}</span>
              <span className="truncate text-xs text-muted-foreground">{item.description}</span>
            </span>
            {item.shortcut ? (
              <kbd className="shrink-0 font-mono text-xs text-muted-foreground">
                {item.shortcut.trim()}
              </kbd>
            ) : null}
          </>
        );
      }}
    />
  );
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** The `@` people menu. */
export function MentionMenu({
  items,
  command,
  loading,
  editor,
  ref,
}: SuggestionMenuProps<MentionItem>) {
  return (
    <MenuList
      handleRef={ref}
      controller={editor.view.dom}
      items={items}
      onSelect={command}
      loading={loading}
      getKey={(item) => item.id}
      label="Mention a person"
      empty="No people found"
      className="w-64"
      renderItem={(item) => (
        <>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-me text-xs font-semibold text-me-foreground">
            {initials(item.label)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{item.label}</span>
            {item.description ? (
              <span className="truncate text-xs text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
        </>
      )}
    />
  );
}
