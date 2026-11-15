'use client';

import { cn } from '@oat/ui';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  AlertTriangleIcon,
  CheckIcon,
  FilePenLineIcon,
  Loader2Icon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { isApiError } from '@/lib/api-client';
import type { DocumentDetail } from '@/lib/api-types';
import { chatApi } from '@/lib/chat-client';
import type { ChatProposal } from '@/lib/chat-types';

import { applyServerBlocks, useOpenDocument } from './open-document';
import { useChatSession } from './session-context';

/**
 * A proposed edit (D-27: `updateDocument` only proposes). Shows the target note's title and every change as
 * plain-text before/after — never only the model's own summary, which injected content could steer. Approve
 * applies it at the version it was made against; if the note changed since, the server refuses (409) and the
 * card offers to ask again.
 */
export function ProposalCard({
  proposal,
  question,
}: {
  proposal: ChatProposal;
  /** The question that produced it, for "Re-run". */
  question: string | undefined;
}) {
  const session = useChatSession();
  const open = useOpenDocument();
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const title = session.sources.documents[proposal.documentId]?.title;
  const status = proposal.status;

  async function decide(decision: 'approve' | 'reject') {
    const threadId = session.threadId();
    if (!threadId || busy) return;
    setBusy(decision);
    setNotice(null);
    // Approving a change to the note that is open here: lock the editor (nothing typed during the round
    // trips can be overwritten), save what the user typed first so the change is checked against what they
    // see, then patch only the changed blocks into the editor.
    const note =
      decision === 'approve' && open?.documentId === proposal.documentId ? open.handle() : null;
    const editor = note?.editor() ?? null;
    const unlock = editor?.isEditable ? () => editor.setEditable(true, false) : () => {};
    editor?.setEditable(false, false);
    try {
      if (note && !(await note.settle())) {
        setNotice('Your latest edits aren’t saved yet. Try again once they are.');
        return;
      }
      const result = await chatApi.decide(threadId, proposal.id, decision);
      if (decision === 'approve') {
        if (note && result.document) {
          const doc = await fetch(`/api/documents/${encodeURIComponent(proposal.documentId)}`, {
            cache: 'no-store',
          }).then((res) => (res.ok ? (res.json() as Promise<DocumentDetail>) : null));
          if (doc) {
            const next = { version: doc.version, contentJson: doc.contentJson };
            note.adopt(next);
            const blockIds = proposal.changes.map((c) => c.blockId);
            if (!editor || !applyServerBlocks(editor, doc.contentJson, blockIds))
              note.replace(next);
          }
          toast.success('Change applied to this note');
        } else {
          toast.success('Change applied', {
            description: title,
            action: {
              label: 'Open note',
              onClick: () => router.push(`/d/${proposal.documentId}` as Route),
            },
          });
        }
      }
    } catch (error) {
      if (isApiError(error, 'stale_version') || isApiError(error, 'proposal_closed')) {
        // The new status (stale / already decided) comes back with the thread.
      } else if (isApiError(error)) {
        setNotice(error.message);
      } else {
        setNotice('Something went wrong. Try again.');
      }
    } finally {
      unlock();
      await session.refresh();
      setBusy(null);
    }
  }

  return (
    <section
      data-testid="proposal-card"
      data-status={status}
      aria-label="Suggested edit"
      className="my-2 flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-xs"
    >
      <header className="flex items-start gap-2">
        <FilePenLineIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-muted-foreground">Suggested edit to</span>
          {title ? (
            <Link
              href={`/d/${proposal.documentId}` as Route}
              className="truncate text-sm font-medium hover:underline"
              data-testid="proposal-document"
            >
              {title}
            </Link>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">
              A note you can’t open anymore
            </span>
          )}
        </div>
        <StatusBadge status={status} />
      </header>

      <ol className="flex flex-col gap-2">
        {proposal.changes.map((change, i) => (
          <li key={`${change.blockId}-${i}`} className="flex flex-col gap-1 text-sm">
            <DiffLine kind="before" text={change.before} />
            <DiffLine kind="after" text={change.after} />
          </li>
        ))}
      </ol>

      {proposal.summary && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Assistant’s note:</span> {proposal.summary}
        </p>
      )}

      {status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void decide('approve')} disabled={busy !== null}>
            {busy === 'approve' ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void decide('reject')}
            disabled={busy !== null}
          >
            {busy === 'reject' ? <Loader2Icon className="animate-spin" /> : <XIcon />}
            Reject
          </Button>
        </div>
      )}

      {(status === 'stale' || status === 'failed') && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className="flex-1">
            {status === 'stale'
              ? 'The note changed since this suggestion, so it wasn’t applied. Re-run to get a fresh one.'
              : 'This change no longer fits the note. Re-run to get a fresh one.'}
          </span>
          {question && (
            <Button
              size="xs"
              variant="outline"
              disabled={session.busy}
              onClick={() => session.ask(question)}
            >
              <RotateCwIcon />
              Re-run
            </Button>
          )}
        </div>
      )}

      {notice && (
        <p role="alert" className="text-xs text-destructive">
          {notice}
        </p>
      )}
    </section>
  );
}

function DiffLine({ kind, text }: { kind: 'before' | 'after'; text: string }) {
  const before = kind === 'before';
  return (
    <p
      data-diff={kind}
      className={cn(
        'grid grid-cols-[1rem_1fr] rounded-md px-2 py-1 break-words whitespace-pre-wrap',
        before ? 'bg-destructive/10 text-foreground/80' : 'bg-success/15 text-foreground',
      )}
    >
      <span aria-hidden className="font-mono text-muted-foreground select-none">
        {before ? '−' : '+'}
      </span>
      <span>
        <span className="sr-only">{before ? 'Before: ' : 'After: '}</span>
        {before ? (
          <del className="decoration-destructive/50">{text || '(empty)'}</del>
        ) : (
          text || '(empty)'
        )}
      </span>
    </p>
  );
}

function StatusBadge({ status }: { status: ChatProposal['status'] }) {
  switch (status) {
    case 'pending':
      return <Badge variant="secondary">Needs your approval</Badge>;
    case 'applied':
      return (
        <Badge variant="secondary" className="gap-1">
          <CheckIcon />
          Applied
        </Badge>
      );
    case 'rejected':
      return <Badge variant="outline">Rejected</Badge>;
    case 'stale':
      return <Badge variant="outline">Not applied</Badge>;
    case 'failed':
      return <Badge variant="outline">No longer applies</Badge>;
  }
}
