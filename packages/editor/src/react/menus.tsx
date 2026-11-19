'use client';

import { Kbd } from '@oat/ui/components/kbd';
import {
  IconBulb,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconMinus,
  IconQuote,
  IconTypography,
} from '@tabler/icons-react';

import type { MentionItem } from '../extensions.ts';
import type { SlashIcon, SlashItem } from '../slash-items.ts';
import { MenuList, type SuggestionMenuProps } from './suggestion-popup.tsx';

const SLASH_ICONS: Record<SlashIcon, React.ComponentType<{ className?: string }>> = {
  text: IconTypography,
  'heading-1': IconH1,
  'heading-2': IconH2,
  'heading-3': IconH3,
  'bullet-list': IconList,
  'ordered-list': IconListNumbers,
  'task-list': IconListCheck,
  quote: IconQuote,
  code: IconCode,
  divider: IconMinus,
  callout: IconBulb,
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
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-alpha-400 bg-background-100 text-gray-900">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-label-14 text-gray-1000">{item.title}</span>
              <span className="truncate text-label-12 text-gray-900">{item.description}</span>
            </span>
            {item.shortcut ? <Kbd className="shrink-0">{item.shortcut.trim()}</Kbd> : null}
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
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-label-12 text-gray-1000">
            {initials(item.label)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label-14 text-gray-1000">{item.label}</span>
            {item.description ? (
              <span className="truncate text-label-12 text-gray-900">{item.description}</span>
            ) : null}
          </span>
        </>
      )}
    />
  );
}
