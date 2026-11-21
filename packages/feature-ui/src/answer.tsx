'use client';

import { cn } from '@oat/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { Fragment, type ReactNode, useMemo } from 'react';

import { type MdNode, parseAnswer } from './chat-markdown';
import { clock } from './transcript';
import { TargetLink, useFeatureUi, type AppTarget } from './provider';

import { useChatSession, useOpenCitation } from './session-context';

/**
 * An answer's text: sanitised Markdown (`parseAnswer`, rendered as React elements only) with citation markers
 * as numbered chips, numbered per answer (all its text parts) in order of first appearance.
 */
export function Answer({
  text,
  messageId,
  order,
}: {
  text: string;
  messageId: string;
  /** Citation keys of the whole answer in order (`citationOrder`), so numbers run across its text parts. */
  order: readonly string[];
}) {
  const nodes = useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="chat-prose text-copy-14 text-gray-1000" data-testid="chat-answer">
      {render(nodes, { order, messageId })}
    </div>
  );
}

type RenderContext = { order: readonly string[]; messageId: string };

function render(nodes: MdNode[], ctx: RenderContext): ReactNode {
  return nodes.map((node, i) => {
    if (node.type === 'text') return <Fragment key={i}>{node.text}</Fragment>;
    if (node.type === 'cite') {
      const key = `${node.kind}:${node.id}`;
      return (
        <CitationChip
          key={i}
          citationKey={key}
          number={ctx.order.indexOf(key) + 1}
          messageId={ctx.messageId}
        />
      );
    }
    const children = render(node.children, ctx);
    switch (node.tag) {
      case 'a': {
        const external = !node.href!.startsWith('/');
        return (
          <AnswerLink
            key={i}
            href={node.href!}
            className="text-gray-1000 underline underline-offset-2 hover:text-gray-900"
            {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
          >
            {children}
          </AnswerLink>
        );
      }
      case 'br':
        return <br key={i} />;
      case 'hr':
        return <hr key={i} className="my-3 border-gray-alpha-400" />;
      case 'p':
        return (
          <p key={i} className="my-2 whitespace-pre-line first:mt-0 last:mb-0">
            {children}
          </p>
        );
      case 'h3':
        return (
          <h3 key={i} className="mt-4 mb-1 text-heading-16 first:mt-0">
            {children}
          </h3>
        );
      case 'h4':
        return (
          <h4 key={i} className="mt-3 mb-1 text-heading-14 first:mt-0">
            {children}
          </h4>
        );
      case 'ul':
        return (
          <ul key={i} className="my-2 list-disc space-y-1 ps-5">
            {children}
          </ul>
        );
      case 'ol':
        return (
          <ol key={i} className="my-2 list-decimal space-y-1 ps-5">
            {children}
          </ol>
        );
      case 'blockquote':
        return (
          <blockquote key={i} className="my-2 border-s-2 border-gray-alpha-400 ps-3 text-gray-900">
            {children}
          </blockquote>
        );
      case 'code':
        return (
          <code key={i} className="rounded-sm bg-gray-100 px-1 py-px text-copy-13-mono">
            {children}
          </code>
        );
      case 'pre':
        return (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg border border-gray-alpha-400 bg-background-200 p-3 text-copy-13-mono [&_code]:bg-transparent [&_code]:p-0"
          >
            {children}
          </pre>
        );
      case 'table':
        return (
          <div key={i} className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-copy-13">{children}</table>
          </div>
        );
      case 'th':
        return (
          <th key={i} className="border border-gray-alpha-400 px-2 py-1 text-start text-label-13">
            {children}
          </th>
        );
      case 'td':
        return (
          <td key={i} className="border border-gray-alpha-400 px-2 py-1">
            {children}
          </td>
        );
      default: {
        const Tag = node.tag;
        return <Tag key={i}>{children}</Tag>;
      }
    }
  });
}

function AnswerLink({ href, ...props }: React.ComponentProps<'a'> & { href: string }) {
  const { Link = 'a' } = useFeatureUi();
  let target: AppTarget | undefined;
  if (href.startsWith('/d/')) {
    try {
      const url = new URL(href, 'https://oat.invalid');
      const match = /^\/d\/([^/]+)$/.exec(url.pathname);
      if (match)
        target = {
          kind: 'document',
          id: decodeURIComponent(match[1]!),
          ...(url.searchParams.get('block') ? { blockId: url.searchParams.get('block')! } : {}),
          ...(url.searchParams.get('seg') ? { segmentId: url.searchParams.get('seg')! } : {}),
          ...(url.searchParams.has('t') && Number.isFinite(Number(url.searchParams.get('t')))
            ? { timeMs: Number(url.searchParams.get('t')) * 1000 }
            : {}),
        };
    } catch {
      /* Invalid links remain ordinary anchors. */
    }
  }
  return target ? <TargetLink {...props} target={target} /> : <Link {...props} href={href} />;
}

/**
 * A citation as a small numbered chip. Resolved through the thread's `sources` (re-checked access): clicking
 * jumps to the transcript moment or the note block. While the answer is still streaming the source isn't
 * resolved yet; once saved, a source the reader can't open (deleted, no longer shared) shows as unavailable.
 */
function CitationChip({
  citationKey,
  number,
  messageId,
}: {
  citationKey: string;
  number: number;
  messageId: string;
}) {
  const session = useChatSession();
  const openCitation = useOpenCitation();
  const source = session.sources.citations[citationKey];
  const kind = citationKey.startsWith('seg:') ? 'seg' : 'block';
  const base =
    'mx-0.5 inline-flex h-4.5 min-w-4.5 translate-y-[-1px] items-center justify-center rounded-md px-1 align-middle text-label-12 tabular-nums transition-colors duration-100';

  if (!source) {
    const saved = session.isSaved(messageId);
    return (
      <span
        data-testid="citation-chip"
        data-state={saved ? 'unavailable' : 'pending'}
        data-kind={kind}
        title={saved ? 'This source is no longer available' : 'Loading source…'}
        className={cn(
          base,
          'bg-gray-100 text-gray-900',
          saved && 'line-through decoration-gray-700',
        )}
      >
        {number}
      </span>
    );
  }

  const label =
    source.kind === 'seg'
      ? `${source.title} · ${clock(source.startMs)} · ${source.speaker}`
      : source.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="citation-chip"
            data-state="ready"
            data-kind={source.kind}
            aria-label={`Source ${number}: ${label}`}
            onClick={() => openCitation(source)}
            className={cn(
              base,
              'cursor-pointer bg-gray-100 text-gray-1000 outline-none hover:bg-gray-200 focus-visible:ring-3 focus-visible:ring-gray-600/50',
            )}
          />
        }
      >
        {number}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 flex-col items-start gap-1 text-start">
        <span className="text-label-13">{label}</span>
        {source.text && (
          <span className="line-clamp-3 text-copy-13 opacity-80">“{source.text}”</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
