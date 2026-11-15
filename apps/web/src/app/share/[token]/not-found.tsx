import { LinkIcon } from 'lucide-react';

import { EmptyState, PageContainer } from '@/components/page';

/**
 * Any share link that doesn't resolve: unknown, turned off, reset or in the trash. One message for all,
 * so a link never reveals whether a document exists.
 */
export default function ShareNotFound() {
  return (
    <PageContainer data-share-missing="">
      <EmptyState
        icon={LinkIcon}
        title="This link isn’t available"
        titleAs="h1"
        description="It may have been turned off or replaced with a new link. Ask the person who shared it for an up-to-date one."
        className="mt-6"
      />
    </PageContainer>
  );
}
