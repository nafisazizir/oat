'use client';

import { groupNotesByDate } from '@oat/meeting-ui';
import { IconFileText, IconNotebook } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';

import { type DocumentNode, titleOf } from '@/lib/tree';
import { useHydrated } from '@/lib/use-hydrated';

export function HomeNotes({ documents }: { documents: DocumentNode[] }) {
  const [now] = useState(() => Date.now());
  const hydrated = useHydrated();
  const timeZone = hydrated ? undefined : 'UTC';
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  if (documents.length === 0)
    return (
      <p className="py-8 text-copy-14 text-gray-900" data-testid="home-empty">
        No notes yet
      </p>
    );
  return (
    <div className="flex flex-col gap-7" data-testid="home-notes">
      {groupNotesByDate(documents, (doc) => doc.updatedAt, now, timeZone).map((group) => (
        <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
          <h2 className="px-2 text-label-12 text-gray-900">{group.label}</h2>
          <ul className="flex flex-col">
            {group.notes.map((doc) => {
              const Icon = doc.kind === 'meeting' ? IconNotebook : IconFileText;
              return (
                <li key={doc.id}>
                  <Link
                    href={`/d/${doc.id}`}
                    data-testid="home-note-row"
                    className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2.5 text-copy-14 text-gray-1000 outline-none transition-colors hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50"
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-gray-900" />
                    <span className="min-w-0 flex-1 truncate">{titleOf(doc)}</span>
                    <time dateTime={doc.updatedAt} className="shrink-0 text-label-12 text-gray-900">
                      {time.format(new Date(doc.updatedAt))}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
