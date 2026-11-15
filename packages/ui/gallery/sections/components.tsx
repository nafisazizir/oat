import {
  ArrowRightIcon,
  BellIcon,
  CalendarIcon,
  CopyIcon,
  EllipsisIcon,
  FileTextIcon,
  LinkIcon,
  MicIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from '@oat/ui/components/avatar';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oat/ui/components/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@oat/ui/components/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@oat/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@oat/ui/components/resizable';
import { ScrollArea } from '@oat/ui/components/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Separator } from '@oat/ui/components/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@oat/ui/components/sheet';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Toaster } from '@oat/ui/components/sonner';
import { Switch } from '@oat/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import { ToggleGroup, ToggleGroupItem } from '@oat/ui/components/toggle-group';
import { Textarea } from '@oat/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';

function Specimen({
  name,
  children,
  className = '',
}: {
  name: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col gap-4 rounded-xl border bg-card p-5 ${className}`}
      data-specimen={name}
    >
      <h3 className="font-mono text-xs font-normal tracking-normal text-muted-foreground">
        {name}
      </h3>
      <div className="flex flex-1 flex-col gap-4">{children}</div>
    </section>
  );
}

const meetings = [
  'Weekly design sync',
  'Customer call — Northwind',
  '1:1 with Sam',
  'Roadmap review',
  'Hiring loop debrief',
  'Pricing workshop',
  'Standup',
  'Investor update prep',
  'Retro — sprint 41',
  'Research readout',
];

export function ComponentGallery({ staticOverlays }: { staticOverlays: boolean }) {
  // Pinned overlays are controlled-open (no onOpenChange), so they stay put for screenshots.
  const pinned = staticOverlays ? { open: true } : {};

  useEffect(() => {
    if (!staticOverlays) return;
    toast.success('Notes enhanced', {
      description: 'Weekly design sync is ready to share.',
      duration: Infinity,
      id: 'gallery-pinned', // StrictMode runs effects twice; one toast only
    });
  }, [staticOverlays]);

  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      <Specimen name="button" className="xl:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button>
            <SparklesIcon data-icon="inline-start" />
            Enhance notes
          </Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
          <Button variant="link">
            Link
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" variant="outline" aria-label="Record">
            <MicIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="More">
            <EllipsisIcon />
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Specimen>

      <Specimen name="badge · avatar">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Live</Badge>
          <Badge variant="secondary">Private</Badge>
          <Badge variant="outline">Design</Badge>
          <Badge variant="destructive">Failed</Badge>
        </div>
        <div className="flex items-center gap-4">
          <Avatar size="lg">
            <AvatarFallback>PR</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>MA</AvatarFallback>
          </Avatar>
          <Avatar size="sm">
            <AvatarFallback>AK</AvatarFallback>
          </Avatar>
          <AvatarGroup>
            <Avatar>
              <AvatarFallback>JL</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>TS</AvatarFallback>
            </Avatar>
            <AvatarGroupCount>+3</AvatarGroupCount>
          </AvatarGroup>
        </div>
      </Specimen>

      <Specimen name="input · textarea · label">
        <div className="flex flex-col gap-2">
          <Label htmlFor="g-title">Title</Label>
          <Input id="g-title" placeholder="Untitled meeting" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="g-email">Invite</Label>
          <Input id="g-email" type="email" defaultValue="not-an-email" aria-invalid />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="g-notes">Notes</Label>
          <Textarea id="g-notes" placeholder="Type rough notes — Oat will tidy them up." />
        </div>
      </Specimen>

      <Specimen name="switch · select · separator">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="g-auto">Auto-record calendar meetings</Label>
          <Switch id="g-auto" defaultChecked />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="g-sum">Email me a summary</Label>
          <Switch id="g-sum" />
        </div>
        <Separator />
        <div className="flex items-center justify-between gap-4">
          <Label>Template</Label>
          <Select defaultValue="general">
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="general">General meeting</SelectItem>
                <SelectItem value="one-on-one">1:1</SelectItem>
                <SelectItem value="customer">Customer call</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-5 items-center gap-3 text-muted-foreground">
          <span>Private</span>
          <Separator orientation="vertical" />
          <span>Edited 2m ago</span>
          <Separator orientation="vertical" />
          <span>3 people</span>
        </div>
      </Specimen>

      <Specimen name="toggle-group (segmented)">
        <ToggleGroup
          type="single"
          variant="segmented"
          spacing={0.5}
          defaultValue="light"
          aria-label="Theme"
        >
          <ToggleGroupItem value="light" className="px-3">
            Light
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" className="px-3">
            Dark
          </ToggleGroupItem>
          <ToggleGroupItem value="system" className="px-3">
            System
          </ToggleGroupItem>
        </ToggleGroup>
      </Specimen>

      <Specimen name="tabs">
        <Tabs defaultValue="notes">
          <TabsList>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="chat">Ask</TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="text-muted-foreground">
            Enhanced notes for this meeting.
          </TabsContent>
          <TabsContent value="transcript" className="text-muted-foreground">
            Full transcript.
          </TabsContent>
          <TabsContent value="chat" className="text-muted-foreground">
            Ask anything about this meeting.
          </TabsContent>
        </Tabs>
        <Tabs defaultValue="all">
          <TabsList variant="line">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="mine">Mine</TabsTrigger>
            <TabsTrigger value="shared">Shared</TabsTrigger>
          </TabsList>
        </Tabs>
      </Specimen>

      <Specimen name="card">
        <Card>
          <CardHeader>
            <CardTitle>Roadmap review</CardTitle>
            <CardDescription>Tomorrow · 14:00 · Product</CardDescription>
            <CardAction>
              <Button size="icon-sm" variant="ghost" aria-label="More">
                <EllipsisIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            Oat will start recording when the call begins.
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">
              <MicIcon data-icon="inline-start" />
              Join & record
            </Button>
            <Button size="sm" variant="ghost">
              Skip
            </Button>
          </CardFooter>
        </Card>
      </Specimen>

      <Specimen name="skeleton · scroll-area">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
        <ScrollArea className="h-36 rounded-lg border">
          <ul className="flex flex-col p-1">
            {meetings.map((m) => (
              <li
                key={m}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <FileTextIcon className="size-4 text-muted-foreground" />
                {m}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Specimen>

      <Specimen name="command">
        <Command className="rounded-lg border">
          <CommandInput placeholder="Search notes or run a command…" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Notes">
              <CommandItem>
                <FileTextIcon />
                Weekly design sync
              </CommandItem>
              <CommandItem>
                <FileTextIcon />
                Customer call — Northwind
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem>
                <PlusIcon />
                New note
                <CommandShortcut>⌘N</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <SettingsIcon />
                Settings
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Specimen>

      <Specimen name="resizable">
        <ResizablePanelGroup orientation="horizontal" className="min-h-40 rounded-lg border">
          <ResizablePanel defaultSize="40%">
            <div className="flex h-full items-center justify-center bg-sidebar text-sidebar-foreground">
              Sidebar
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="60%">
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel defaultSize="60%">
                <div className="flex h-full items-center justify-center">Note</div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="40%">
                <div className="flex h-full items-center justify-center bg-muted text-muted-foreground">
                  Transcript
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Specimen>

      <Specimen name="dialog · sheet · sonner">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">
                <LinkIcon data-icon="inline-start" />
                Share…
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Share “Weekly design sync”</DialogTitle>
                <DialogDescription>
                  Anyone with the link can read the enhanced notes. The transcript stays private.
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2">
                <Input readOnly defaultValue="https://oat.app/s/7f3k-weekly-sync" />
                <Button variant="secondary" size="icon" aria-label="Copy link">
                  <CopyIcon />
                </Button>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button>Copy link</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">
                <UsersIcon data-icon="inline-start" />
                Attendees
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Attendees</SheetTitle>
                <SheetDescription>From the calendar invite.</SheetDescription>
              </SheetHeader>
              <ul className="flex flex-col gap-3 px-4">
                {[
                  ['PR', 'Priya Raman', 'Organizer'],
                  ['MA', 'Marco Alves', 'Design'],
                  ['AK', 'You', 'Product'],
                ].map(([i, n, r]) => (
                  <li key={n} className="flex items-center gap-3">
                    <Avatar>
                      <AvatarFallback>{i}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="font-medium">{n}</span>
                      <span className="text-xs text-muted-foreground">{r}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <SheetFooter>
                <Button>Invite</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button
            variant="ghost"
            onClick={() =>
              toast('Recording started', {
                description: 'Capturing your mic and system audio.',
              })
            }
          >
            <BellIcon data-icon="inline-start" />
            Toast
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Open these to see the overlay scrim, serif titles and elevation.
        </p>
        <Toaster position="bottom-right" />
      </Specimen>

      <Specimen
        name="tooltip · dropdown-menu · select · popover (open)"
        className="md:col-span-2 xl:col-span-3"
      >
        <div className="grid min-h-72 grid-cols-2 items-start gap-4 md:grid-cols-4">
          <div className="flex flex-col items-start gap-2">
            <Tooltip {...pinned}>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Start recording">
                  <MicIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Start recording ⌘R</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex flex-col items-start">
            <DropdownMenu {...pinned} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  Note actions
                  <EllipsisIcon data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuLabel>Weekly design sync</DropdownMenuLabel>
                <DropdownMenuGroup>
                  <DropdownMenuItem>
                    <LinkIcon />
                    Copy link
                    <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <UsersIcon />
                    Move to team space
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive">
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex flex-col items-start">
            <Select defaultValue="en" {...pinned}>
              <SelectTrigger className="w-40" aria-label="Transcript language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="de">Deutsch</SelectItem>
                  <SelectItem value="fr">Français</SelectItem>
                  <SelectItem value="ja">日本語</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col items-end">
            <Popover {...pinned} modal={false}>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  <CalendarIcon data-icon="inline-start" />
                  Thu 14 Nov
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">Weekly design sync</span>
                  <span className="text-muted-foreground">10:00–10:30 · Google Meet</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <Label htmlFor="g-pop-rec">Record automatically</Label>
                  <Switch id="g-pop-rec" size="sm" defaultChecked />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </Specimen>
    </div>
  );
}
