import { Button } from '@oat/ui/components/button';
import Link from 'next/link';

import { Wordmark } from '@/components/wordmark';

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background-100 px-6 text-center">
      <Wordmark size="lg" />
      <div className="flex flex-col gap-2">
        <h1 className="text-display-24 text-gray-1000">Page not found</h1>
        <p className="text-copy-16 text-gray-900">
          The link may be broken, or the page may have moved.
        </p>
      </div>
      <Button role="link" nativeButton={false} render={<Link href="/home" />}>
        Go home
      </Button>
    </main>
  );
}
