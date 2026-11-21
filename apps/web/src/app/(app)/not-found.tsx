import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconFileUnknown } from '@tabler/icons-react';
import Link from 'next/link';

import { PageContainer } from '@/components/page';

export default function AppNotFound() {
  return (
    <PageContainer>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconFileUnknown />
          </EmptyMedia>
          <EmptyTitle>
            <h1 className="text-display-20">Page not found</h1>
          </EmptyTitle>
          <EmptyDescription>
            It may have been moved or deleted, or you might not have access to it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button role="link" nativeButton={false} render={<Link href="/home" />}>
            Go home
          </Button>
        </EmptyContent>
      </Empty>
    </PageContainer>
  );
}
