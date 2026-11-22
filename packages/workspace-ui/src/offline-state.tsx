import { IconCloudOff } from '@tabler/icons-react';
import { EmptyState } from './page';

export function OfflineState() {
  return (
    <EmptyState
      icon={IconCloudOff}
      title="You’re offline"
      description="Pages, folders and templates come back when you reconnect."
    />
  );
}
