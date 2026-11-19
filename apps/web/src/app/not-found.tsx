import { Button } from '@oat/ui/components/button';
import Link from 'next/link';

import { Wordmark } from '@/components/wordmark';

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <Wordmark className="text-3xl" />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Page not found</h1>
        <p className="text-muted-foreground">The link may be broken, or the page may have moved.</p>
      </div>
      <Button role="link" nativeButton={false} render={<Link href="/home" />}>
        Go home
      </Button>
    </main>
  );
}
