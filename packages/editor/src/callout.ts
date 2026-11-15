import { mergeAttributes, Node } from '@tiptap/core';

export const CALLOUT_VARIANTS = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

export interface CalloutAttributes {
  emoji: string;
  variant: CalloutVariant;
}

export const DEFAULT_CALLOUT: CalloutAttributes = { emoji: '💡', variant: 'neutral' };

export function isCalloutVariant(value: unknown): value is CalloutVariant {
  return typeof value === 'string' && (CALLOUT_VARIANTS as readonly string[]).includes(value);
}
const isVariant = isCalloutVariant;

/** Longest emoji we store (UTF-16 units) — ZWJ family sequences fit; prose doesn't. */
export const MAX_EMOJI_LENGTH = 16;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One short grapheme (e.g. "💡", "👩🏽‍💻"); anything else falls back to the default emoji. */
export function normalizeCalloutEmoji(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CALLOUT.emoji;
  const first = graphemes.segment(value.trim())[Symbol.iterator]().next().value?.segment;
  return first && first.length <= MAX_EMOJI_LENGTH ? first : DEFAULT_CALLOUT.emoji;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selected blocks in a callout. */
      setCallout: (attributes?: Partial<CalloutAttributes>) => ReturnType;
      /** Wrap in a callout, or lift out of one. */
      toggleCallout: (attributes?: Partial<CalloutAttributes>) => ReturnType;
      /** Lift the selected blocks out of their callout. */
      unsetCallout: () => ReturnType;
      /** Change the emoji / variant of the surrounding callout. */
      updateCallout: (attributes: Partial<CalloutAttributes>) => ReturnType;
    };
  }
}

/**
 * Notion-style callout: a tinted box with an emoji, holding any blocks.
 * HTML: `<div data-type="callout" data-emoji data-variant><span data-callout-emoji/><div data-callout-content>…`.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: DEFAULT_CALLOUT.emoji,
        parseHTML: (element) => normalizeCalloutEmoji(element.getAttribute('data-emoji')),
        renderHTML: (attributes) => ({ 'data-emoji': normalizeCalloutEmoji(attributes.emoji) }),
      },
      variant: {
        default: DEFAULT_CALLOUT.variant,
        parseHTML: (element) => {
          const value = element.getAttribute('data-variant');
          return isVariant(value) ? value : DEFAULT_CALLOUT.variant;
        },
        renderHTML: (attributes) => ({
          'data-variant': isVariant(attributes.variant)
            ? attributes.variant
            : DEFAULT_CALLOUT.variant,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
        contentElement: (dom) =>
          (dom as HTMLElement).querySelector<HTMLElement>(':scope > [data-callout-content]') ??
          (dom as HTMLElement),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes({ 'data-type': 'callout' }, HTMLAttributes),
      [
        'span',
        { 'data-callout-emoji': '', contenteditable: 'false', 'aria-hidden': 'true' },
        normalizeCalloutEmoji(node.attrs.emoji),
      ],
      ['div', { 'data-callout-content': '' }, 0],
    ];
  },

  renderText({ node }) {
    return `${normalizeCalloutEmoji(node.attrs.emoji)} `;
  },

  addCommands() {
    return {
      setCallout:
        (attributes) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { ...DEFAULT_CALLOUT, ...attributes }),
      toggleCallout:
        (attributes) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { ...DEFAULT_CALLOUT, ...attributes }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      updateCallout:
        (attributes) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attributes),
    };
  },
});
