import Link from 'next/link';

import { Wordmark } from '@/components/wordmark';

/** Signed-out pages: a quiet centered column on the paper background, no app chrome. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center bg-background-200 px-4">
      <header className="flex w-full max-w-sm justify-center pt-16 pb-8 sm:pt-24">
        <Link
          href="/"
          aria-label="Oat home"
          className="rounded-md focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
        >
          <Wordmark size="lg" />
        </Link>
      </header>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
