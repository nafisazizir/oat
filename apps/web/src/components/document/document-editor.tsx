'use client';

import type { JSONContent } from '@oat/editor';
import { OatEditor, type OatEditorProps } from '@oat/editor/react';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  AlertCircleIcon,
  CheckIcon,
  EyeIcon,
  LinkIcon,
  Loader2Icon,
  LockIcon,
  RotateCcwIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTreeActions } from '@/components/app-shell/tree-actions';
import { NotionExportButton } from '@/components/notion/notion-export-button';
import { PageContainer } from '@/components/page';
import type { DocumentDetail } from '@/lib/api-types';
import { formatDay } from '@/lib/format';
import { documentNode } from '@/lib/tree';

import { ShareDialog } from './share-dialog';
import { type SaveState, useAutosave } from './use-autosave';

type Editor = Parameters<NonNullable<OatEditorProps['onReady']>>[0];

const isEmptyDoc = (doc: JSONContent) =>
  !doc.content?.length ||
  (doc.content.length === 1 && doc.content[0]!.type === 'paragraph' && !doc.content[0]!.content);

/**
 * The document page body: title + `OatEditor`, autosaved (≤ 1 s after a change) through
 * `PATCH /api/documents/:id` with the version it was loaded at. Read-only for viewers and while the
 * document is in the trash (with a Restore / Delete forever banner).
 *
 * Content and title live in local state from the first render on: server re-renders (`router.refresh()`
 * after a title save updates the sidebar) pass a fresh `document` prop, but only its metadata (access,
 * trash state) is used, so a refresh never overwrites what the user is typing.
 */
export function DocumentEditor({
  document: doc,
  workspaceName,
}: {
  document: DocumentDetail;
  workspaceName: string;
}) {
  const router = useRouter();
  const actions = useTreeActions();
  const [title, setTitle] = useState(doc.title);
  const [initialContent] = useState(doc.contentJson);
  const [updatedAt, setUpdatedAt] = useState(doc.updatedAt);
  const editorRef = useRef<Editor | null>(null);
  const trashed = doc.deletedAt !== null;
  const editable = doc.access.edit && !trashed;
  const [autoFocusTitle] = useState(() => editable && !doc.title && isEmptyDoc(doc.contentJson));

  const autosave = useAutosave({
    id: doc.id,
    version: doc.version,
    initial: { title: doc.title, contentJson: doc.contentJson },
    enabled: editable,
    onSaved: (saved, patch) => {
      setUpdatedAt(saved.updatedAt);
      // The sidebar, breadcrumbs and tab title show the title: re-render the shell.
      if (patch.title !== undefined) router.refresh();
    },
    onExternalChange: (change) => setTitle(change.title),
  });

  const { discard } = autosave;
  /** Reload to the server copy, without the "unsaved changes" prompt: the user chose to drop them. */
  const reload = useCallback(() => {
    discard();
    window.location.reload();
  }, [discard]);

  useEffect(() => {
    if (autosave.state === 'conflict') {
      toast.error('This note changed elsewhere', {
        id: `conflict-${doc.id}`,
        description: 'Reload to see the latest version. Your recent edits here weren’t saved.',
        duration: Infinity,
        action: { label: 'Reload', onClick: reload },
      });
    }
  }, [autosave.state, doc.id, reload]);

  const node = documentNode(doc);

  return (
    <PageContainer className="gap-6">
      {trashed && (
        <div
          role="status"
          data-testid="trash-banner"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
        >
          <Trash2Icon className="size-4 text-destructive" />
          <span className="flex-1">This page is in the trash.</span>
          {doc.access.delete && (
            <>
              <Button size="sm" variant="outline" onClick={() => void actions.restore(node)}>
                <RotateCcwIcon data-icon="inline-start" />
                Restore
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void actions.deleteForever(node)}
              >
                Delete forever
              </Button>
            </>
          )}
        </div>
      )}

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <VisibilityBadge visibility={doc.visibility} workspaceName={workspaceName} />
          {trashed ? (
            <Badge variant="outline" className="gap-1">
              <Trash2Icon />
              In trash
            </Badge>
          ) : (
            !doc.access.edit && (
              <Badge variant="outline" className="gap-1">
                <EyeIcon />
                View only
              </Badge>
            )
          )}
          <span>Edited {formatDay(updatedAt)}</span>
          {editable && (
            <SaveStatus
              state={autosave.state}
              error={autosave.error}
              onRetry={autosave.retry}
              onReload={reload}
            />
          )}
          {!trashed && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <NotionExportButton documentId={doc.id} beforeSend={autosave.flush} />
              <ShareDialog documentId={doc.id} />
            </div>
          )}
        </div>
        <textarea
          aria-label="Title"
          data-testid="document-title"
          value={title}
          readOnly={!editable}
          placeholder="Untitled"
          rows={1}
          maxLength={200}
          autoFocus={autoFocusTitle}
          className="w-full resize-none bg-transparent font-heading text-3xl font-medium [field-sizing:content] outline-none placeholder:text-muted-foreground/60"
          onChange={(event) => {
            const next = event.target.value.replace(/\n/g, ' ');
            setTitle(next);
            autosave.queue({ title: next });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              editorRef.current?.commands.focus('start');
            }
          }}
        />
      </header>

      <OatEditor
        value={initialContent}
        editable={editable}
        aria-label="Note"
        placeholder={editable ? 'Write something, or press / for blocks' : false}
        onReady={(editor) => {
          editorRef.current = editor;
        }}
        onChange={(json) => autosave.queue({ contentJson: json })}
        className="min-h-64"
      />
    </PageContainer>
  );
}

function VisibilityBadge({
  visibility,
  workspaceName,
}: {
  visibility: DocumentDetail['visibility'];
  workspaceName: string;
}) {
  const [Icon, label] =
    visibility === 'private'
      ? [LockIcon, 'Private']
      : visibility === 'link'
        ? [LinkIcon, `Shared with ${workspaceName} + link`]
        : [UsersIcon, `Shared with ${workspaceName}`];
  return (
    <Badge variant="secondary" className="gap-1">
      <Icon />
      {label}
    </Badge>
  );
}

function SaveStatus({
  state,
  error,
  onRetry,
  onReload,
}: {
  state: SaveState;
  error: string | null;
  onRetry: () => void;
  onReload: () => void;
}) {
  const base = 'inline-flex items-center gap-1';
  switch (state) {
    case 'idle':
      return null;
    case 'pending':
    case 'saving':
      return (
        <span className={base} data-testid="save-status" data-state="saving" aria-live="polite">
          <Loader2Icon className="size-3 animate-spin" />
          Saving…
        </span>
      );
    case 'saved':
      return (
        <span className={base} data-testid="save-status" data-state="saved" aria-live="polite">
          <CheckIcon className="size-3" />
          Saved
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} text-destructive`}
          data-testid="save-status"
          data-state="error"
          role="alert"
          title={error ?? undefined}
        >
          <AlertCircleIcon className="size-3" />
          Couldn’t save
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>
            Retry
          </button>
        </span>
      );
    case 'conflict':
      return (
        <span
          className={`${base} text-destructive`}
          data-testid="save-status"
          data-state="conflict"
          role="alert"
        >
          <AlertCircleIcon className="size-3" />
          Changed elsewhere ·
          <button type="button" className="underline underline-offset-2" onClick={onReload}>
            Reload
          </button>
        </span>
      );
  }
}
