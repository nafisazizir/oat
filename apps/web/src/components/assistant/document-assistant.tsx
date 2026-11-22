'use client';

import {
  DocumentAssistant as SharedDocumentAssistant,
  segmentHref,
} from '@oat/feature-ui/assistant';
import type { ComponentProps } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';

export { AssistantToggleAnchor } from '@oat/feature-ui/assistant';

export function DocumentAssistant(
  props: Omit<
    ComponentProps<typeof SharedDocumentAssistant>,
    'onTranscriptClose' | 'onOpenTranscript'
  >,
) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SharedDocumentAssistant
      {...props}
      onTranscriptClose={() => router.replace(pathname as Route, { scroll: false })}
      onOpenTranscript={(citation) =>
        router.replace(segmentHref(citation.documentId, citation.startMs, citation.id) as Route, {
          scroll: false,
        })
      }
    />
  );
}
