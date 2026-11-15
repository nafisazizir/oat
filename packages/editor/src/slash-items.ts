import type { Editor, Range } from '@tiptap/core';

/** Icon keys; the React layer maps them to lucide icons (keeps this module headless). */
export type SlashIcon =
  | 'text'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'quote'
  | 'code'
  | 'divider'
  | 'callout';

export interface SlashItem {
  id: string;
  title: string;
  description: string;
  icon: SlashIcon;
  /** Extra search terms (Markdown syntax, synonyms). */
  aliases: readonly string[];
  /** Hint shown on the right: the equivalent Markdown shortcut. */
  shortcut?: string;
  run: (editor: Editor, range: Range) => void;
}

const start = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: 'text',
    aliases: ['paragraph', 'plain', 'p'],
    run: (editor, range) => start(editor, range).setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level): SlashItem => ({
    id: `heading-${level}`,
    title: `Heading ${level}`,
    description: ['Big section heading', 'Medium section heading', 'Small section heading'][
      level - 1
    ]!,
    icon: `heading-${level}`,
    aliases: [`h${level}`, 'title', 'heading'],
    shortcut: `${'#'.repeat(level)} `,
    run: (editor, range) => start(editor, range).setHeading({ level }).run(),
  })),
  {
    id: 'bullet-list',
    title: 'Bulleted list',
    description: 'A simple list',
    icon: 'bullet-list',
    aliases: ['ul', 'unordered', 'bullets', 'list'],
    shortcut: '- ',
    run: (editor, range) => start(editor, range).toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    title: 'Numbered list',
    description: 'A list with numbers',
    icon: 'ordered-list',
    aliases: ['ol', 'ordered', 'numbers', 'list'],
    shortcut: '1. ',
    run: (editor, range) => start(editor, range).toggleOrderedList().run(),
  },
  {
    id: 'task-list',
    title: 'To-do list',
    description: 'Track tasks with checkboxes',
    icon: 'task-list',
    aliases: ['todo', 'task', 'checklist', 'checkbox', 'action items'],
    shortcut: '[] ',
    run: (editor, range) => start(editor, range).toggleTaskList().run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a quote',
    icon: 'quote',
    aliases: ['blockquote', 'citation'],
    shortcut: '> ',
    run: (editor, range) => start(editor, range).setBlockquote().run(),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'Monospaced code snippet',
    icon: 'code',
    aliases: ['codeblock', 'snippet', 'pre'],
    shortcut: '``` ',
    run: (editor, range) => start(editor, range).setCodeBlock().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Separate sections',
    icon: 'divider',
    aliases: ['hr', 'horizontal rule', 'separator', 'line'],
    shortcut: '---',
    run: (editor, range) => start(editor, range).setHorizontalRule().run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Make a note stand out',
    icon: 'callout',
    aliases: ['note', 'info', 'tip', 'warning', 'admonition'],
    run: (editor, range) => start(editor, range).setCallout().run(),
  },
];

/**
 * Filter + rank slash items by a query: title prefix, then alias prefix, then substring anywhere.
 * Case-insensitive; an empty query returns every item in menu order.
 */
export function filterSlashItems(
  query: string,
  items: readonly SlashItem[] = SLASH_ITEMS,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const rank = (item: SlashItem): number => {
    const title = item.title.toLowerCase();
    const aliases = item.aliases.map((a) => a.toLowerCase());
    if (title.startsWith(q)) return 0;
    if (title.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (aliases.some((alias) => alias.startsWith(q))) return 2;
    if (title.includes(q) || aliases.some((alias) => alias.includes(q))) return 3;
    return -1;
  };
  return items
    .map((item, index) => ({ item, index, score: rank(item) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => item);
}
