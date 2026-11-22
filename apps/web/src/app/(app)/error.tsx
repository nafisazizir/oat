'use client';

import { Button } from '@oat/ui/components/button';
import { PageError, errorDigest } from '@oat/ui/components/page-error';
import Link from 'next/link';
import { PageContainer } from '@/components/page';

export default function AppError({ error, retry }: { error: unknown; retry(): void }) {
  return (
    <PageContainer>
      <PageError
        onRetry={retry}
        digest={errorDigest(error)}
        home={
          <Button variant="ghost" role="link" nativeButton={false} render={<Link href="/home" />}>
            Go home
          </Button>
        }
      />
    </PageContainer>
  );
}
