/**
 * Crash recovery at launch (task 2.7; 2.8's `recoverRecordings`, which nothing called before): every audio
 * row still `recording` belongs to a session the app never finished (it crashed or was killed). Before any
 * new recording can start, those files are repaired in place (torn tail cut, EOS added) and their rows
 * finalised (`partial`, or `complete` if the file was in fact closed), for every account on this Mac (repair
 * never removes audio). Each affected meeting gets a `RecordingRecovery` row; `TranscriptBackfill` applies it
 * once that account's database is open (closes the meeting, queues the untranscribed tail) and the meeting's
 * transcript panel says "Oat quit unexpectedly — recording saved up to 10:42".
 */
import { type AudioRecordingStore, recoverRecordings } from '@oat/audio/node';
import { type RecordingRecovery, type TranscriptJobStore, uuidv7 } from '@oat/local-store';

import type { Logger } from './ipc.ts';

export async function recoverCrashedRecordings(options: {
  audio: AudioRecordingStore;
  jobs: TranscriptJobStore;
  log: Logger;
  now?: () => number;
  /** Rows of a recording that is running right now (never touched). */
  skipIds?: readonly string[];
}): Promise<RecordingRecovery[]> {
  const now = (options.now ?? Date.now)();
  const repaired = await recoverRecordings(options.audio, {
    ...(options.skipIds ? { skipIds: options.skipIds } : {}),
  });
  const byMeeting = new Map<string, typeof repaired>();
  for (const r of repaired) {
    const list = byMeeting.get(r.recording.meetingId) ?? [];
    list.push(r);
    byMeeting.set(r.recording.meetingId, list);
  }
  const out: RecordingRecovery[] = [];
  for (const [meetingId, rows] of byMeeting) {
    const parts = rows.map(({ recording: r }) => ({
      source: r.source,
      part: r.part,
      offsetMs: r.offsetMs,
      endMs: r.offsetMs + r.durationMs,
      startedAt: r.startedAt,
    }));
    const recovery: RecordingRecovery = {
      id: uuidv7(),
      meetingId,
      userId: rows.find((r) => r.recording.userId)?.recording.userId ?? null,
      recoveredAt: now,
      savedUntil: Math.round(
        Math.max(...rows.map(({ recording: r }) => r.startedAt + r.durationMs)),
      ),
      parts,
      appliedAt: null,
    };
    const summary = rows
      .map(
        ({ recording: r, repair }) =>
          `${r.source}.${r.part} ${r.status} ${Math.round(r.durationMs / 1000)} s (cut ${repair.truncatedBytes} B${repair.holes ? `, ${repair.holes} holes` : ''})`,
      )
      .join(', ');
    options.log.warn(`recovery: meeting ${meetingId} was being recorded when Oat quit: ${summary}`);
    try {
      options.jobs.insertRecovery(recovery);
      out.push(recovery);
    } catch (error) {
      options.log.error(`recovery: could not record the recovery of ${meetingId}`, error);
    }
  }
  return out;
}
