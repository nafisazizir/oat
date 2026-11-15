import { Button } from '@oat/ui/components/button';
import { FileQuestionIcon } from 'lucide-react';
import Link from 'next/link';

import { EmptyState, PageContainer } from '@/components/page';

export default function AppNotFound() {
  return (
    <PageContainer>
      <EmptyState
        icon={FileQuestionIcon}
        title="Page not found"
        titleAs="h1"
        description="It may have been moved or deleted, or you might not have access to it."
      >
        <Button asChild>
          <Link href="/home">Go home</Link>
        </Button>
      </EmptyState>
    </PageContainer>
  );
}
