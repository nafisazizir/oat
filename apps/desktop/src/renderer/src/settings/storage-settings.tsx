import type {
  RetentionPolicy,
  RetentionPreview,
  StorageMeeting,
  StorageSummary,
} from '@oat/core/bridge';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@oat/ui/components/alert-dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconDeviceDesktop,
  IconFolderOpen,
  IconMicrophone,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';

import { BridgeCallError, bridge, call } from '../bridge.ts';
import {
  describePreview,
  formatBytes,
  formatDuration,
  formatWhen,
  type PolicyKind,
  policyAmount,
  policyFromForm,
  samePolicy,
  sortMeetings,
  type StorageSort,
} from './storage-format.ts';

const message = (e: unknown) =>
  e instanceof BridgeCallError ? e.message : 'Something went wrong.';

/**
 * Settings → Storage (3.8, D-10): how much space this Mac's recordings use, the retention policy (with a
 * dry run) and every meeting's audio with "Show in Finder" / "Delete audio". Transcripts and notes are
 * never affected. Re-reads on `storage:changed` (sweeps, deletes, recordings ending).
 */
export function StorageSettings() {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped to re-read: on `storage:changed` pushes and after a delete.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => bridge().subscribe('storage:changed', reload), [reload]);
  useEffect(() => {
    let live = true;
    call('storage:list').then(
      (value) => {
        if (!live) return;
        setSummary(value);
        setError(null);
      },
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="flex flex-col gap-5" data-testid="storage-settings">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading-16 text-gray-1000">Storage</h2>
        <p className="text-copy-14 text-gray-900">
          Meeting audio is saved only on this Mac and never uploaded. Deleting audio keeps the
          transcript and your notes.
        </p>
      </div>
      <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
        {error}
      </p>
      {summary ? (
        <>
          <UsageCard summary={summary} />
          <RetentionCard summary={summary} onSaved={setSummary} />
          <RecordingsList
            meetings={summary.meetings}
            hidden={summary.meetingCount - summary.meetings.length}
            others={summary.otherAccounts}
            onChanged={reload}
          />
        </>
      ) : (
        !error && (
          <div className="flex flex-col gap-4" aria-busy>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        )
      )}
    </div>
  );
}

function UsageCard({ summary }: { summary: StorageSummary }) {
  const count = summary.meetingCount;
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-900">
          <IconDeviceDesktop className="size-5" />
        </div>
        <div className="flex min-w-0 flex-col">
          <p className="text-heading-24 text-gray-1000 tabular-nums" data-testid="storage-total">
            {formatBytes(summary.totalBytes)}
          </p>
          <p className="text-copy-14 text-gray-900">
            Your audio of {count} {count === 1 ? 'meeting' : 'meetings'} on this Mac
            {summary.deletedMeetings > 0 && ` · ${summary.deletedMeetings} with audio deleted`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const KIND_LABELS: Record<PolicyKind, string> = {
  forever: 'Keep forever',
  age: 'Delete audio older than…',
  size: 'Limit total size to…',
};

function RetentionCard({
  summary,
  onSaved,
}: {
  summary: StorageSummary;
  onSaved: (summary: StorageSummary) => void;
}) {
  const saved = summary.policy;
  const [kind, setKind] = useState<PolicyKind>(saved.kind);
  const [amount, setAmount] = useState(policyAmount(saved) || '30');
  // The dry run of the policy currently in the form (keyed, so a stale one is never shown).
  const [previewOf, setPreviewOf] = useState<{ key: string; preview: RetentionPreview } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = policyFromForm(kind, amount);
  const policyKey = JSON.stringify(policy);
  const dirty = !samePolicy(policy, saved);
  const preview = previewOf?.key === policyKey ? previewOf.preview : null;
  // Saving can delete audio right away: only once the dry run of exactly this policy is known.
  const ready = policy !== null && (policy.kind === 'forever' || preview !== null);
  const [confirming, setConfirming] = useState<RetentionPreview | null>(null);

  // Dry run whenever the form holds a valid policy (debounced while typing).
  useEffect(() => {
    const parsed = JSON.parse(policyKey) as RetentionPolicy | null;
    if (!parsed || parsed.kind === 'forever') return;
    let live = true;
    const timer = setTimeout(() => {
      void call('storage:preview-policy', { policy: parsed })
        .then((p) => live && setPreviewOf({ key: policyKey, preview: p }))
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [policyKey, summary]);

  function changeKind(next: PolicyKind) {
    setKind(next);
    if (next === saved.kind) setAmount(policyAmount(saved));
    else if (next === 'age') setAmount('30');
    else if (next === 'size') setAmount('5');
  }

  /** Save button / Enter: asks first when the policy would delete audio now. */
  function requestSave() {
    if (!dirty || !ready || !policy || saving) return;
    if (preview && preview.meetings > 0) setConfirming(preview);
    else void save();
  }

  async function save() {
    setConfirming(null);
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await call('storage:set-policy', { policy }));
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  const unit = kind === 'age' ? 'days' : 'GB';
  return (
    <Card size="sm" data-testid="retention">
      <CardHeader>
        <CardTitle>
          <h3>Keep audio</h3>
        </CardTitle>
        <CardDescription>
          Checked when Oat starts, after each recording and every 6 hours. The meeting being
          recorded and audio from the last hour are never deleted.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            requestSave();
          }}
        >
          <Select
            items={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
            value={kind}
            onValueChange={(v) => changeKind(v as PolicyKind)}
          >
            <SelectTrigger aria-label="Retention policy" data-testid="retention-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as PolicyKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {kind !== 'forever' && (
            <div className="flex items-center gap-1.5">
              <Input
                id="retention-amount"
                className="h-8 w-20 tabular-nums"
                inputMode="decimal"
                value={amount}
                aria-invalid={policy === null}
                aria-label={kind === 'age' ? 'Days' : 'Gigabytes'}
                onChange={(event) => setAmount(event.target.value)}
              />
              <Label htmlFor="retention-amount" className="text-copy-14 text-gray-900">
                {unit}
              </Label>
            </div>
          )}
          <Button
            type="submit"
            className="ms-auto"
            disabled={!dirty || !ready || saving}
            data-testid="retention-save"
          >
            {saving && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </form>
        <p className="text-copy-14 text-gray-900" role="status" data-testid="retention-preview">
          {policy
            ? describePreview(policy, preview)
            : kind === 'age'
              ? 'Enter a whole number of days (1–3650).'
              : 'Enter a size between 0.1 and 10000 GB.'}
        </p>
        {summary.lastSweep && saved.kind !== 'forever' && (
          <p className="text-label-12 text-gray-900" data-testid="last-sweep">
            Last cleanup {formatWhen(summary.lastSweep.at)}:{' '}
            {summary.lastSweep.meetings === 0
              ? 'nothing to delete'
              : `freed ${formatBytes(summary.lastSweep.freedBytes)} (${summary.lastSweep.meetings} ${summary.lastSweep.meetings === 1 ? 'meeting' : 'meetings'})`}
            .
          </p>
        )}
        <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
          {error}
        </p>
      </CardContent>
      {confirming && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent data-testid="retention-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete the audio of {confirming.meetings}{' '}
                {confirming.meetings === 1 ? 'meeting' : 'meetings'}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This policy removes {formatBytes(confirming.bytes)} of audio from this Mac now,
                oldest first. Transcripts and notes stay. This can’t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void save()}>
                Delete audio and save
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Card>
  );
}

const SORT_LABELS: Record<StorageSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Largest first',
};

function RecordingsList({
  meetings,
  hidden,
  others,
  onChanged,
}: {
  meetings: StorageMeeting[];
  /** Older meetings beyond the list limit. */
  hidden: number;
  /** Other accounts' audio on this Mac (D-30): an aggregate, no actions. */
  others: StorageSummary['otherAccounts'];
  onChanged: () => void;
}) {
  const [sort, setSort] = useState<StorageSort>('newest');
  const [confirm, setConfirm] = useState<StorageMeeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = sortMeetings(meetings, sort);

  async function show(meeting: StorageMeeting) {
    setError(null);
    try {
      const { shown } = await call('storage:show', { meetingId: meeting.meetingId });
      if (!shown) setError('That folder no longer exists.');
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby="recordings-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="recordings-heading" className="text-label-14 text-gray-1000">
          Recordings
        </h3>
        {meetings.length > 1 && (
          <Select
            items={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
            value={sort}
            onValueChange={(v) => setSort(v as StorageSort)}
          >
            <SelectTrigger size="sm" aria-label="Sort recordings" data-testid="storage-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as StorageSort[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
        {error}
      </p>
      {sorted.length === 0 ? (
        <Empty className="border border-gray-alpha-400 px-6 py-10" data-testid="storage-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconMicrophone aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No recordings on this Mac</EmptyTitle>
            <EmptyDescription>Audio you record here shows up in this list.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul
          className="flex flex-col divide-y rounded-xl border border-gray-alpha-400"
          data-testid="storage-list"
        >
          {sorted.map((m) => (
            <li
              key={m.meetingId}
              className="flex items-center gap-3 px-3 py-2.5"
              data-testid="storage-meeting"
              data-meeting-id={m.meetingId}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className={`truncate text-label-14 ${m.title ? 'text-gray-1000' : 'text-gray-900'}`}
                >
                  {m.title || 'Untitled recording'}
                </span>
                <span className="truncate text-label-12 text-gray-900">
                  {formatWhen(m.startedAt)}
                  {/* A part being recorded has no length yet. */}
                  {m.durationMs > 0 && ` · ${formatDuration(m.durationMs)}`}
                  {m.parts > 1 && ` · ${m.parts} parts`}
                </span>
              </div>
              {m.status !== 'complete' && (
                <Badge variant={m.status === 'recording' ? 'destructive' : 'outline'}>
                  {m.status === 'recording' ? 'Recording' : 'Partial'}
                </Badge>
              )}
              <span
                className="w-16 shrink-0 text-end text-label-14 text-gray-1000 tabular-nums"
                data-testid="storage-meeting-size"
              >
                {formatBytes(m.bytes)}
              </span>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Show in Finder"
                  title="Show in Finder"
                  onClick={() => void show(m)}
                >
                  <IconFolderOpen />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-gray-900 hover:text-red-900"
                  aria-label="Delete audio"
                  title={m.deletable ? 'Delete audio' : 'Stop the recording to delete its audio'}
                  disabled={!m.deletable}
                  onClick={() => setConfirm(m)}
                >
                  <IconTrash />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="px-1 text-label-12 text-gray-900">
          {hidden} older {hidden === 1 ? 'meeting is' : 'meetings are'} not listed.
        </p>
      )}
      {others.meetings > 0 && (
        <div
          className="flex items-center gap-3 rounded-xl border border-dashed border-gray-alpha-400 px-3 py-2.5 text-gray-900"
          data-testid="storage-other-accounts"
        >
          <IconUsers className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label-14 text-gray-1000">
              Other accounts on this Mac
            </span>
            <span className="truncate text-label-12 text-gray-900">
              {others.meetings} {others.meetings === 1 ? 'meeting' : 'meetings'} · managed when they
              sign in
            </span>
          </div>
          <span className="w-16 shrink-0 text-end text-label-14 text-gray-1000 tabular-nums">
            {formatBytes(others.bytes)}
          </span>
          {/* Keeps the size column aligned with the rows' two action buttons. */}
          <span aria-hidden className="w-14 shrink-0" />
        </div>
      )}
      {confirm && (
        <DeleteDialog
          meeting={confirm}
          onClose={() => setConfirm(null)}
          onDeleted={() => {
            setConfirm(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function DeleteDialog({
  meeting,
  onClose,
  onDeleted,
}: {
  meeting: StorageMeeting;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    try {
      const { deleted, alreadyGone } = await call('storage:delete-audio', {
        meetingId: meeting.meetingId,
      });
      if (alreadyGone) {
        onDeleted(); // e.g. the retention sweep removed it meanwhile: nothing left to do
        return;
      }
      if (!deleted) {
        setError('Some files couldn’t be deleted. Details are in the app log.');
        return;
      }
      onDeleted();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent data-testid="delete-audio-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this meeting’s audio?</AlertDialogTitle>
          <AlertDialogDescription>
            {formatBytes(meeting.bytes)} of audio from “{meeting.title || 'Untitled recording'}”
            will be removed from this Mac. The transcript and your notes stay. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
          {error}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => void remove()}>
            {pending && <Spinner data-icon="inline-start" />}
            Delete audio
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
