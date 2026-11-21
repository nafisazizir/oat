'use client';

/**
 * A collapsible, resizable side panel (the meeting view's transcript, desktop + web). The width is dragged on
 * the left edge (or set with the keyboard on the focused handle: ←/→ by 16 px, Home/End) and kept per
 * browser/app under `storageKey`; whether it is open is the caller's state (often `useStoredState`).
 */
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { IconX } from '@tabler/icons-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { clampWidth } from './format.ts';
import { usePanelEscape } from './panel-escape.ts';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; fine.
  }
}

/**
 * A value remembered in `localStorage` (a per-browser convenience; works without it). The first render uses
 * `initial` (server render and hydration agree), the stored value follows right after mount.
 */
export function useStoredState<T extends string | number | boolean>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const raw = readStored(key);
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount (hydration-safe)
    if (typeof parsed === typeof initial) setValue(parsed as T);
  }, [key, initial]);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, JSON.stringify(next));
    },
    [key],
  );
  return [value, set];
}

const STEP = 16;

export interface SidePanelProps {
  id?: string;
  title: ReactNode;
  /** Extra header content (a count, a status) after the title. */
  meta?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function SidePanel({
  title,
  meta,
  onClose,
  closeLabel,
  storageKey,
  defaultWidth = 360,
  minWidth = 260,
  maxWidth = 640,
  className,
  children,
  ...rest
}: SidePanelProps) {
  usePanelEscape(true, onClose);
  const [stored, setStored] = useStoredState(storageKey, defaultWidth);
  const width = clampWidth(stored, minWidth, maxWidth, defaultWidth);
  const [dragging, setDragging] = useState(false);

  const setWidth = (next: number) => setStored(clampWidth(next, minWidth, maxWidth, defaultWidth));

  // Dragging follows the pointer anywhere in the window until it is released.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const start = { x: event.clientX, width };
    const move = (e: globalThis.PointerEvent) => {
      // The handle is on the panel's left edge: dragging left widens it.
      setStored(clampWidth(start.width + (start.x - e.clientX), minWidth, maxWidth, defaultWidth));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stopDrag.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stopDrag.current = end;
    setDragging(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width + STEP
        : event.key === 'ArrowRight'
          ? width - STEP
          : event.key === 'Home'
            ? maxWidth
            : event.key === 'End'
              ? minWidth
              : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
  };

  return (
    <aside
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col border-s border-gray-alpha-400 bg-background-100',
        className,
      )}
      style={{ width }}
      data-width={width}
      {...rest}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        data-testid="panel-resize"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          'group absolute inset-y-0 -start-1.5 z-10 w-3 cursor-col-resize outline-none',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors after:duration-fast',
          'hover:after:w-0.5 hover:after:bg-gray-500 focus-visible:after:w-0.5 focus-visible:after:bg-gray-600',
          dragging && 'after:w-0.5 after:bg-gray-600',
        )}
      />
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-alpha-400 ps-4 pe-2">
        <h2 className="flex min-w-0 items-center gap-2 text-label-14 text-gray-1000">{title}</h2>
        {meta}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ms-auto"
          aria-label={closeLabel}
          onClick={onClose}
          data-testid="panel-close"
        >
          <IconX />
        </Button>
      </header>
      {children}
    </aside>
  );
}
