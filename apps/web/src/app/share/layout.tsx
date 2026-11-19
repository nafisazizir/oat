import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { IconEye } from '@tabler/icons-react';
import Link from 'next/link';

import { ThemeMenu } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';

/** Header and footer share the reading column of the page (`PageContainer`), so everything lines up. */
const column = 'mx-auto flex w-full max-w-content items-center px-6 sm:px-8';

/**
 * Public, read-only layout for anyone-with-the-link pages (`share/[token]`, 5.3). No app chrome. The
 * "Read-only" badge and the link note only make sense next to a document: an unavailable link
 * (`data-share-missing`, the 404) hides them.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="group/share flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b border-gray-alpha-400 bg-background-100">
        <div className={`${column} h-14 gap-3`}>
          <Link
            href="/"
            aria-label="Oat home"
            className="rounded-sm focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
          >
            <Wordmark />
          </Link>
          <Badge variant="outline" className="gap-1 group-has-[[data-share-missing]]/share:hidden">
            <IconEye />
            Read-only
          </Badge>
          <div className="ms-auto flex items-center gap-1">
            <ThemeMenu />
            <Button size="sm" role="link" nativeButton={false} render={<Link href="/sign-in" />}>
              Try Oat
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-gray-alpha-400 group-has-[[data-share-missing]]/share:hidden">
        <div className={`${column} h-14 text-copy-13 text-gray-900`}>
          Shared from Oat. Only people with the link can see this page.
        </div>
      </footer>
    </div>
  );
}
