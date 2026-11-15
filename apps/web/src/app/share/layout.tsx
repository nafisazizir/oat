import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { EyeIcon } from 'lucide-react';
import Link from 'next/link';

import { ThemeMenu } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';

/** Public, read-only layout for anyone-with-the-link pages (viewer lands in 5.4). No sidebar. */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Oat home">
            <Wordmark />
          </Link>
          <Badge variant="outline" className="gap-1">
            <EyeIcon />
            Read-only
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <ThemeMenu />
            <Button size="sm" asChild>
              <Link href="/sign-in">Try Oat</Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-4 text-xs text-muted-foreground sm:px-6">
          Shared from Oat. Only people with the link can see this page.
        </div>
      </footer>
    </div>
  );
}
