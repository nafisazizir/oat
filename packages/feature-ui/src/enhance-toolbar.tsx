'use client';

import { Button } from '@oat/ui/components/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@oat/ui/components/alert-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@oat/ui/components/dropdown-menu';
import { IconArrowBackUp, IconHistory, IconNotes } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';

import { EnhanceButton } from './enhance-controls';
import { type HistorySelection, NoteHistoryDialog } from './note-history';
import type { Enhancement } from './use-enhancement';
import type { NoteVersions, ReplaceKind } from './use-note-versions';

const SAVED = 'Your current note is saved in Note history first, so you can bring it back.';

/** D-20: what to say before replacing a note that matches nothing stored (the user's own edits). */
const CONFIRM: Record<ReplaceKind, { title: string; description: string; action: string }> = {
  regenerate: {
    title: 'Regenerate over your edits?',
    description: `You changed this note since it was enhanced. Regenerating replaces it with new notes written from your own lines and the transcript. ${SAVED}`,
    action: 'Regenerate',
  },
  undo: {
    title: 'Undo over your edits?',
    description: `This puts back the notes you wrote before the last enhancement and replaces the changes you made since. ${SAVED}`,
    action: 'Undo enhancement',
  },
  redo: {
    title: 'Redo over your edits?',
    description: `This puts the enhanced notes back and replaces the changes you made since the undo. ${SAVED}`,
    action: 'Redo',
  },
  restore: {
    title: 'Replace your edited note?',
    description: `Restoring replaces the current note, including the changes you made to it. ${SAVED}`,
    action: 'Restore',
  },
};

/** When the check itself failed: ask anyway (fail safe), without claiming there are edits. */
const UNCHECKED = {
  title: 'Replace the current note?',
  description:
    'Oat couldn’t check whether this note has changes that aren’t in Note history. If it does, they’ll be saved there before the note is replaced.',
};

/**
 * Splits the enhance UI so the Enhance / Regenerate button sits inline in the metadata row under the title,
 * History sits inside the top-bar More menu, and the history + D-20 replace-confirm dialogs stay mounted
 * alongside the note.
 */
export function useEnhanceControls({
  enhancement,
  versions,
}: {
  enhancement: Enhancement;
  versions: NoteVersions;
}) {
  const latest = versions.list?.versions[0];
  const hasHistory = Boolean(latest || versions.list?.snapshots.length);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selection, setSelection] = useState<HistorySelection>({ kind: 'original' });

  const openHistory = (next: HistorySelection) => {
    setSelection(next);
    setHistoryOpen(true);
    void versions.refresh();
  };

  const restore = (target: HistorySelection) => {
    void versions.guard('restore', async () => {
      const list = versions.list;
      let ok: boolean;
      let message: string;
      if (target.kind === 'original') {
        const newest = (await versions.refresh())?.versions[0];
        if (!newest) return;
        ok = await versions.restore(newest.id, 'notes');
        message = 'Your original notes are back';
      } else if (target.kind === 'snapshot') {
        ok = await versions.restore(target.id, 'output');
        message = 'Your edited note is back';
      } else {
        ok = await versions.restore(target.id, 'output');
        const number = list?.versions.find((v) => v.id === target.id)?.number;
        message = number ? `Version ${number} restored` : 'Version restored';
      }
      if (!ok) return;
      setHistoryOpen(false);
      toast.success(message, { id: versions.toastId });
    });
  };

  const pending = versions.pending;
  const copy = pending
    ? pending.unchecked
      ? { ...CONFIRM[pending.kind], ...UNCHECKED }
      : CONFIRM[pending.kind]
    : null;

  const enhanceButton = (workspaceId: string): ReactNode => (
    <EnhanceButton
      enhancement={enhancement}
      workspaceId={workspaceId}
      regenerate={Boolean(latest)}
      onStart={(input) =>
        void versions.guard('regenerate', () => {
          toast.dismiss(versions.toastId);
          // "Regenerate" repeats the newest version's template unless one was picked.
          const templateId = input?.templateId ?? latest?.templateId ?? undefined;
          void enhancement.start(templateId ? { ...input, templateId } : input);
        })
      }
    >
      {latest && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="enhance-history"
            onClick={() => openHistory({ kind: 'version', id: latest.id })}
          >
            <IconHistory />
            Note history
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="enhance-original"
            onClick={() => openHistory({ kind: 'original' })}
          >
            <IconNotes />
            Show my original notes
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="enhance-undo"
            disabled={versions.restoring || versions.checking}
            onClick={() => versions.undo()}
          >
            <IconArrowBackUp />
            Undo enhancement
          </DropdownMenuItem>
        </>
      )}
    </EnhanceButton>
  );

  const historyAction: ReactNode = hasHistory ? (
    <Button
      size="sm"
      variant="ghost"
      data-testid="history-button"
      onClick={() =>
        openHistory(latest ? { kind: 'version', id: latest.id } : { kind: 'original' })
      }
    >
      <IconHistory data-icon="inline-start" />
      History
    </Button>
  ) : null;

  const dialogs: ReactNode = (
    <>
      <NoteHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        versions={versions}
        selection={selection}
        onSelect={setSelection}
        onRestore={restore}
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && versions.cancelPending()}
      >
        <AlertDialogContent data-testid="replace-confirm">
          {copy && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.title}</AlertDialogTitle>
                <AlertDialogDescription>{copy.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={versions.cancelPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="replace-confirm-action"
                  onClick={versions.confirmPending}
                >
                  {copy.action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { enhanceButton, historyAction, dialogs };
}

export function EnhanceToolbar({
  enhancement,
  versions,
  workspaceId,
  renderSecondaryActions = (history) => history,
}: {
  enhancement: Enhancement;
  versions: NoteVersions;
  workspaceId: string;
  renderSecondaryActions?: (history: ReactNode) => ReactNode;
}) {
  const { enhanceButton, historyAction, dialogs } = useEnhanceControls({ enhancement, versions });
  return (
    <>
      {enhanceButton(workspaceId)}
      {renderSecondaryActions(historyAction)}
      {dialogs}
    </>
  );
}
