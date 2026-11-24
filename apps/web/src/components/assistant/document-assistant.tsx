'use client';

import {
  DocumentAssistant as SharedDocumentAssistant,
  segmentHref,
} from '@oat/feature-ui/assistant';
import { createContext, useCallback, useContext, useState, type ComponentProps } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';

export { AssistantToggleAnchor } from '@oat/feature-ui/assistant';

const TranscriptCitationContext = createContext(0);
export const useTranscriptCitationRevision = () => useContext(TranscriptCitationContext);

export function DocumentAssistant(
  props: Omit<
    ComponentProps<typeof SharedDocumentAssistant>,
    'onTranscriptClose' | 'onOpenTranscript'
  >,
) {
  const router = useRouter();
  const pathname = usePathname();
  const [citationRevision, setCitationRevision] = useState(0);
  const openTranscript = useCallback<
    NonNullable<ComponentProps<typeof SharedDocumentAssistant>['onOpenTranscript']>
  >(
    (citation) => {
      setCitationRevision((revision) => revision + 1);
      router.replace(segmentHref(citation.documentId, citation.startMs, citation.id) as Route, {
        scroll: false,
      });
    },
    [router],
  );
  return (
    <SharedDocumentAssistant
      {...props}
      onTranscriptClose={() => router.replace(pathname as Route, { scroll: false })}
      onOpenTranscript={openTranscript}
    >
      <TranscriptCitationContext.Provider value={citationRevision}>
        {props.children}
      </TranscriptCitationContext.Provider>
    </SharedDocumentAssistant>
  );
}
