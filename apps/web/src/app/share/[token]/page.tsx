import { Badge } from '@oat/ui/components/badge';
import { FileTextIcon, NotebookPenIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { cache } from 'react';

import { PageContainer, SectionHeading } from '@/components/page';
import { formatDate } from '@/lib/format';
import { getDb } from '@/server/db';
import { loadSharedDocument, type SharedTranscriptLine } from '@/server/sharing';

type Props = { params: Promise<{ token: string }> };

/** Per request: metadata and the page share one lookup. */
const load = cache((token: string) => loadSharedDocument(getDb(), token));

const titleOf = (title: string) => title.trim() || 'Untitled';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const shared = await load(token);
  const base: Metadata = {
    // Shared pages are unlisted, and the token in the URL never leaves in a Referer header.
    robots: { index: false, follow: false, nocache: true },
    referrer: 'no-referrer',
  };
  if (!shared) return { ...base, title: 'Link not available' };
  const title = titleOf(shared.title);
  // Minimal Open Graph: the title only (no excerpt, author or workspace).
  return { ...base, title, openGraph: { title, type: 'article', siteName: 'Oat' } };
}

function duration(start: Date | null, end: Date | null): string | null {
  if (!start || !end || end <= start) return null;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function offset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * `/share/[token]`: the public, read-only view of a document shared by link (5.3/5.4). No session needed
 * or used; the proxy adds CSP/no-referrer/noindex headers and rate-limits it. Unknown, disabled, reset
 * and trashed links are all the same 404. The body is server-rendered HTML from `@oat/editor/html`
 * (schema-validated, allowlist-sanitised), so no editor JavaScript ships to link viewers.
 */
export default async function SharePage({ params }: Props) {
  await connection(); // always per request (CSP nonce, live visibility)
  const { token } = await params;
  const shared = await load(token);
  if (!shared) notFound();

  const isMeeting = shared.kind === 'meeting';
  const when = shared.meeting?.startedAt ?? null;
  const length = shared.meeting ? duration(shared.meeting.startedAt, shared.meeting.endedAt) : null;

  return (
    <PageContainer className="gap-8" data-testid="shared-document">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="gap-1">
            {isMeeting ? <NotebookPenIcon /> : <FileTextIcon />}
            {isMeeting ? 'Meeting notes' : 'Page'}
          </Badge>
          {when && <span data-testid="shared-meeting-date">{formatDate(when)}</span>}
          {length && (
            <>
              <span aria-hidden>·</span>
              <span>{length}</span>
            </>
          )}
        </div>
        <h1 className="font-heading text-3xl font-medium text-balance">{titleOf(shared.title)}</h1>
        <p className="text-sm text-muted-foreground">
          {shared.authorName ? `Shared by ${shared.authorName} · ` : ''}
          Edited {formatDate(shared.updatedAt)}
        </p>
      </header>

      <div
        className="oat-editor"
        data-testid="shared-content"
        // Sanitised by renderDocumentHtml (schema check + allowlist sanitiser).
        dangerouslySetInnerHTML={{ __html: shared.html }}
      />

      {shared.transcript && <Transcript lines={shared.transcript} />}
    </PageContainer>
  );
}

function Transcript({ lines }: { lines: SharedTranscriptLine[] }) {
  return (
    <section
      aria-labelledby="transcript-heading"
      className="flex flex-col gap-4 border-t pt-8"
      data-testid="shared-transcript"
    >
      <SectionHeading>
        <span id="transcript-heading">Transcript</span>
      </SectionHeading>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transcript was recorded.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {lines.map((line, index) => (
            <li key={index} className="grid grid-cols-[3.5rem_1fr] gap-x-3 text-sm">
              <span className="pt-px font-mono text-xs text-muted-foreground tabular-nums">
                {offset(line.startMs)}
              </span>
              <div className="flex flex-col gap-0.5">
                <span
                  className={
                    line.source === 'mic'
                      ? 'text-xs font-medium text-foreground'
                      : 'text-xs font-medium text-muted-foreground'
                  }
                >
                  {line.speaker}
                </span>
                <p className="leading-relaxed">{line.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
