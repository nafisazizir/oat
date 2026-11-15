'use client';

import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { MailIcon } from 'lucide-react';
import { useState } from 'react';

/** Form UI only: magic link + Google are wired to Better Auth in 1.6. */
export function SignInForm() {
  const [notice, setNotice] = useState<string | null>(null);
  const pending = () =>
    setNotice('Sign-in isn’t connected yet. It arrives with accounts (task 1.6).');

  return (
    <div>
      <div className="flex flex-col gap-5">
        <Button variant="outline" size="lg" className="w-full" type="button" onClick={pending}>
          Continue with Google
        </Button>

        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            pending();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
            />
          </div>
          <Button type="submit" size="lg" className="w-full">
            <MailIcon data-icon="inline-start" />
            Email me a sign-in link
          </Button>
        </form>
      </div>

      {/* Live region stays mounted (announcements); it takes no space while empty. */}
      <p role="status" className="text-center text-xs text-muted-foreground not-empty:mt-4">
        {notice}
      </p>
    </div>
  );
}
