'use client';

import { Button } from '@oat/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@oat/ui/components/sheet';
import { cn } from '@oat/ui/lib/utils';
import { IconSparkles } from '@tabler/icons-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { cssString, type DeepLinkFocus, focusedLine, type TranscriptLine } from './transcript';
import type { ResolvedCitation } from '@oat/services/dto/chat';
import { useAppShortcut } from '@oat/ui/hooks/use-app-shortcut';

import { AssistantChat } from './assistant-chat';
import { TranscriptReader } from './transcript-reader';
import {
  type OpenDocumentBridge,
  OpenDocumentContext,
  OpenDocumentAssistantIntegration,
  type OpenDocumentHandle,
} from './open-document';

/**
 * Where the floating "Ask about this note" button goes (9.3b). By default it floats at the bottom right of the
 * window; a page with a column of its own (the meeting note: note + transcript side panel) renders
 * `<AssistantToggleAnchor />` at the end of its note column, so the button stays over the note instead of
 * covering the transcript.
 */
type ToggleSlot = { node: React.ReactNode; claim: () => () => void };
const AssistantToggleContext = createContext<ToggleSlot | null>(null);
export function AssistantToggleButton() {
  const slot = useContext(AssistantToggleContext);
  const claim = slot?.claim;
  useEffect(() => claim?.(), [claim]);
  return slot?.node ?? null;
}

export function AssistantToggleAnchor({
  className,
  children,
  feedback,
}: {
  className?: string;
  children?: React.ReactNode;
  feedback?: React.ReactNode;
}) {
  const slot = useContext(AssistantToggleContext);
  const claim = slot?.claim;
  useEffect(() => claim?.(), [claim]);
  if (!slot?.node && !children && !feedback) return null;
  return (
    <div
      data-testid="note-bottom-bar"
      className={cn(
        'pointer-events-none sticky bottom-0 z-20 flex flex-col items-center gap-2 px-4 pt-2 pb-4 *:pointer-events-auto',
        className,
      )}
    >
      {feedback && <div className="w-full max-w-content empty:hidden">{feedback}</div>}
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-md border border-gray-alpha-300 bg-background-100 p-2">
        {children}
        {slot?.node}
      </div>
    </div>
  );
}

/** Per-browser memory of whether the panel was open (a convenience; the page works without it). */
const PANEL_KEY = 'oat.assistant.panel';
const HIGHLIGHT_MS = 6000;

/** `lg`: from here on the panel is a column beside the note; below, a modal sheet. */
const WIDE = '(min-width: 64rem)';

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

function rememberedOpen(): boolean {
  try {
    return window.localStorage.getItem(PANEL_KEY) === '1';
  } catch {
    return false;
  }
}
const hydratedSubscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    hydratedSubscribe,
    () => true,
    () => false,
  );
}

/**
 * The document page around the editor (6.4): the note's assistant panel (toggle button, ⌘J), the transcript
 * reader for `?t=&seg=` deep links, and `?block=` / citation jumps to a block of the note. The editor itself
 * is `children`; it registers with the bridge so approved assistant edits show up in it.
 */
