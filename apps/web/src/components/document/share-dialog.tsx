'use client';

import type { DocumentVisibility } from '@oat/core';
import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@oat/ui/components/dialog';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@oat/ui/components/input-group';
import { Label } from '@oat/ui/components/label';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Switch } from '@oat/ui/components/switch';
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  RefreshCwIcon,
  Share2Icon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';

import { useShellData } from '@/components/app-shell/shell-data';
import { isApiError, sharingApi } from '@/lib/api-client';
import type { DocumentSharing, UpdateSharingInput } from '@/lib/api-types';

type Option = { value: DocumentVisibility; icon: LucideIcon; label: string; detail: string };

function options(s: DocumentSharing, isOwner: boolean): Option[] {
  const ws = s.workspace;
  const everyone =
    ws.kind === 'personal'
      ? 'Your personal workspace (only you)'
      : `Everyone in ${ws.name} (${ws.memberCount} ${ws.memberCount === 1 ? 'member' : 'members'})`;
  return [
    {
      value: 'private',
      icon: LockIcon,
      label: 'Private',
      detail: isOwner ? 'Only you' : `Only ${s.owner.name}`,
    },
    { value: 'workspace', icon: UsersIcon, label: 'Workspace', detail: everyone },
    {
      value: 'link',
      icon: GlobeIcon,
      label: 'Anyone with the link',
      detail: 'Workspace access, plus a read-only web page for anyone who has the link',
    },
  ];
}

/** One sentence: who can open this document right now. */
export function accessSummary(s: DocumentSharing, isOwner: boolean): string {
  const owner = isOwner ? 'you' : s.owner.name;
  const ws = s.workspace.kind === 'personal' ? 'your personal workspace' : s.workspace.name;
  switch (s.visibility) {
    case 'private':
      return isOwner ? 'Only you can open this.' : `Only ${owner} can open this.`;
    case 'workspace':
      return `Everyone in ${ws} can open this.`;
    case 'link':
      return `Everyone in ${ws} can open this, and anyone with the link can view it.`;
  }
}

/**
 * The document page's "Share" button + dialog (5.3): general access (private / workspace / anyone with
 * the link), copy and reset the link, and — for meetings shared by link — whether link viewers see the
 * transcript (off by default). Changes apply immediately through `PATCH /api/documents/:id/share`; the
 * page re-renders its badge and sidebar. Sharing doesn't bump the content version, so the open editor's
 * autosave is unaffected.
 */
export function ShareDialog({ documentId }: { documentId: string }) {
  const router = useRouter();
  const currentUserId = useShellData().user.id;
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState<DocumentSharing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const ids = { transcript: useId(), link: useId() };

  /** Fresh settings every time the dialog opens (someone else may have changed them). */
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setLoadError(null);
    sharingApi
      .get(documentId)
      .then(setSharing, (error: unknown) =>
        setLoadError(error instanceof Error ? error.message : 'Couldn’t load sharing settings.'),
      );
  }

  const update = useCallback(
    async (input: UpdateSharingInput, success?: string) => {
      setPending(true);
      try {
        const next = await sharingApi.update(documentId, input);
        setSharing(next);
        router.refresh();
        if (success) toast.success(success);
      } catch (error) {
        toast.error(isApiError(error) ? error.message : 'Couldn’t update sharing. Try again.');
      } finally {
        setPending(false);
      }
    },
    [documentId, router],
  );

  const url =
    sharing?.sharePath && typeof window !== 'undefined'
      ? `${window.location.origin}${sharing.sharePath}`
      : null;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Link copied');
    } catch {
      toast.error('Couldn’t copy. Select the link and copy it instead.');
    }
  }

  const isOwner = sharing?.owner.id === currentUserId;
  const locked = !sharing?.canShare;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" data-testid="share-button" />}>
        <Share2Icon data-icon="inline-start" />
        Share
      </DialogTrigger>
      <DialogContent data-testid="share-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription data-testid="share-summary">
            {sharing ? accessSummary(sharing, isOwner) : 'Choose who can open this.'}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : !sharing ? (
          <div
            className="flex flex-col gap-2"
            role="status"
            aria-busy
            aria-label="Loading sharing settings"
          >
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <fieldset disabled={locked || pending} className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium text-muted-foreground">
                General access
              </legend>
              {options(sharing, isOwner).map((option) => {
                const blocked = sharing.inPrivateFolder && option.value !== 'private';
                const checked = sharing.visibility === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-fast',
                      'hover:bg-accent/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
                      checked && 'border-primary/60 bg-accent',
                      (blocked || locked) && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                    )}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      value={option.value}
                      checked={checked}
                      disabled={blocked}
                      onChange={() => void update({ visibility: option.value })}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md',
                        checked
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <option.icon className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.detail}</span>
                    </span>
                    {checked && <CheckIcon className="mt-1.5 size-4 text-primary" aria-hidden />}
                  </label>
                );
              })}
            </fieldset>

            {sharing.inPrivateFolder && (
              <Note>This is in a private folder. Move it out of the folder to share it.</Note>
            )}
            {locked && !sharing.inPrivateFolder && (
              <Note>Only the owner or a workspace admin can change who has access.</Note>
            )}

            {url && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={ids.link}>Link</Label>
                <InputGroup>
                  <InputGroupInput
                    id={ids.link}
                    data-testid="share-link"
                    readOnly
                    value={url}
                    onFocus={(event) => event.currentTarget.select()}
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="xs" onClick={() => void copy()} aria-label="Copy link">
                      {copied ? <CheckIcon /> : <CopyIcon />}
                      {copied ? 'Copied' : 'Copy'}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>View only. Not listed in search engines.</span>
                  {sharing.canShare && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void update(
                          { rotateLink: true },
                          'New link created. The old link no longer works.',
                        )
                      }
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      Reset link
                    </Button>
                  )}
                </div>
              </div>
            )}

            {sharing.kind === 'meeting' && sharing.visibility === 'link' && (
              <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor={ids.transcript}>Show transcript to link viewers</Label>
                  <span className="text-xs text-muted-foreground">
                    {sharing.shareTranscript
                      ? 'People with the link can read the notes and the transcript.'
                      : 'People with the link see the notes only.'}
                  </span>
                </div>
                <Switch
                  id={ids.transcript}
                  data-testid="share-transcript"
                  checked={sharing.shareTranscript}
                  disabled={locked || pending}
                  onCheckedChange={(checked) => void update({ shareTranscript: checked })}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="-mt-2 flex items-start gap-2 text-xs text-muted-foreground">
      <InfoIcon className="mt-px size-3.5 shrink-0" />
      {children}
    </p>
  );
}
