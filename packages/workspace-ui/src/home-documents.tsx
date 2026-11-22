'use client';
import { groupNotesByDate } from '@oat/meeting-ui';
import { IconFileText, IconNotebook } from '@tabler/icons-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import type { HomeDocument } from './home-model';
import { titleOf } from './tree';
import { EmptyState } from './page';

export type HomeLinkProps = { document: HomeDocument; children: ReactNode; className: string };
export function HomeDocuments({
  documents,
  Link,
  onOpen,
  timeZone,
  recordingMeetingId,
  emptyMessage = 'No notes yet',
}: {
  documents: readonly HomeDocument[];
  Link?: ComponentType<HomeLinkProps>;
  onOpen?(id: string): void;
  timeZone?: string;
  recordingMeetingId?: string | null;
  emptyMessage?: string;
}) {
  const [now] = useState(() => Date.now());
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  if (!documents.length)
    return (
      <div data-testid="home-empty">
        <EmptyState
          icon={IconNotebook}
          title={emptyMessage}
          description="Create a note or start a meeting to capture what matters."
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-7" data-testid="home-notes">
      {groupNotesByDate([...documents], (doc) => doc.updatedAt, now, timeZone).map((group) => (
        <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
          <h2 className="px-2 text-label-12 text-gray-900">{group.label}</h2>
          <ul className="flex flex-col">
            {group.notes.map((doc) => {
              const Icon = doc.kind === 'meeting' ? IconNotebook : IconFileText;
              const className =
                'flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2.5 text-start text-copy-14 text-gray-1000 outline-none transition-colors hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50';
              const children = (
                <>
                  <Icon aria-hidden className="size-4 shrink-0 text-gray-900" />
                  <span className="min-w-0 flex-1 truncate">{titleOf(doc)}</span>
                  {recordingMeetingId && recordingMeetingId === doc.meetingId && (
                    <span className="text-label-12 text-red-900">Recording</span>
                  )}
                  {doc.pending && <span className="text-label-12 text-gray-900">Pending sync</span>}
                  <time dateTime={doc.updatedAt} className="shrink-0 text-label-12 text-gray-900">
                    {time.format(new Date(doc.updatedAt))}
                  </time>
                </>
              );
              return (
                <li key={doc.id}>
                  {Link ? (
                    <Link document={doc} className={className}>
                      {children}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      data-testid="home-note-row"
                      className={className}
                      onClick={() => onOpen?.(doc.id)}
                    >
                      {children}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
