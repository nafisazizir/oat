import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconLinkOff } from '@tabler/icons-react';

import { PageContainer } from '@/components/page';

/**
 * Any share link that doesn't resolve: unknown, turned off, reset or in the trash. One message for all,
 * so a link never reveals whether a document exists.
 */
export default function ShareNotFound() {
  return (
    <PageContainer data-share-missing="">
      <Empty className="mt-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconLinkOff />
          </EmptyMedia>
          <EmptyTitle>
            <h1>This link isn’t available</h1>
          </EmptyTitle>
          <EmptyDescription>
            It may have been turned off or replaced with a new link. Ask the person who shared it
            for an up-to-date one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PageContainer>
  );
}
