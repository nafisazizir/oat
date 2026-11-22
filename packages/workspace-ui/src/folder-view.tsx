'use client';

import { visibilityBadge } from '@oat/core/sections';
import { Badge } from '@oat/ui/components/badge';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@oat/ui/components/item';
import {
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconLock,
  IconNotes,
  IconUsers,
} from '@tabler/icons-react';
import type { FolderSummary } from '@oat/services/dto/api-types';
import { FolderActions } from './folder-actions';
import { EmptyState, PageContainer, PageHeader } from './page';
import { formatDay } from './format';
import { childrenOf, titleOf, type DocumentNode } from './tree';
import { useWorkspaceHost } from './host';
import { useShellData } from './shell-data';

export function ShellFolderView({ folder }: { folder: FolderSummary }) {
  const shell = useShellData();
  const workspace = shell.workspaces.find((w) => w.id === folder.workspaceId) ?? shell.workspace;
  return (
    <FolderView
      folder={folder}
      workspace={workspace}
      children={childrenOf(shell.documents, folder.id)}
    />
  );
}

export function FolderView({
  folder,
  children,
  workspace,
}: {
  folder: FolderSummary;
  children: readonly DocumentNode[];
  workspace: { name: string };
}) {
  const { Link } = useWorkspaceHost();
  const isPrivate = folder.visibility === 'private';
  return (
    <PageContainer>
      <PageHeader
        title={titleOf({ title: folder.name, kind: 'folder' })}
        eyebrow={
          <>
            <Badge variant="secondary">
              {isPrivate ? (
                <IconLock data-icon="inline-start" />
              ) : (
                <IconUsers data-icon="inline-start" />
              )}
              {isPrivate ? 'Private folder' : visibilityBadge('workspace', workspace.name)}
            </Badge>
            <span>Edited {formatDay(folder.updatedAt)}</span>
          </>
        }
      >
        {folder.access.edit && <FolderActions folderId={folder.id} />}
      </PageHeader>

      {children.length === 0 ? (
        <EmptyState
          icon={IconFolderOpen}
          title="This folder is empty"
          description="Add a page here, or drag pages onto the folder in the sidebar."
        />
      ) : (
        <ul
          className="flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-lg border border-gray-alpha-400"
          data-testid="folder-contents"
        >
          {children.map((child) => {
            const Icon =
              child.kind === 'folder'
                ? IconFolder
                : child.kind === 'meeting'
                  ? IconNotes
                  : IconFile;
            return (
              <li key={child.id}>
                <Item
                  size="sm"
                  className="rounded-none"
                  render={<Link route={{ view: 'document', id: child.id }} />}
                >
                  <ItemMedia variant="icon">
                    <Icon className="text-gray-900" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="block truncate">{titleOf(child)}</ItemTitle>
                  </ItemContent>
                  {child.visibility === 'private' && !isPrivate && (
                    <IconLock className="size-3.5 text-gray-900" aria-label="Only you" />
                  )}
                  <span className="shrink-0 text-label-13 text-gray-900 tabular-nums">
                    {formatDay(child.updatedAt)}
                  </span>
                </Item>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
