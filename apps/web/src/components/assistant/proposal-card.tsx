'use client';

import { cn } from '@oat/ui';
import { Alert, AlertAction, AlertDescription } from '@oat/ui/components/alert';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertTriangle, IconCheck, IconRotateClockwise, IconX } from '@tabler/icons-react';
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
  // Rejecting changes nothing in the note, so it shows at once; a failure puts the buttons back.
  const [optimistic, setOptimistic] = useState<ChatProposal['status'] | null>(null);
  const title = session.sources.documents[proposal.documentId]?.title;
  const status = optimistic ?? proposal.status;

  async function decide(decision: 'approve' | 'reject') {
    const threadId = session.threadId();
    if (!threadId || busy) return;
    setBusy(decision);
    setNotice(null);
    if (decision === 'reject') setOptimistic('rejected');
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
      if (decision === 'reject') {
        setOptimistic(null);
        if (!isApiError(error, 'proposal_closed')) {
          toast.error('Couldn’t reject the change', {
            description: isApiError(error) ? error.message : 'Something went wrong. Try again.',
          });
        }
      } else if (isApiError(error, 'stale_version') || isApiError(error, 'proposal_closed')) {
        // The new status (stale / already decided) comes back with the thread.
      } else if (isApiError(error)) {
        setNotice(error.message);
      } else {
        setNotice('Something went wrong. Try again.');
      }
    } finally {
      unlock();
      await session.refresh();
      setOptimistic(null);
      setBusy(null);
    }
  }

  return (
    <section
      data-testid="proposal-card"
      data-status={status}
      aria-label="Suggested edit"
      className="flex flex-col gap-3 rounded-xl border border-gray-alpha-400 p-3"
    >
      <header className="flex min-h-9 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-label-12 text-gray-900">Suggested edit to</span>
          {title ? (
            <Link
              href={`/d/${proposal.documentId}` as Route}
              className="truncate text-heading-14 text-gray-1000 underline-offset-2 hover:underline"
              data-testid="proposal-document"
            >
              {title}
            </Link>
          ) : (
            <span className="text-heading-14 text-gray-900">A note you can’t open anymore</span>
          )}
        </div>
        <StatusBadge status={status} />
      </header>

      <ol className="flex flex-col gap-2">
        {proposal.changes.map((change, i) => (
          <li key={`${change.blockId}-${i}`} className="flex flex-col gap-1 text-copy-14">
            <DiffLine kind="before" text={change.before} />
            <DiffLine kind="after" text={change.after} />
          </li>
        ))}
      </ol>

      {proposal.summary && <p className="text-copy-13 text-gray-900">{proposal.summary}</p>}

      {status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void decide('approve')} disabled={busy !== null}>
            {busy === 'approve' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconCheck data-icon="inline-start" />
            )}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void decide('reject')}
            disabled={busy !== null}
          >
            <IconX data-icon="inline-start" />
            Reject
          </Button>
        </div>
      )}

      {(status === 'stale' || status === 'failed') && (
        <Alert role="status" className="border-amber-400 bg-amber-100">
          <IconAlertTriangle className="text-amber-900" />
          <AlertDescription>
            {status === 'stale'
              ? 'The note changed since this suggestion, so it wasn’t applied.'
              : 'This change no longer fits the note.'}
          </AlertDescription>
          {question && (
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                disabled={session.busy}
                onClick={() => session.ask(question)}
              >
                <IconRotateClockwise data-icon="inline-start" />
                Re-run
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {notice && (
        <p role="alert" className="text-copy-13 text-red-900">
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
        before ? 'bg-red-100 text-gray-900' : 'bg-green-100 text-gray-1000',
      )}
    >
      <span aria-hidden className={cn('select-none', before ? 'text-red-900' : 'text-green-900')}>
        {before ? '−' : '+'}
      </span>
      <span>
        <span className="sr-only">{before ? 'Before: ' : 'After: '}</span>
        {before ? <del className="decoration-red-700">{text || '(empty)'}</del> : text || '(empty)'}
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
        <Badge variant="secondary">
          <IconCheck data-icon="inline-start" />
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
