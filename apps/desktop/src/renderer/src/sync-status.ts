/**
 * What the sidebar says about sync (2.6). Pure, so the wording is unit-tested. `null` = say nothing
 * (signed out).
 */
import type { SyncStatusSnapshot } from '@oat/core/bridge';

export type SyncTone = 'ok' | 'busy' | 'waiting' | 'offline' | 'problem';

export interface SyncLabel {
  tone: SyncTone;
  text: string;
}

const changes = (n: number) => (n === 1 ? '1 change' : `${n} changes`);

export function syncLabel(status: SyncStatusSnapshot): SyncLabel | null {
  switch (status.state) {
    case 'stopped':
      return null;
    case 'syncing':
      return {
        tone: 'busy',
        text: status.pending ? `Syncing ${changes(status.pending)}…` : 'Syncing…',
      };
    case 'offline':
      return {
        tone: 'offline',
        text: status.pending
          ? `Offline — ${changes(status.pending)} saved on this Mac`
          : 'Offline — everything is saved on this Mac',
      };
    case 'error':
      return { tone: 'problem', text: 'Sync problem — retrying' };
    case 'idle':
      if (status.parked) {
        return {
          tone: 'problem',
          text: `${changes(status.parked)} couldn’t sync — kept on this Mac, retrying later`,
        };
      }
      return status.pending
        ? { tone: 'waiting', text: `${changes(status.pending)} waiting to sync` }
        : { tone: 'ok', text: 'All changes synced' };
  }
}
