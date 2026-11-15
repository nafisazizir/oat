'use client';

import { Skeleton } from '@oat/ui/components/skeleton';
import { AlertCircleIcon, CheckIcon, Loader2Icon } from 'lucide-react';

import { citationOrder } from '@/lib/chat-markdown';
import type { ChatProposal, ChatUIMessage } from '@/lib/chat-types';

import { Answer } from './answer';
import { ProposalCard } from './proposal-card';

type Part = ChatUIMessage['parts'][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** How each assistant tool shows while it runs and once done. */
const TOOL_LABELS: Record<string, { running: string; done: string; failed: string }> = {
  searchMeetings: {
    running: 'Searching meetings…',
    done: 'Searched meetings',
    failed: 'Search failed',
  },
  getDocument: {
    running: 'Reading the note…',
    done: 'Read the note',
    failed: 'Couldn’t read a note',
  },
  getTranscript: {
    running: 'Reading the transcript…',
    done: 'Read the transcript',
    failed: 'Couldn’t read a transcript',
  },
  listMeetings: {
    running: 'Looking up meetings…',
    done: 'Looked up meetings',
    failed: 'Couldn’t list meetings',
  },
  updateDocument: {
    running: 'Drafting a change…',
    done: 'Drafted a change for your review',
    failed: 'Couldn’t draft the change',
  },
};

const isToolPart = (part: Part): part is ToolPart =>
  part.type.startsWith('tool-') && 'toolCallId' in part;

function textOf(message: ChatUIMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function UserMessage({ message }: { message: ChatUIMessage }) {
  return (
    <div className="flex justify-end" data-testid="chat-message" data-role="user">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
        {textOf(message)}
      </p>
    </div>
  );
}

/**
 * An assistant turn, in stream order: tool activity rows ("Searching meetings…"), answer text with citation
 * chips, and proposal cards where `updateDocument` ran. Proposals come from the saved message's metadata
 * (the server's copy, plain text); while the turn is still streaming a placeholder stands in for them.
 */
export function AssistantMessage({
  message,
  question,
  streaming,
}: {
  message: ChatUIMessage;
  question: string | undefined;
  streaming: boolean;
}) {
  const proposals = message.metadata?.proposals ?? [];
  const order = citationOrder(textOf(message));
  const shown = new Set<string>();
  const items: React.ReactNode[] = [];
  let textBuffer = '';
  let textKey = 0;
  const flushText = () => {
    if (textBuffer.trim()) {
      items.push(
        <Answer key={`text-${textKey++}`} text={textBuffer} messageId={message.id} order={order} />,
      );
    }
    textBuffer = '';
  };

  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      textBuffer += (textBuffer ? '\n\n' : '') + part.text;
      return;
    }
    if (!isToolPart(part)) return;
    flushText();
    const name = part.type.slice('tool-'.length);
    items.push(<ToolActivity key={`tool-${index}`} name={name} part={part} />);
    if (name === 'updateDocument' && part.state === 'output-available') {
      const output = part.output as { proposalId?: unknown } | undefined;
      const proposal = proposals.find((p) => p.id === output?.proposalId);
      if (proposal) {
        shown.add(proposal.id);
        items.push(<ProposalCard key={proposal.id} proposal={proposal} question={question} />);
      } else if (typeof output?.proposalId === 'string') {
        items.push(<ProposalPlaceholder key={`pending-${index}`} />);
      }
    }
  });
  flushText();
  for (const proposal of proposals as ChatProposal[]) {
    if (!shown.has(proposal.id)) {
      items.push(<ProposalCard key={proposal.id} proposal={proposal} question={question} />);
    }
  }

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="chat-message"
      data-role="assistant"
      data-streaming={streaming || undefined}
    >
      {items}
    </div>
  );
}

function ToolActivity({ name, part }: { name: string; part: ToolPart }) {
  const labels = TOOL_LABELS[name] ?? {
    running: 'Working…',
    done: 'Done',
    failed: 'A step failed',
  };
  const output = part.state === 'output-available' ? (part.output as { error?: unknown }) : null;
  const failed = part.state === 'output-error' || (output !== null && output?.error !== undefined);
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const label = running ? labels.running : failed ? labels.failed : labels.done;
  return (
    <p
      data-testid="tool-activity"
      data-tool={name}
      data-state={running ? 'running' : failed ? 'failed' : 'done'}
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      {running ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : failed ? (
        <AlertCircleIcon className="size-3" />
      ) : (
        <CheckIcon className="size-3" />
      )}
      {label}
    </p>
  );
}

function ProposalPlaceholder() {
  return (
    <div
      className="my-2 flex flex-col gap-2 rounded-xl border p-3"
      aria-label="Preparing the change for review"
    >
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  );
}
