import Link from 'next/link';

import { Wordmark } from '@/components/wordmark';

/** Signed-out pages: a quiet centered column on the paper background, no app chrome. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 bg-background-100 px-6 py-12">
      <header className="flex w-full max-w-[22.5rem] justify-center">
        <Link
          href="/"
          aria-label="Oat home"
          className="rounded-md focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
        >
          <Wordmark size="sm" />
        </Link>
      </header>
      <main className="w-full max-w-[22.5rem]">{children}</main>
    </div>
  );
}
