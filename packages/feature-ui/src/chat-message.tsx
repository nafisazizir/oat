'use client';

import { cn } from '@oat/ui';
import { Bubble, BubbleContent } from '@oat/ui/components/bubble';
import { Message, MessageContent } from '@oat/ui/components/message';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';

import { citationOrder } from './chat-markdown';
import type { ChatProposal, ChatUIMessage } from '@oat/services/dto/chat';

import { Answer, AnswerSources } from './answer';
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
    <Message align="end" data-testid="chat-message" data-role="user">
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{textOf(message)}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
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
    <Message
      data-testid="chat-message"
      data-role="assistant"
      data-streaming={streaming || undefined}
    >
      <MessageContent className="gap-2">
        {items}
        <AnswerSources order={order} />
      </MessageContent>
    </Message>
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
      className={cn(
        'flex items-center gap-1.5 text-label-13 text-gray-900',
        failed && 'text-red-900',
      )}
    >
      {running ? (
        <Spinner aria-hidden role={undefined} className="size-3.5" />
      ) : failed ? (
        <IconAlertCircle aria-hidden className="size-3.5" />
      ) : (
        <IconCheck aria-hidden className="size-3.5" />
      )}
      {label}
    </p>
  );
}

function ProposalPlaceholder() {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-gray-alpha-400 p-3"
      role="status"
      aria-label="Preparing the change for review"
    >
      <Skeleton className="h-9 w-1/2" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
