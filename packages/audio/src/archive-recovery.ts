/**
 * Crash recovery for the local audio archive (task 2.8, SPEC §6). Run once at app start, before any
 * recording begins: every `audio_recording` row still `recording` (the app died mid-recording) gets its file
 * repaired and its row finalised. `partial` rows were repaired already and are never touched again.
 *
 * Repair never discards a valid page: a corrupt page in the middle is skipped by resynchronising on the next
 * valid page (the region stays in the file and decodes as silence; standard demuxers resync the same way).
 * Only a torn tail that holds no further valid page is truncated, after the last page that ends a packet,
 * and that page is marked end-of-stream (CRC rewritten) so standard players see a finished stream.
 */
import { open, readFile } from 'node:fs/promises';

import type {
  AudioRecording,
  AudioRecordingStatus,
  AudioRecordingStore,
} from './audio-recording.ts';
import { OGG_EOS, OGG_NO_GRANULE, parseOggPages, setPageFlags, type OggPage } from './ogg.ts';
import { OPUS_GRANULE_RATE } from './ogg-opus.ts';
import { inspectOggOpus } from './opus-reader.ts';

export interface OpusRepairResult {
  readonly path: string;
  /** The file was there at all. */
  readonly existed: boolean;
  /** Valid Opus headers were found (otherwise the file holds no recoverable audio and is left as is). */
  readonly playable: boolean;
  readonly bytesBefore: number;
  readonly bytes: number;
  /** Bytes cut from a torn tail. */
  readonly truncatedBytes: number;
  /** The last page had to be marked end-of-stream. */
  readonly eosAdded: boolean;
  /** The file was already a finished stream (EOS, nothing to cut). */
  readonly wasComplete: boolean;
  /** Corrupt regions between valid pages that were kept in place and skipped (their audio is lost). */
  readonly holes: number;
  readonly holeBytes: number;
  readonly durationMs: number;
}

/** Repairs an Ogg Opus file in place (see module docs). Idempotent; never throws for a damaged file. */
export async function repairOpusFile(path: string): Promise<OpusRepairResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return result(path, { existed: false });
  }
  let stream;
  try {
    stream = inspectOggOpus(bytes);
  } catch {
    return result(path, { existed: true, bytesBefore: bytes.length, bytes: bytes.length });
  }
  // Keep pages through the last one that completes a packet (header pages have granule 0, so with no
  // finished audio page the headers alone remain, as a valid empty stream).
  const parsed = parseOggPages(bytes);
  const pages = parsed.pages.filter((p) => p.serial === stream.serial);
  let lastIndex = pages.length - 1;
  while (lastIndex >= 0 && (pages[lastIndex] as OggPage).granule === OGG_NO_GRANULE) lastIndex--;
  const lastPage = pages[lastIndex] as OggPage; // ≥ the OpusTags page: inspectOggOpus succeeded
  const keepEnd = endOf(lastPage);
  const wasComplete = stream.complete && keepEnd === bytes.length;

  let eosAdded = false;
  if (!wasComplete) {
    const fh = await open(path, 'r+');
    try {
      if (keepEnd < bytes.length) await fh.truncate(keepEnd);
      if (!(lastPage.flags & OGG_EOS)) {
        const page = Uint8Array.from(bytes.subarray(lastPage.offset, endOf(lastPage)));
        setPageFlags(page, lastPage.flags | OGG_EOS);
        await fh.write(page, 0, page.length, lastPage.offset);
        eosAdded = true;
      }
      await fh.datasync();
    } finally {
      await fh.close();
    }
  }
  const audio = stream.pages.some((p) => p.offset === lastPage.offset);
  const granule = audio ? lastPage.granule : 0;
  return result(path, {
    existed: true,
    playable: true,
    bytesBefore: bytes.length,
    bytes: keepEnd,
    eosAdded,
    wasComplete,
    holes: parsed.holes.length,
    holeBytes: parsed.holes.reduce((n, h) => n + h.size, 0),
    durationMs: (Math.max(0, granule - stream.head.preSkip) / OPUS_GRANULE_RATE) * 1000,
  });
}

export interface RecoveredRecording {
  readonly recording: AudioRecording;
  readonly previousStatus: AudioRecordingStatus;
  readonly repair: OpusRepairResult;
}

export interface RecoverRecordingsOptions {
  /** Rows to leave alone (e.g. a recording that is already running again). */
  skipIds?: readonly string[];
}

/**
 * Repairs the file of every `recording` row (left behind by a crash) and updates the row: a file that turns
 * out to be a clean, finished stream (closed, but the row update was lost) → `complete`; anything repaired,
 * truncated or with corrupt regions → `partial`. Duration and size come from the repaired file. Idempotent:
 * finished rows (`complete`/`partial`/`failed`/`deleted`) are left alone, so an old partial file is never
 * re-cut.
 */
export async function recoverRecordings(
  store: AudioRecordingStore,
  options: RecoverRecordingsOptions = {},
): Promise<RecoveredRecording[]> {
  const skip = new Set(options.skipIds);
  const rows = await store.list({ status: 'recording' });
  const recovered: RecoveredRecording[] = [];
  for (const row of rows) {
    if (skip.has(row.id)) continue;
    const repair = await repairOpusFile(row.path);
    const status: AudioRecordingStatus =
      repair.wasComplete && repair.holes === 0 ? 'complete' : 'partial';
    const recording = await store.update(row.id, {
      status,
      durationMs: Math.round(repair.durationMs),
      bytes: repair.bytes,
    });
    recovered.push({ recording, previousStatus: row.status, repair });
  }
  return recovered;
}

function endOf(page: OggPage): number {
  return page.offset + page.size;
}

function result(
  path: string,
  fields: Partial<Omit<OpusRepairResult, 'path'>> & { existed: boolean },
): OpusRepairResult {
  const bytesBefore = fields.bytesBefore ?? 0;
  const bytes = fields.bytes ?? 0;
  return {
    path,
    playable: false,
    bytesBefore,
    bytes,
    truncatedBytes: bytesBefore - bytes,
    eosAdded: false,
    wasComplete: false,
    holes: 0,
    holeBytes: 0,
    durationMs: 0,
    ...fields,
  };
}
