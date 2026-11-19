'use client';

import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconArrowUpRight, IconRefresh, IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { isApiError } from '@/lib/api-client';
import type { NotionDocumentStatus } from '@/lib/api-types';
import { formatDay } from '@/lib/format';
import { notionApi } from '@/lib/notion-client';

const SETTINGS = '/settings/integrations';

/**
 * "Send to Notion" / "Update in Notion" on the document page (8.1), with a link to the Notion copy once the
 * note was sent. Loads its status after mount (`GET /api/documents/:id/notion`) and renders nothing when
 * Notion isn't set up on the server. Without a connection or target it explains what to do in a toast that
 * links to Settings → Integrations.
 */
export function NotionExportButton({
  documentId,
  beforeSend,
  wrap,
}: {
  documentId: string;
  /** Flush pending edits so Notion gets what's on screen. */
  beforeSend?: () => Promise<void>;
  /** Places the control (e.g. in a "More actions" popover, 9.3b); only called when Notion is set up. */
  wrap?: (control: React.ReactNode) => React.ReactNode;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<NotionDocumentStatus | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    notionApi
      .status(documentId)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => undefined); // no control rather than a broken one
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!status?.configured) return null;
  const exported = status.export;

  const toSettings = (message: string, description: string, label = 'Open settings') =>
    toast.error(message, {
      description,
      action: { label, onClick: () => router.push(SETTINGS) },
    });

  async function send() {
    const connection = status?.connection;
    if (!connection) {
      return toSettings(
        'Connect Notion first',
        'Connect a Notion workspace in Settings → Integrations, then send this note.',
        'Connect Notion',
      );
    }
    if (connection.needsReconnect) {
      return toSettings(
        'Reconnect Notion',
        'Oat can no longer reach your Notion workspace.',
        'Reconnect',
      );
    }
    if (!connection.target) {
      return toSettings(
        'Choose where notes go',
        'Pick a Notion page or database in Settings → Integrations.',
        'Choose',
      );
    }
    setSending(true);
    try {
      await beforeSend?.();
      const result = await notionApi.send(documentId);
      setStatus((s) =>
        s
          ? {
              ...s,
              export: {
                url: result.url,
                pushedAt: result.pushedAt,
                pushedVersion: result.pushedVersion,
                changedSince: false,
              },
            }
          : s,
      );
      toast.success(exported && !result.created ? 'Updated in Notion' : 'Sent to Notion', {
        description: `In “${connection.target.title || 'Untitled'}”.`,
        action: { label: 'Open', onClick: () => window.open(result.url, '_blank', 'noopener') },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      if (
        isApiError(error, 'notion_reconnect') ||
        isApiError(error, 'notion_no_target') ||
        isApiError(error, 'notion_not_connected')
      ) {
        // The server's view changed (revoked, target gone): refresh ours.
        notionApi.status(documentId).then(setStatus, () => undefined);
        toSettings('Couldn’t send to Notion', message);
      } else {
        toast.error('Couldn’t send to Notion', { description: message });
      }
    } finally {
      setSending(false);
    }
  }

  const control = (
    <div className="flex items-center gap-2" data-testid="notion-export">
      {exported?.url && (
        <a
          href={exported.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="notion-link"
          title={`Sent to Notion ${formatDay(exported.pushedAt)}`}
          className="inline-flex items-center gap-0.5 rounded-sm text-label-13 text-gray-900 underline-offset-2 outline-none hover:text-gray-1000 hover:underline focus-visible:ring-3 focus-visible:ring-gray-600/50"
        >
          {exported.changedSince
            ? 'Notion copy is older'
            : `In Notion · ${formatDay(exported.pushedAt)}`}
          <IconArrowUpRight aria-hidden className="size-3.5" />
        </a>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void send()}
        disabled={sending}
        data-testid="notion-send"
      >
        {sending ? (
          <Spinner data-icon="inline-start" />
        ) : exported ? (
          <IconRefresh data-icon="inline-start" />
        ) : (
          <IconSend data-icon="inline-start" />
        )}
        {exported ? 'Update in Notion' : 'Send to Notion'}
      </Button>
    </div>
  );
  return wrap ? wrap(control) : control;
}
