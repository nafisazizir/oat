'use client';

import { useEffect, useState } from 'react';
import type { ChatThreadSummary } from '@oat/services/dto/chat';
import { requestNewWorkspaceChat } from '@oat/ui/lib/assistant-events';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@oat/ui/components/sidebar';
import { IconChevronRight, IconDots, IconMessageCircle, IconPlus } from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { useShellData } from './shell-data';

const RECENT_LIMIT = 5;

export function ChatsSection() {
  const { client, Link, route, online } = useWorkspaceHost();
  const { workspace } = useShellData();
  const [open, setOpen] = useState(true);
  const { state, isMobile } = useSidebar();
  const iconOnly = state === 'collapsed' && !isMobile;
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  // "View all" only earns its row when the list is truncated. The icon rail hides the group
  // action, so there it stays as the one way into the Assistant.
  const showAll = hasMore || iconOnly;
  const threadId = route.view === 'assistant' ? route.threadId : undefined;
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    void client.chat.threads({ workspaceId: workspace.id }, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setThreads(
          result.threads
            .slice()
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, RECENT_LIMIT),
        );
        setHasMore(result.threads.length > RECENT_LIMIT);
      },
      () => {
        if (controller.signal.aborted) return;
        setThreads([]);
        setHasMore(false);
      },
    );
    return () => controller.abort();
  }, [client, workspace.id, online, route]);
  return (
    <SidebarGroup className="group/tree-section py-1" data-testid="chats-section">
      <SidebarGroupLabel
        className="group-data-[collapsible=icon]:hidden"
        render={
          <button
            type="button"
            tabIndex={iconOnly ? -1 : 0}
            aria-hidden={iconOnly || undefined}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
        }
      >
        Chats
        <IconChevronRight className={`ms-1 size-3.5 ${open ? 'rotate-90' : ''}`} />
      </SidebarGroupLabel>
      <SidebarGroupAction
        render={
          <Link route={{ view: 'assistant' }} data-testid={showAll ? undefined : 'nav-assistant'} />
        }
        onClick={(event) => {
          if (
            route.view === 'assistant' &&
            !threadId &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.button === 0
          ) {
            event.preventDefault();
            requestNewWorkspaceChat(workspace.id);
          }
        }}
        aria-label="New chat"
        title="New chat"
        className="opacity-0 group-hover/tree-section:opacity-100 group-focus-within/tree-section:opacity-100"
      >
        <IconPlus />
      </SidebarGroupAction>
      {open && (
        <SidebarGroupContent>
          <SidebarMenu>
            {threads.map((thread) => (
              <SidebarMenuItem key={thread.id}>
                <SidebarMenuButton
                  render={<Link route={{ view: 'assistant', threadId: thread.id }} />}
                  isActive={threadId === thread.id}
                  tooltip={thread.title}
                >
                  <IconMessageCircle />
                  <span className="truncate">{thread.title || 'Untitled chat'}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {showAll && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link route={{ view: 'assistant' }} data-testid="nav-assistant" />}
                  className="text-gray-900"
                  tooltip="View all chats"
                >
                  <IconDots />
                  <span>View all</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
