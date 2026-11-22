'use client';

import { LeaveWorkspaceDialog as SharedDialog } from '@oat/settings-ui';
import type { ComponentProps } from 'react';

import { downloadWorkspaceNotes } from '@/components/settings/web-settings';
import { leaveWorkspace } from '@/server/actions/members';

export function LeaveWorkspaceDialog(
  props: Omit<ComponentProps<typeof SharedDialog>, 'onLeave' | 'download'>,
) {
  return (
    <SharedDialog
      {...props}
      onLeave={() => leaveWorkspace(props.workspace.id)}
      download={() => downloadWorkspaceNotes(props.workspace.id)}
    />
  );
}
