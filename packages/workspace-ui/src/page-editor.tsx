'use client';

import type { JSONContent } from '@oat/editor';
import { OatEditor, type OatEditorProps } from '@oat/editor/react';
import { Alert, AlertAction, AlertTitle } from '@oat/ui/components/alert';
import { visibilityBadge } from '@oat/core/sections';
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
import {
  createContext,
  useContext,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { useTreeActions } from './tree-actions';
import { PageContainer } from './page';
import type { DocumentDetail } from '@oat/services/dto/api-types';
import { formatDay } from './format';
import { documentNode } from './tree';
import { useWorkspaceHost } from './host';
import { ShareDialog } from './share-dialog';
import { type SaveState, type SaveDocument, useAutosave } from './use-autosave';

type WorkspaceAudience = { name: string };

type Editor = Parameters<NonNullable<OatEditorProps['onReady']>>[0];

const isEmptyDoc = (doc: JSONContent) =>
  !doc.content?.length ||
  (doc.content.length === 1 && doc.content[0]!.type === 'paragraph' && !doc.content[0]!.content);

export type PageEditorProps = {
  document: DocumentDetail;
  workspace: WorkspaceAudience;
  children?: React.ReactNode;
  save?: SaveDocument;
  onSaved?: (doc: DocumentDetail, patch: { title?: string; contentJson?: JSONContent }) => void;
  onReload?: () => void;
};

function usePageEditorState({
  document: doc,
  workspace,
  save,
  onSaved,
  onReload,
}: PageEditorProps) {
  const host = useWorkspaceHost();
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
    save,
    onSaved: (saved, patch) => {
      setUpdatedAt(saved.updatedAt);
      onSaved?.(saved, patch);
      // The sidebar, breadcrumbs and tab title show the title: re-render the shell.
      if (patch.title !== undefined) host.refresh();
    },
    onExternalChange: (change) => setTitle(change.title),
  });

  const { discard, reset } = autosave;
  /** Reload to the server copy, without the "unsaved changes" prompt: the user chose to drop them. */
  const reload = useCallback(() => {
    discard();
    if (onReload) {
      onReload();
      return;
    }
    void host.client.documents.get(doc.id).then(
      (next) => {
        reset(next);
        setTitle(next.title);
        setContent(next.contentJson);
        setUpdatedAt(next.updatedAt);
        toast.dismiss(`conflict-${doc.id}`);
        host.refresh();
      },
      () => toast.error('Couldn’t reload this page. Try again.'),
    );
  }, [discard, onReload, host, doc.id, reset]);

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

  return {
    doc,
    workspace,
    title,
    setTitle,
    content,
    setContent,
    updatedAt,
    setUpdatedAt,
    editorRef,
    trashed,
    editable,
    autoFocusTitle,
    autosave,
    reload,
  };
}

const PageEditorContext = createContext<ReturnType<typeof usePageEditorState> | null>(null);

export function usePageEditor() {
  const editor = useContext(PageEditorContext);
  if (!editor) throw new Error('usePageEditor must be used within PageEditor.');
  return editor;
}

export function PageEditor({ children, ...props }: PageEditorProps) {
  const editor = usePageEditorState(props);
  return <PageEditorContext value={editor}>{children ?? <PageEditorSurface />}</PageEditorContext>;
}

export function PageEditorSurface({
  meta,
  headerActions,
  secondaryActions,
  statusExtra,
  beforeEditor,
  streaming = false,
  taskAssignees,
  Actions = Fragment,
}: {
  meta?: React.ReactNode;
  headerActions?: React.ReactNode;
  secondaryActions?: React.ReactNode;
  statusExtra?: React.ReactNode;
  beforeEditor?: React.ReactNode;
  streaming?: boolean;
  taskAssignees?: OatEditorProps['onTaskAssigneeQuery'];
  Actions?: React.ComponentType<{ children: React.ReactNode }>;
}) {
  const {
    doc,
    workspace,
    title,
    setTitle,
    content,
    updatedAt,
    editorRef,
    trashed,
    editable,
    autoFocusTitle,
    autosave,
    reload,
  } = usePageEditor();
  const actions = useTreeActions();
  const isMeeting = doc.kind === 'meeting';
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

      {!trashed && (
        <Actions>
          <div
            className="flex min-w-0 items-center gap-2 text-label-12 text-gray-900"
            data-testid="document-actions"
          >
            {editable && (
              <SaveStatus
                state={autosave.state}
                error={autosave.error}
                onRetry={autosave.retry}
                onReload={reload}
              />
            )}
            {statusExtra}
            {headerActions}
            {secondaryActions ??
              (doc.access.delete && (
                <MoreActions>
                  <Button variant="ghost" onClick={() => actions.remove(node)}>
                    <IconTrash data-icon="inline-start" />
                    Move to trash
                  </Button>
                </MoreActions>
              ))}
            <ShareDialog documentId={doc.id} />
          </div>
        </Actions>
      )}
      <header className="flex flex-col gap-3">
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
        <div
          className="flex min-h-8 flex-wrap items-center gap-2 text-label-12 text-gray-900"
          data-testid={isMeeting ? 'meeting-header' : undefined}
        >
          <VisibilityBadge visibility={doc.visibility} workspace={workspace} />
          {!trashed && !doc.access.edit && (
            <Badge variant="outline">
              <IconEye data-icon="inline-start" />
              View only
            </Badge>
          )}
          {!isMeeting && (
            <span className="inline-flex h-6 items-center rounded-md bg-gray-100 px-2.5 text-label-12">
              Edited {formatDay(updatedAt)}
            </span>
          )}
          {meta}
        </div>
      </header>

      {beforeEditor}

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
  // The item's own visibility, never the member count: shared with the workspace reads as shared even
  // while I am its only member (D-36).
  const Icon = visibility === 'private' ? IconLock : visibility === 'link' ? IconLink : IconUsers;
  const label = visibilityBadge(visibility, workspace.name);
  return (
    <Badge
      variant="secondary"
      className="h-6 rounded-md px-2.5 text-gray-900"
      data-testid="visibility-badge"
    >
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

/**
 * Secondary header actions behind "…" leave room for recording, Enhance and Share.
 */
export function MoreActions({ children }: { children: React.ReactNode }) {
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
