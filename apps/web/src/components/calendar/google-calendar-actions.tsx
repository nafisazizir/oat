'use client';

import { Button } from '@oat/ui/components/button';
import { Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { authClient, GOOGLE_CALENDAR_PROVIDER_ID } from '@/lib/auth-client';
import { disconnectGoogleCalendarAction } from '@/server/actions/calendar';

const PAGE = '/settings/integrations';

/** Starts the Google consent flow for calendar access (Better Auth `link-social`, link-only provider). */
export function ConnectGoogleCalendarButton({
  label = 'Connect Google Calendar',
  ...props
}: { label?: string } & Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  const [pending, setPending] = useState(false);
  async function connect() {
    setPending(true);
    const { error } = await authClient.linkSocial({
      provider: GOOGLE_CALENDAR_PROVIDER_ID,
      callbackURL: `${PAGE}?connected=google-calendar`,
      errorCallbackURL: PAGE,
    });
    // On success the browser is already on its way to Google.
    if (error) {
      setPending(false);
      toast.error('Couldn’t start connecting Google Calendar', {
        description: error.message ?? 'Please try again.',
      });
    }
  }
  return (
    <Button onClick={connect} disabled={pending} {...props}>
      {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
      {label}
    </Button>
  );
}

export function DisconnectGoogleCalendarButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function disconnect() {
    startTransition(async () => {
      const result = await disconnectGoogleCalendarAction();
      if (result.ok) {
        toast('Google Calendar disconnected');
        router.replace(PAGE);
      } else {
        toast.error(result.error);
      }
    });
  }
  return (
    <Button variant="outline" onClick={disconnect} disabled={pending}>
      {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
      Disconnect
    </Button>
  );
}
