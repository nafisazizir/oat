import type { Metadata } from 'next';

import { Providers } from '@/components/providers';
import { themeScript } from '@/lib/theme';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Oat', template: '%s · Oat' },
  description: 'Meeting notes that write themselves, in a workspace that keeps them.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The head script sets `.dark` before React hydrates, so the class differs from the server HTML.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint: no light flash for dark-mode users. Server-rendered only. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
