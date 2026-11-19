'use client';

import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from '@tiptap/suggestion';
import {
  type ComponentType,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { cn } from '@oat/ui/lib/utils';

/** Imperative handle every popup menu exposes so the editor can forward arrow/enter keys. */
export interface SuggestionMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export type SuggestionMenuProps<I> = SuggestionProps<I, I> & { ref?: Ref<SuggestionMenuHandle> };

/**
 * Wires a React menu component to a TipTap suggestion plugin: renders it into a floating element
 * (positioned by the plugin's `mount`), forwards keys to it and tears it down on exit.
 */
export function createSuggestionPopup<I>(
  Component: ComponentType<SuggestionMenuProps<I>>,
): NonNullable<SuggestionOptions<I, I>['render']> {
  return () => {
    let renderer: ReactRenderer<SuggestionMenuHandle, SuggestionMenuProps<I>> | undefined;
    let unmount: (() => void) | undefined;
    return {
      onStart: (props) => {
        renderer = new ReactRenderer(Component, {
          props,
          editor: props.editor,
          className: 'oat-editor-popup z-50',
        });
        unmount = props.mount(renderer.element);
      },
      onUpdate: (props) => renderer?.updateProps(props),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === 'Escape') return true;
        return renderer?.ref?.onKeyDown(event) ?? false;
      },
      onExit: () => {
        unmount?.();
        renderer?.destroy();
        renderer = undefined;
        unmount = undefined;
      },
    };
  };
}

interface MenuListProps<I> {
  items: readonly I[];
  onSelect: (item: I) => void;
  getKey: (item: I) => string;
  renderItem: (item: I) => ReactNode;
  /** Accessible name of the listbox. */
  label: string;
  empty: string;
  loading?: boolean;
  handleRef?: Ref<SuggestionMenuHandle>;
  /**
   * The element that keeps focus while the menu is open (the editor). It gets the combobox
   * attributes — aria-expanded, aria-controls, aria-autocomplete, aria-activedescendant — so
   * screen readers announce the active option.
   */
  controller?: HTMLElement;
  className?: string;
}

/**
 * Keyboard-navigable listbox shared by the slash and mention menus. The editor keeps focus; keys
 * arrive through `handleRef.onKeyDown` (ArrowUp/Down wrap, Enter/Tab select).
 */
export function MenuList<I>({
  items,
  onSelect,
  getKey,
  renderItem,
  label,
  empty,
  loading = false,
  handleRef,
  controller,
  className,
}: MenuListProps<I>) {
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const [active, setActive] = useState(0);
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setActive(0);
  }
  const listRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(handleRef, () => ({
    onKeyDown: (event) => {
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        if (items.length) setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        if (items.length) setActive((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[active];
        if (!item) return false;
        onSelect(item);
        return true;
      }
      return false;
    },
  }));

  useEffect(() => {
    if (!controller) return;
    controller.setAttribute('aria-expanded', 'true');
    controller.setAttribute('aria-controls', listboxId);
    controller.setAttribute('aria-autocomplete', 'list');
    return () => {
      for (const name of ['aria-expanded', 'aria-controls', 'aria-autocomplete']) {
        controller.removeAttribute(name);
      }
    };
  }, [controller, listboxId]);

  const activeId = items.length > 0 ? optionId(active) : undefined;
  useEffect(() => {
    if (!controller) return;
    if (activeId) controller.setAttribute('aria-activedescendant', activeId);
    else controller.removeAttribute('aria-activedescendant');
    return () => controller.removeAttribute('aria-activedescendant');
  }, [controller, activeId]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={label}
      className={cn(
        'max-h-80 w-72 overflow-y-auto rounded-lg material-menu p-1 text-label-14 text-gray-1000',
        className,
      )}
    >
      {items.length === 0 ? (
        <div className="px-2 py-1.5 text-label-14 text-gray-900">
          {loading ? 'Loading…' : empty}
        </div>
      ) : (
        items.map((item, index) => (
          <div
            key={getKey(item)}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            data-index={index}
            className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none select-none aria-selected:bg-gray-alpha-200"
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActive(index)}
            onClick={() => onSelect(item)}
          >
            {renderItem(item)}
          </div>
        ))
      )}
    </div>
  );
}
