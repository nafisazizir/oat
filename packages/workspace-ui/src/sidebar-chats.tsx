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
} from '@oat/ui/components/sidebar';
import { IconChevronRight, IconDots, IconMessageCircle, IconPlus } from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { useShellData } from './shell-data';

export function ChatsSection() {
  const { client, Link, route, online } = useWorkspaceHost();
  const { workspace } = useShellData();
  const [open, setOpen] = useState(true);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const threadId = route.view === 'assistant' ? route.threadId : undefined;
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    void client.chat.threads({ workspaceId: workspace.id }, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted)
          setThreads(
            result.threads
              .slice()
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, 5),
          );
      },
      () => {
        if (!controller.signal.aborted) setThreads([]);
      },
    );
    return () => controller.abort();
  }, [client, workspace.id, online, route]);
  return (
    <SidebarGroup className="group/tree-section py-1" data-testid="chats-section">
      <SidebarGroupLabel
        render={
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
        }
      >
        Chats
        <IconChevronRight className={`ms-1 size-3.5 ${open ? 'rotate-90' : ''}`} />
      </SidebarGroupLabel>
      <SidebarGroupAction
        render={<Link route={{ view: 'assistant' }} />}
        onClick={(event) => {
          if (
            route.view === 'assistant' &&
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
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
