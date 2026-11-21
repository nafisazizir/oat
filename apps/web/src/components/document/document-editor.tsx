'use client';

import type { JSONContent } from '@oat/editor';
import { OatEditor, type OatEditorProps } from '@oat/editor/react';
import { Alert, AlertAction, AlertTitle } from '@oat/ui/components/alert';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconCheck,
  IconDots,
  IconEye,
  IconLink,
  IconLock,
  IconRestore,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTreeActions } from '@/components/app-shell/tree-actions';
import { useRegisterOpenDocument } from '@/components/assistant/open-document';
import { NotionExportButton } from '@/components/notion/notion-export-button';
import { PipelineStatus } from '@/components/pipeline/pipeline-status';
import { useTaskAssignees } from '@/components/tasks/tasks-client';
import { PageContainer } from '@/components/page';
import { announceDocumentChange } from '@/lib/api-client';
import type { DocumentDetail } from '@/lib/api-types';
import { formatDay } from '@/lib/format';
import { documentNode } from '@/lib/tree';
import { audienceLabel, type WorkspaceAudience } from '@/lib/workspace';

import { EnhanceError } from './enhance/enhance-controls';
import { EnhancePreview } from './enhance/enhance-preview';
import { EnhanceToolbar } from './enhance/enhance-toolbar';
import { useEnhancement } from './enhance/use-enhancement';
import { noteToastId, useNoteVersions } from './enhance/use-note-versions';
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
  workspace,
  meta,
  headerActions,
  overflowActions,
}: {
  document: DocumentDetail;
  /** The document's workspace: who "workspace" visibility reaches. */
  workspace: WorkspaceAudience;
  /** Shown under the title (the meeting header of a meeting note, 3.4). */
  meta?: React.ReactNode;
  headerActions?: React.ReactNode;
  overflowActions?: React.ReactNode;
}) {
  const router = useRouter();
  const actions = useTreeActions();
  const headerRef = useRef<HTMLElement>(null);
  const compact = useNarrow(headerRef, COMPACT_HEADER_PX);
  const secondaryActions = (history: React.ReactNode) => (
    <NotionExportButton
      documentId={doc.id}
      beforeSend={autosave.flush}
      fallback={
        history || overflowActions ? (
          <MoreActions>
            {history}
            {overflowActions}
          </MoreActions>
        ) : null
      }
      wrap={(control) => (
        <MoreActions>
          {history}
          {control}
          {overflowActions}
        </MoreActions>
      )}
    />
  );
  const [title, setTitle] = useState(doc.title);
  // The editor's content: as loaded, then replaced when an enhancement lands (4.4).
  const [content, setContent] = useState(doc.contentJson);
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
      // The note changed: an "Undo"/"Redo" toast from before no longer means what it says.
      if (patch.contentJson !== undefined) toast.dismiss(noteToastId(doc.id));
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

  // The assistant panel (6.4) saves pending edits before approving a change and shows the result here.
  useRegisterOpenDocument(doc.id, {
    settle: autosave.settle,
    adopt: (next) => {
      autosave.adopt(next);
      setUpdatedAt(new Date().toISOString());
    },
    replace: (next) => {
      autosave.adopt(next);
      setContent(next.contentJson);
      setUpdatedAt(new Date().toISOString());
    },
    editor: () => editorRef.current,
  });

  const isMeeting = doc.kind === 'meeting';
  /** The server wrote a new body (enhancement applied, version restored, undo): show it, save on top of it. */
  const showServerBody = (next: {
    version: number;
    contentJson: JSONContent;
    updatedAt: string;
  }) => {
    autosave.adopt(next);
    setContent(next.contentJson);
    setUpdatedAt(next.updatedAt);
    announceDocumentChange({ id: doc.id, version: next.version, title });
  };
  // Versions, restore and undo (4.5): editors only.
  const versions = useNoteVersions({
    documentId: doc.id,
    enabled: isMeeting && editable,
    settle: autosave.settle,
    currentVersion: autosave.currentVersion,
    onRestored: showServerBody,
  });
  const enhancement = useEnhancement({
    documentId: doc.id,
    loadedVersion: doc.version,
    enabled: isMeeting && !trashed,
    beforeStart: autosave.settle,
    onCompleted: ({ enhancement: run, doc: enhanced }) => {
      void versions.refresh();
      if (run.applied && run.documentVersion !== null) {
        showServerBody({
          version: run.documentVersion,
          contentJson: enhanced,
          updatedAt: run.completedAt ?? new Date().toISOString(),
        });
        toast.success('Notes enhanced', {
          id: noteToastId(doc.id),
          description: 'Your own lines stay in full ink; what the AI added is softer.',
          ...(editable ? { action: { label: 'Undo', onClick: () => versions.undo() } } : {}),
        });
        return;
      }
      // D-20: edited while the AI was writing — keep the user's body, offer the enhanced version (editors).
      if (!editable) return;
      toast('This note changed while the AI was writing', {
        id: `enhanced-${run.id}`,
        description: 'Your edits were kept. The enhanced version is saved too.',
        duration: Infinity,
        action: {
          label: 'Use enhanced version',
          onClick: () => {
            setContent(enhanced);
            autosave.queue({ contentJson: enhanced });
          },
        },
      });
    },
  });

  const streaming = enhancement.state.phase === 'streaming';
  // 8.4: the task owner picker offers the workspace's members and the meeting's attendees.
  const taskAssignees = useTaskAssignees(doc.id);
  const node = documentNode(doc);

  return (
    <PageContainer className="gap-6">
      {trashed && (
        <Alert role="status" data-testid="trash-banner" className="bg-background-200">
          <IconTrash />
          <AlertTitle>This page is in the trash.</AlertTitle>
          {doc.access.delete && (
            <AlertAction className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void actions.restore(node)}>
                <IconRestore data-icon="inline-start" />
                Restore
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void actions.deleteForever(node)}
              >
                Delete forever
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      <header ref={headerRef} className="flex flex-col gap-3">
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-label-13 text-gray-900">
          <VisibilityBadge visibility={doc.visibility} workspace={workspace} />
          {!trashed && !doc.access.edit && (
            <Badge variant="outline">
              <IconEye data-icon="inline-start" />
              View only
            </Badge>
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
            <>
              {isMeeting && (
                <PipelineStatus
                  documentId={doc.id}
                  canRun={editable}
                  onEnhancing={enhancement.follow}
                />
              )}
              <div
                className={
                  // Narrow (transcript + assistant open): the actions get a tidy row of their own.
                  compact
                    ? 'flex w-full shrink-0 items-center gap-2'
                    : 'ms-auto flex shrink-0 items-center gap-2'
                }
                data-testid="document-actions"
                data-compact={compact || undefined}
              >
                {headerActions}
                {editable && isMeeting ? (
                  <EnhanceToolbar
                    enhancement={enhancement}
                    versions={versions}
                    workspaceId={doc.workspaceId}
                    renderSecondaryActions={secondaryActions}
                  />
                ) : (
                  secondaryActions(null)
                )}
                <ShareDialog documentId={doc.id} />
              </div>
            </>
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
          className="w-full resize-none bg-transparent text-heading-32 text-gray-1000 caret-gray-1000 [field-sizing:content] outline-none placeholder:text-gray-700"
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
        {meta}
      </header>

      <EnhanceError enhancement={enhancement} />

      {enhancement.state.phase === 'streaming' && (
        <EnhancePreview output={enhancement.state.preview} />
      )}
      {/*
        The editor stays mounted (hidden, read-only) while the AI writes: if the run fails, is lost or isn't
        applied, it comes back exactly as the user left it — never re-created from the page-load body.
      */}
      <div hidden={streaming} data-testid="note-editor">
        <OatEditor
          value={content}
          editable={editable && !streaming}
          aria-label="Note"
          placeholder={editable ? 'Write something, or press / for blocks' : false}
          onReady={(editor) => {
            editorRef.current = editor;
          }}
          onChange={(json) => autosave.queue({ contentJson: json })}
          onTaskAssigneeQuery={taskAssignees}
          className="min-h-64"
        />
      </div>
    </PageContainer>
  );
}

function VisibilityBadge({
  visibility,
  workspace,
}: {
  visibility: DocumentDetail['visibility'];
  workspace: WorkspaceAudience;
}) {
  const [Icon, label] =
    visibility === 'private'
      ? [IconLock, 'Private']
      : visibility === 'link'
        ? [IconLink, `${audienceLabel(workspace)} + link`]
        : [workspace.kind === 'personal' ? IconLock : IconUsers, audienceLabel(workspace)];
  return (
    <Badge variant="secondary" data-testid="visibility-badge">
      <Icon data-icon="inline-start" />
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
  const base = 'inline-flex min-h-6 items-center gap-1';
  switch (state) {
    case 'idle':
      return null;
    case 'pending':
    case 'saving':
      return (
        <span className={base} data-testid="save-status" data-state="saving" aria-live="polite">
          <Spinner className="size-3.5" />
          Saving…
        </span>
      );
    case 'saved':
      return (
        <span className={base} data-testid="save-status" data-state="saved" aria-live="polite">
          <IconCheck className="size-3.5" />
          Saved
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} text-red-900`}
          data-testid="save-status"
          data-state="error"
          role="alert"
          title={error ?? undefined}
        >
          <IconAlertCircle className="size-3.5" />
          Couldn’t save
          <Button size="xs" variant="ghost" className="text-red-900" onClick={onRetry}>
            Retry
          </Button>
        </span>
      );
    case 'conflict':
      return (
        <span
          className={`${base} text-red-900`}
          data-testid="save-status"
          data-state="conflict"
          role="alert"
        >
          <IconAlertCircle className="size-3.5" />
          Changed elsewhere
          <Button size="xs" variant="ghost" className="text-red-900" onClick={onReload}>
            Reload
          </Button>
        </span>
      );
  }
}

/** Below this header width the primary actions get a row of their own (9.3b). */
const COMPACT_HEADER_PX = 560;

/** The element is narrower than `px` (ResizeObserver; `false` before the first measurement). */
function useNarrow(ref: React.RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < px);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px]);
  return narrow;
}

/**
 * Secondary header actions behind "…" leave room for recording, Enhance and Share.
 */
function MoreActions({ children }: { children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            data-testid="document-more"
          />
        }
      >
        <IconDots />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto items-stretch">
        {children}
      </PopoverContent>
    </Popover>
  );
}
