import type { PlaybackPart } from '@oat/meeting-ui/playback';

export type AudioSource = 'mic' | 'system';
export interface AudioMetadata {
  version: 1;
  meetingId: string;
  durationMs: number;
  finalized: boolean;
  parts: PlaybackPart[];
}
export interface AudioDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AudioDirectory>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getFile(): Promise<Blob>;
    createWritable(): Promise<AudioWriter>;
  }>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
interface AudioWriter {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}
const safeId = (id: string, kind = 'meeting') => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${kind} id`);
  return id;
};

export class AudioStore {
  constructor(
    readonly userId: string,
    readonly root: () => Promise<AudioDirectory> = () => navigator.storage.getDirectory(),
  ) {
    safeId(userId, 'user');
  }
  async accountDirectory(create = false) {
    return (
      await (await this.root()).getDirectoryHandle('oat-audio', { create })
    ).getDirectoryHandle(this.userId, { create });
  }
  async directory(id: string, create = false) {
    return (await this.accountDirectory(create)).getDirectoryHandle(safeId(id), {
      create,
    });
  }
  async load(id: string): Promise<AudioMetadata | null> {
    try {
      const dir = await this.directory(id);
      const metadata = JSON.parse(
        await (await (await dir.getFileHandle('metadata.json')).getFile()).text(),
      ) as AudioMetadata;
      if (metadata.version !== 1 || metadata.meetingId !== id || !Array.isArray(metadata.parts))
        return null;
      return metadata;
    } catch (error) {
      if (
        error instanceof Error &&
        ['NotFoundError', 'SecurityError', 'NotSupportedError'].includes(error.name)
      )
        return null;
      throw error;
    }
  }
  async save(metadata: AudioMetadata) {
    const dir = await this.directory(metadata.meetingId, true);
    const writer = await (
      await dir.getFileHandle('metadata.json', { create: true })
    ).createWritable();
    try {
      await writer.write(JSON.stringify(metadata));
    } finally {
      await writer.close();
    }
  }
  async writer(id: string, part: number, source: AudioSource) {
    const dir = await this.directory(id, true);
    return (await dir.getFileHandle(`${part}-${source}.webm`, { create: true })).createWritable();
  }
  async blob(id: string, part: number, source: AudioSource) {
    const dir = await this.directory(id);
    return (await dir.getFileHandle(`${part}-${source}.webm`)).getFile();
  }
  async delete(id: string) {
    const root = await this.accountDirectory();
    await root.removeEntry(safeId(id), { recursive: true });
  }
}
interface ArchiveRecorder {
  recorder?: MediaRecorder;
  writer: AudioWriter;
  writes: Promise<void>;
  stopped?: Promise<void>;
}

export class BrowserAudioArchive {
  readonly metadata: AudioMetadata;
  #recorders: ArchiveRecorder[] = [];
  #failed = false;
  #loaded = false;
  constructor(
    readonly store: AudioStore,
    meetingId: string,
    readonly notice: (message: string) => void,
  ) {
    this.metadata = { version: 1, meetingId, durationMs: 0, finalized: false, parts: [] };
  }
  async restore() {
    if (!this.#loaded) {
      this.#loaded = true;
      try {
        const existing = await this.store.load(this.metadata.meetingId);
        if (existing) Object.assign(this.metadata, existing);
      } catch {
        this.#fail();
      }
    }
    return Math.max(this.metadata.durationMs, 0, ...this.metadata.parts.map((part) => part.endMs));
  }
  #fail() {
    if (this.#failed) return;
    this.#failed = true;
    for (const entry of this.#recorders) {
      if (entry.recorder?.state === 'recording')
        try {
          entry.recorder.stop();
        } catch {
          /* Capture can already have ended. */
        }
    }
    this.notice('Audio is not being saved in this browser. Transcript recording continues.');
  }
  async start(startMs: number, streams: { source: AudioSource; stream: MediaStream }[]) {
    await this.restore();
    if (this.#failed) return;
    try {
      if (
        typeof MediaRecorder === 'undefined' ||
        !MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      )
        throw new Error('Opus recording is unavailable');
      const part = Math.max(0, ...this.metadata.parts.map((part) => part.part)) + 1;
      this.metadata.finalized = false;
      const sources = streams.filter((s) =>
        s.stream.getAudioTracks().some((t) => t.readyState === 'live'),
      );
      this.metadata.parts.push({
        part,
        startMs,
        endMs: startMs,
        sources: sources.map((s) => s.source),
        partial: true,
      });
      await this.store.save(this.metadata);
      for (const { source, stream } of sources) {
        const writer = await this.store.writer(this.metadata.meetingId, part, source);
        const entry: ArchiveRecorder = { writer, writes: Promise.resolve() };
        this.#recorders.push(entry);
        const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), {
          mimeType: 'audio/webm;codecs=opus',
        });
        entry.recorder = recorder;
        const stopped = new Promise<void>((resolve) =>
          recorder.addEventListener('stop', () => resolve(), { once: true }),
        );
        recorder.ondataavailable = ({ data }) => {
          if (data.size && !this.#failed)
            entry.writes = entry.writes.then(() => writer.write(data)).catch(() => this.#fail());
        };
        recorder.onerror = () => this.#fail();
        recorder.start(1000);
        entry.stopped = stopped;
      }
    } catch {
      this.#fail();
    }
  }
  async end(endMs: number, finalized: boolean) {
    const entries = this.#recorders.splice(0);
    await Promise.all(
      entries.map(async (entry) => {
        try {
          if (entry.recorder && entry.recorder.state !== 'inactive') entry.recorder.stop();
          await entry.stopped;
          await entry.writes;
        } catch {
          this.#fail();
        } finally {
          try {
            await entry.writer.close();
          } catch {
            this.#fail();
          }
        }
      }),
    );
    const part = entries.length ? this.metadata.parts.at(-1) : undefined;
    if (part) {
      part.endMs = Math.max(part.startMs, endMs);
      part.partial = this.#failed;
    }
    this.metadata.durationMs = Math.max(this.metadata.durationMs, endMs);
    this.metadata.finalized = finalized;
    if (!this.#failed)
      try {
        await this.store.save(this.metadata);
      } catch {
        this.#fail();
      }
  }
}
