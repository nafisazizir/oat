import {
  IconCalendar,
  IconSelector,
  IconFileText,
  IconInbox,
  IconBulb,
  IconLock,
  IconPlus,
  IconSearch,
  IconShare,
  IconSparkles,
  IconUsers,
} from '@tabler/icons-react';

import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@oat/ui/components/resizable';
import { ScrollArea } from '@oat/ui/components/scroll-area';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@oat/ui/components/sidebar';

const transcript = [
  {
    who: 'them',
    name: 'Priya',
    at: '10:02',
    text: 'Okay, so the onboarding drop-off is mostly at the calendar step.',
  },
  {
    who: 'me',
    name: 'You',
    at: '10:02',
    text: 'Is that people skipping it, or failing the permission prompt?',
  },
  {
    who: 'them',
    name: 'Priya',
    at: '10:03',
    text: 'Mostly skipping. About a third never come back to connect it.',
  },
  {
    who: 'me',
    name: 'You',
    at: '10:03',
    text: 'Then let’s make it optional and ask again after the first meeting.',
  },
  {
    who: 'them',
    name: 'Marco',
    at: '10:04',
    text: 'I can have a prototype of that flow by Thursday.',
  },
] as const;

/** The tokens in context: sidebar, a meeting note (my text vs AI text) and a me/them transcript. */
export function MeetingPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-100 text-copy-14 text-gray-1000">
      <SidebarProvider className="min-h-0 h-[34rem]">
        <Sidebar collapsible="none" className="border-r border-gray-alpha-400">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg">
                  <Avatar className="rounded-md after:rounded-md" size="sm">
                    <AvatarFallback className="rounded-md bg-gray-1000 text-background-100">
                      O
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-label-14">Oat Studio</span>
                    <span className="text-label-12 text-gray-900">4 members</span>
                  </div>
                  <IconSelector className="ms-auto" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconSearch />
                      Search
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconInbox />
                      Upcoming
                    </SidebarMenuButton>
                    <SidebarMenuBadge>3</SidebarMenuBadge>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Private</SidebarGroupLabel>
              <SidebarGroupAction title="New page">
                <IconPlus />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>
                      <IconFileText />
                      Weekly design sync
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconBulb />
                      Ideas
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconLock />
                      1:1 with Sam
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Team spaces</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconUsers />
                      Design
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <IconUsers />
                      Product
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <Avatar size="sm">
                    <AvatarFallback>AK</AvatarFallback>
                  </Avatar>
                  You
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
          <ResizablePanel defaultSize="62%" minSize="40%">
            <div className="flex h-full flex-col">
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-alpha-400 px-4">
                <span className="text-gray-900">Private</span>
                <span className="text-gray-900">/</span>
                <span className="truncate text-label-14">Weekly design sync</span>
                <Badge variant="outline" className="ms-auto gap-1.5">
                  <span className="size-1.5 rounded-full bg-red-700" />
                  Recording
                </Badge>
                <Button size="sm" variant="ghost">
                  <IconShare data-icon="inline-start" />
                  Share
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <article className="mx-auto flex max-w-content flex-col gap-5 px-8 py-8">
                  <header className="flex flex-col gap-3">
                    <h1 className="text-display-32">Weekly design sync</h1>
                    <div className="flex flex-wrap items-center gap-3 text-label-12 text-gray-900">
                      <IconCalendar className="size-4" />
                      <span>Thu 14 Nov · 10:00–10:30</span>
                      <span>·</span>
                      <span>Priya, Marco, you</span>
                    </div>
                  </header>
                  <section className="flex flex-col gap-2 text-copy-16">
                    <h3 className="text-heading-20">Onboarding drop-off</h3>
                    <ul className="flex list-disc flex-col gap-1.5 ps-5 marker:text-gray-900">
                      <li className="text-gray-1000">calendar step is the leak</li>
                      <li className="text-blue-900">
                        Roughly a third of new users skip connecting a calendar and never return to
                        it; skipping, not the permission prompt, is the main cause.
                      </li>
                      <li className="text-gray-1000">
                        make it optional → re-ask after 1st meeting
                      </li>
                      <li className="text-blue-900">
                        Marco to prototype the deferred-permission flow by Thursday.
                      </li>
                    </ul>
                  </section>
                  <div className="flex items-center gap-4 text-label-12 text-gray-900">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-gray-1000" /> Your notes
                    </span>
                    <span className="flex items-center gap-1.5">
                      <IconSparkles className="size-3.5 text-blue-900" /> Added by AI
                    </span>
                  </div>
                </article>
              </ScrollArea>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="38%" minSize="25%">
            <div className="flex h-full flex-col bg-background-100">
              <div className="flex h-12 shrink-0 items-center border-b border-gray-alpha-400 px-4 text-label-14">
                Transcript
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <ol className="flex flex-col gap-3 p-4">
                  {transcript.map((line, i) => (
                    <li
                      key={i}
                      className={
                        line.who === 'me'
                          ? 'flex flex-col items-end gap-1'
                          : 'flex flex-col items-start gap-1'
                      }
                    >
                      <span className="text-label-12 text-gray-900">
                        {line.name} · {line.at}
                      </span>
                      <p
                        className={
                          line.who === 'me'
                            ? 'max-w-[85%] rounded-xl rounded-br-sm bg-blue-100 px-3 py-2 text-blue-1000'
                            : 'max-w-[85%] rounded-xl rounded-bl-sm bg-gray-100 px-3 py-2 text-gray-1000'
                        }
                      >
                        {line.text}
                      </p>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarProvider>
    </div>
  );
}
