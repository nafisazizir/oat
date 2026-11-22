import {
  DocumentActions,
  DocumentTrashBanner,
  documentNode,
  useShellData,
  useWorkspaceHost,
} from '@oat/workspace-ui';
import { Button } from '@oat/ui/components/button';
import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../bridge';

export function MeetingActions({
  id,
  beforeRemove,
  removeDisabled,
  renderSecondaryActions,
}: {
  id: string;
  beforeRemove?(): Promise<boolean>;
  removeDisabled?: boolean;
  renderSecondaryActions?(lifecycle: ReactNode): ReactNode;
}) {
  const shell = useShellData();
  const { client, online } = useWorkspaceHost();
  const known = [...shell.documents, ...shell.trash].find(
    (node) => node.id === id && node.version !== undefined,
  );
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    id: string;
    node?: ReturnType<typeof documentNode>;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (known || !online) return;
    let active = true;
    void client.documents.get(id).then(
      (doc) => {
        if (active) setResult({ id, node: documentNode(doc) });
      },
      () => {
        if (active)
          setResult({ id, error: 'Actions are unavailable. If this note is new, sync it first.' });
      },
    );
    return () => {
      active = false;
    };
  }, [id, known, client, online, revision]);
  const current = result?.id === id ? result : null;
  const node = known ?? current?.node;
  if (node)
    return node.deletedAt || shell.trash.some((item) => item.id === id) ? (
      <DocumentTrashBanner node={node} />
    ) : (
      <DocumentActions
        node={node}
        beforeRemove={beforeRemove}
        removeDisabled={removeDisabled}
        renderSecondaryActions={renderSecondaryActions}
      />
    );
  return (
    <div className="flex flex-col items-start gap-2">
      {renderSecondaryActions?.(null)}
      <p role={current?.error ? 'alert' : 'status'} className="text-copy-14 text-gray-900">
        {!online
          ? 'Reconnect to share or manage this note.'
          : (current?.error ?? 'Loading document actions…')}
      </p>
      {current?.error && online && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void call('sync:now').then(
              () => setRevision((n) => n + 1),
              () => setResult({ id, error: 'Couldn’t sync this note. Please try again.' }),
            );
          }}
        >
          Try again
        </Button>
      )}
    </div>
  );
}