export function DocumentAssistant({
  documentId,
  workspaceId,
  available,
  transcript,
  focus,
  children,
  onTranscriptClose,
  onOpenTranscript,
}: {
  documentId: string;
  workspaceId: string;
  /** False for a trashed note: no chat (the API refuses it too). */
  available: boolean;
  /** Loaded only when the URL asks for a transcript moment. */
  transcript: TranscriptLine[] | null;
  focus: DeepLinkFocus;
  children: React.ReactNode;
  onTranscriptClose?(): void;
  onOpenTranscript?(citation: Extract<ResolvedCitation, { kind: 'seg' }>): void;
}) {
  // `null` until the user toggles: then the remembered choice (read after hydration, so the server render
  // and the first client render agree). Only the side column is remembered: below `lg` the panel is a modal
  // sheet, and reopening it by itself on every note would cover the note the user just opened (9.3).
  const hydrated = useHydrated();
  const wide = useWide();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = available && (choice ?? (hydrated && wide && rememberedOpen()));

  const panelRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  /** Closing from inside the panel hands focus back to the toggle (it would otherwise drop to <body>). */
  const returnFocus = useRef(false);

  const toggle = useCallback(
    (next?: boolean) => {
      const value = next ?? !open;
      if (!value && panelRef.current?.contains(document.activeElement)) returnFocus.current = true;
      setChoice(value);
      if (!wide) return; // the sheet isn't remembered (see `open`)
      try {
        window.localStorage.setItem(PANEL_KEY, value ? '1' : '0');
      } catch {
        // Not remembered; fine.
      }
    },
    [open, wide],
  );

  /**
   * Escape closes the panel from anywhere inside it, also while a tooltip of one of its buttons is showing
   * (the tooltip is its own dismissable layer and takes the key first, which used to need a second press:
   * the 6.4 sheet-Escape flake). Menus, listboxes and dialogs opened from the panel keep their own Escape.
   */
  const closeOnEscape = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement;
      const layer = target.closest('[role="menu"], [role="listbox"], [role="dialog"]');
      if (layer && layer !== panelRef.current) return;
      event.preventDefault();
      toggle(false);
    },
    [toggle],
  );

  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    toggleRef.current?.focus();
  }, [open]);

  useAppShortcut('assistant', available ? () => toggle() : undefined);

  // Block jumps: scroll the editor to the block once it is rendered, highlight it for a while. A `?block=`
  // deep link starts one (state derived from the prop, React's "adjust state on prop change" pattern).
  const [highlight, setHighlight] = useState<{ id: string; n: number } | null>(() =>
    focus.block ? { id: focus.block, n: 1 } : null,
  );
  const [linkedBlock, setLinkedBlock] = useState(focus.block);
  if (focus.block !== linkedBlock) {
    setLinkedBlock(focus.block);
    if (focus.block) setHighlight({ id: focus.block, n: (highlight?.n ?? 0) + 1 });
  }
  const showBlock = useCallback((blockId: string) => {
    setHighlight((current) => ({ id: blockId, n: (current?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (!highlight) return;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="note-editor"] [data-id=${cssString(highlight.id)}]`,
      );
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (tries++ < 300) frame = requestAnimationFrame(find);
    };
    find();
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [highlight]);

  const handle = useRef<OpenDocumentHandle | null>(null);
  const bridge = useMemo<OpenDocumentBridge>(
    () => ({
      documentId,
      register: (next) => {
        handle.current = next;
      },
      handle: () => handle.current,
      showBlock,
    }),
    [documentId, showBlock],
  );

  // Closing the reader hides it at once (the URL update re-renders the page without it).
  const focusKey = `${focus.seg ?? ''}|${focus.t ?? ''}`;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const focusId = transcript ? focusedLine(transcript, focus) : undefined;
  const showTranscript = transcript !== null && dismissedKey !== focusKey;

  // The floating toggle: in the page's anchor when it has one (9.3b), else fixed to the window corner.
  const [anchored, setAnchored] = useState(0);
  const claim = useCallback(() => {
    setAnchored((n) => n + 1);
    return () => setAnchored((n) => n - 1);
  }, []);
  const toggleButton =
    available && !open ? (
      <Button
        ref={toggleRef}
        size="sm"
        variant="ghost"
        data-testid="assistant-toggle"
        aria-keyshortcuts="Meta+J"
        onClick={() => toggle(true)}
        className={cn(
          'bg-background-100 px-3 hover:bg-gray-alpha-100',
          !anchored && 'fixed end-6 bottom-6 z-20',
        )}
      >
        <IconSparkles data-icon="inline-start" className="text-brand-800" />
        Ask about this note
      </Button>
    ) : null;
  const toggleSlot: ToggleSlot = { node: anchored ? toggleButton : null, claim };

  const chat = (
    <AssistantChat
      scope={{ kind: 'document', documentId }}
      workspaceId={workspaceId}
      layout="panel"
      onClose={() => toggle(false)}
    />
  );

  return (
    <OpenDocumentContext.Provider value={bridge}>
      <OpenDocumentAssistantIntegration onOpenTranscript={onOpenTranscript}>
        <AssistantToggleContext.Provider value={toggleSlot}>
          <div className="flex min-h-0 flex-1" data-highlight-block={highlight?.id}>
            {highlight && (
              <style>{`[data-testid="note-editor"] [data-id=${cssString(highlight.id)}]{background:var(--selection);border-radius:calc(var(--radius) * 0.75);box-shadow:0 0 0 0.25rem var(--selection);transition:background var(--duration-slow) var(--easing-standard)}`}</style>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {children}
              {showTranscript && (
                <div className="mx-auto w-full max-w-content px-6 pb-14 sm:px-8">
                  <TranscriptReader
                    lines={transcript}
                    focusId={focusId}
                    onClose={() => {
                      setDismissedKey(focusKey);
                      onTranscriptClose?.();
                    }}
                  />
                </div>
              )}
            </div>
            {available && open && wide && (
              <aside
                ref={panelRef}
                aria-label="Assistant"
                data-testid="assistant-panel"
                // Capture: runs before the focused element's handlers, whatever a tooltip did with the key.
                onKeyDownCapture={closeOnEscape}
                className="sticky top-12 flex h-[calc(100svh-3rem)] w-96 shrink-0 flex-col border-s border-gray-alpha-400 bg-background-100 xl:w-[26rem]"
              >
                {chat}
              </aside>
            )}
          </div>
          {available && !wide && (
            <Sheet open={open} onOpenChange={(value) => toggle(value)}>
              <SheetContent
                ref={panelRef as React.Ref<HTMLDivElement>}
                side="right"
                showCloseButton={false}
                aria-describedby={undefined}
                data-testid="assistant-panel"
                // Focus goes back to the toggle via our effect.
                finalFocus={false}
                onKeyDownCapture={closeOnEscape}
                className="gap-0 bg-background-100 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
              >
                <SheetTitle className="sr-only">Assistant</SheetTitle>
                {chat}
              </SheetContent>
            </Sheet>
          )}
          {!anchored && toggleButton}
        </AssistantToggleContext.Provider>
      </OpenDocumentAssistantIntegration>
    </OpenDocumentContext.Provider>
  );
}
