'use client';

import type { DocumentVisibility } from '@oat/core';
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@oat/ui/components/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@oat/ui/components/input-group';
import { RadioGroup, RadioGroupItem } from '@oat/ui/components/radio-group';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Switch } from '@oat/ui/components/switch';
import { IconCheck, IconCopy, IconInfoCircle, IconRefresh, IconShare } from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { OatApiError } from '@oat/client';
import { useCallback, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useShellData } from './shell-data';
import type { DocumentSharing, UpdateSharingInput } from '@oat/services/dto/api-types';

type Option = { value: DocumentVisibility; label: string; detail: string };

function options(s: DocumentSharing, isOwner: boolean): Option[] {
  const ws = s.workspace;
  const everyone =
    ws.memberCount <= 1
      ? `Everyone in ${ws.name} (only you, so far)`
      : `Everyone in ${ws.name} (${ws.memberCount} members)`;
  return [
    { value: 'private', label: 'Private', detail: isOwner ? 'Only you' : `Only ${s.owner.name}` },
    { value: 'workspace', label: 'Workspace', detail: everyone },
    {
      value: 'link',
      label: 'Anyone with the link',
      detail: 'Workspace access, plus a read-only page for anyone with the link',
    },
  ];
}

/** One sentence: who can open this document right now. */
export function accessSummary(s: DocumentSharing, isOwner: boolean): string {
  const owner = isOwner ? 'you' : s.owner.name;
  const ws = s.workspace.name;
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
 * transcript (off by default). Access and transcript changes apply optimistically: the dialog shows the new
 * state at once, `PATCH /api/documents/:id/share` confirms it, and a failure puts the previous state back with
 * a toast. Sharing doesn't bump the content version, so the open editor's autosave is unaffected.
 */
export function ShareDialog({ documentId }: { documentId: string }) {
  const host = useWorkspaceHost();
  const currentUserId = useShellData().user.id;
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState<DocumentSharing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const ids = { transcript: useId(), link: useId() };
  /** Each change gets a number: only the newest one's answer (or rollback) is applied. */
  const latest = useRef(0);
  /**
   * Writes go out one at a time, in the order the user made them: two overlapping PATCHes could otherwise
   * commit in reverse and leave the server more open than the dialog shows.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = useCallback(
    (input: UpdateSharingInput) => {
      const next = queue.current.then(
        () => host.client.documents.updateSharing(documentId, input),
        () => host.client.documents.updateSharing(documentId, input),
      );
      queue.current = next.catch(() => undefined);
      return next;
    },
    [documentId, host.client],
  );

  /** Fresh settings every time the dialog opens (someone else may have changed them). */
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setLoadError(null);
    host.client.documents
      .sharing(documentId)
      .then(setSharing, (error: unknown) =>
        setLoadError(error instanceof Error ? error.message : 'Couldn’t load sharing settings.'),
      );
  }

  /** Optimistic change: show `optimistic` now, confirm with the server, roll back on failure. */
  const change = useCallback(
    async (input: UpdateSharingInput, optimistic: Partial<DocumentSharing>) => {
      const previous = sharing;
      if (!previous) return;
      const seq = ++latest.current;
      setSharing({ ...previous, ...optimistic });
      try {
        const next = await send(input);
        if (seq === latest.current) setSharing(next);
        host.refresh();
      } catch (error) {
        if (seq === latest.current) setSharing(previous);
        toast.error(
          error instanceof OatApiError ? error.message : 'Couldn’t update sharing. Try again.',
        );
      }
    },
    [host, send, sharing],
  );

  async function rotate() {
    setRotating(true);
    const seq = ++latest.current;
    try {
      const next = await send({ rotateLink: true });
      if (seq === latest.current) setSharing(next);
      toast.success('New link created. The old link no longer works.');
    } catch (error) {
      toast.error(
        error instanceof OatApiError ? error.message : 'Couldn’t reset the link. Try again.',
      );
    } finally {
      setRotating(false);
    }
  }

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
    } catch {
      toast.error('Couldn’t copy. Select the link and copy it instead.');
    }
  }

  const isOwner = sharing?.owner.id === currentUserId;
  const locked = !sharing?.canShare;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="secondary" data-testid="share-button" />}>
        <IconShare data-icon="inline-start" />
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
          <p role="alert" className="text-copy-14 text-red-900">
            {loadError}
          </p>
        ) : !sharing ? (
          <div
            className="flex flex-col gap-3"
            role="status"
            aria-busy
            aria-label="Loading sharing settings"
          >
            <Skeleton className="h-5 w-28" />
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[3.875rem] w-full rounded-lg" />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <FieldSet disabled={locked}>
              <FieldLegend variant="label" className="mb-0">
                General access
              </FieldLegend>
              <RadioGroup
                value={sharing.visibility}
                disabled={locked}
                className="gap-2"
                onValueChange={(value) => {
                  const visibility = value as DocumentVisibility;
                  if (visibility !== sharing.visibility)
                    void change({ visibility }, { visibility });
                }}
              >
                {options(sharing, isOwner).map((option) => {
                  const blocked = sharing.inPrivateFolder && option.value !== 'private';
                  return (
                    <FieldLabel
                      key={option.value}
                      className="rounded-md transition-colors hover:bg-gray-alpha-100 has-data-checked:bg-gray-alpha-100 has-[>[data-slot=field]]:border-0 has-data-disabled:cursor-not-allowed has-data-disabled:hover:bg-transparent"
                    >
                      <Field orientation="horizontal" className="items-start px-3 py-2.5">
                        <RadioGroupItem
                          value={option.value}
                          disabled={blocked}
                          className="mt-0.5"
                        />
                        <FieldContent className="gap-0">
                          <FieldTitle>{option.label}</FieldTitle>
                          <FieldDescription className="text-copy-13">
                            {option.detail}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    </FieldLabel>
                  );
                })}
              </RadioGroup>
            </FieldSet>

            {sharing.inPrivateFolder && (
              <Note>This is in a private folder. Move it out of the folder to share it.</Note>
            )}
            {locked && !sharing.inPrivateFolder && (
              <Note>Only the owner or a workspace admin can change who has access.</Note>
            )}

            {url && (
              <Field className="gap-2">
                <FieldLabel htmlFor={ids.link}>Link</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={ids.link}
                    data-testid="share-link"
                    readOnly
                    value={url}
                    onFocus={(event) => event.currentTarget.select()}
                    className="text-label-13-mono"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="xs" onClick={() => void copy()} aria-label="Copy link">
                      {copied ? <IconCheck /> : <IconCopy />}
                      {copied ? 'Copied' : 'Copy'}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <div className="flex min-h-6 items-center justify-between gap-2">
                  <span className="text-label-13 text-gray-900">
                    View only. Not listed in search engines.
                  </span>
                  {sharing.canShare && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={rotating}
                      onClick={() => void rotate()}
                    >
                      <IconRefresh data-icon="inline-start" />
                      Reset link
                    </Button>
                  )}
                </div>
              </Field>
            )}

            {sharing.kind === 'meeting' && sharing.visibility === 'link' && (
              <FieldLabel
                htmlFor={ids.transcript}
                className="rounded-md has-[>[data-slot=field]]:border-0"
              >
                <Field orientation="horizontal" className="items-start px-3 py-2.5">
                  <FieldContent className="gap-0">
                    <FieldTitle>Show transcript to link viewers</FieldTitle>
                    <FieldDescription className="text-copy-13">
                      {sharing.shareTranscript
                        ? 'People with the link can read the notes and the transcript.'
                        : 'People with the link see the notes only.'}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={ids.transcript}
                    data-testid="share-transcript"
                    checked={sharing.shareTranscript}
                    disabled={locked}
                    onCheckedChange={(checked) =>
                      void change({ shareTranscript: checked }, { shareTranscript: checked })
                    }
                  />
                </Field>
              </FieldLabel>
            )}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="-mt-2 flex items-start gap-2 text-copy-13 text-gray-900">
      <IconInfoCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
