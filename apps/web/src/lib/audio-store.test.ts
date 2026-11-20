import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioStore,
  BrowserAudioArchive,
  type AudioDirectory,
  type AudioMetadata,
} from './audio-store';

class Directory implements AudioDirectory {
  dirs = new Map<string, Directory>();
  files = new Map<string, Blob>();
  full = false;
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory> {
    if (!this.dirs.has(name)) {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      this.dirs.set(name, new Directory());
    }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      this.files.set(name, new Blob());
    }
    return {
      getFile: async () => this.files.get(name)!,
      createWritable: async () => {
        const chunks: BlobPart[] = [];
        return {
          write: async (data: Blob | string) => {
            if (this.full) throw new DOMException('Full', 'QuotaExceededError');
            chunks.push(data);
          },
          close: async () => {
            this.files.set(name, new Blob(chunks));
          },
        };
      },
    };
  }
  async removeEntry(name: string) {
    this.dirs.delete(name);
    this.files.delete(name);
  }
}
afterEach(() => vi.unstubAllGlobals());
const metadata: AudioMetadata = {
  version: 1,
  meetingId: 'meeting',
  durationMs: 8000,
  finalized: true,
  parts: [
    { part: 1, startMs: 0, endMs: 3000, sources: ['mic', 'system'], partial: false },
    { part: 2, startMs: 4000, endMs: 8000, sources: ['mic'], partial: false },
  ],
};
describe('OPFS audio store', () => {
  it('isolates accounts with the same meeting id and ignores legacy unscoped audio', async () => {
    const root = new Directory();
    const alice = new AudioStore('alice', async () => root);
    const bob = new AudioStore('bob', async () => root);
    await alice.save(metadata);
    const writer = await alice.writer('meeting', 1, 'mic');
    await writer.write('private audio');
    await writer.close();
    const legacy = await (
      await root.getDirectoryHandle('oat-audio')
    ).getDirectoryHandle('meeting', { create: true });
    legacy.files.set('metadata.json', new Blob([JSON.stringify(metadata)]));
    expect(await bob.load('meeting')).toBeNull();
    await expect(bob.blob('meeting', 1, 'mic')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(bob.delete('meeting')).rejects.toMatchObject({ name: 'NotFoundError' });
    await bob.save(metadata);
    await bob.delete('meeting');
    expect(await alice.load('meeting')).toEqual(metadata);
    expect(await (await alice.blob('meeting', 1, 'mic')).text()).toBe('private audio');
    expect(() => new AudioStore('../alice')).toThrow('Invalid user id');
  });
  it('finalizes asynchronous recorder chunks and creates a new clock-aligned part on resume', async () => {
    const recorders: Recorder[] = [];
    class Recorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start = vi.fn(() => {
        this.state = 'recording';
      });
      constructor() {
        super();
        recorders.push(this);
      }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(['opus-chunk']) });
          this.dispatchEvent(new Event('stop'));
        });
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('MediaStream', class {});
    const store = new AudioStore('alice', async () => root);
    const root = new Directory();
    const notice = vi.fn();
    const archive = new BrowserAudioArchive(store, 'meeting', notice);
    const streams = [
      {
        source: 'mic' as const,
        stream: { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream,
      },
    ];
    await archive.start(0, streams);
    recorders[0]!.stop();
    await archive.end(2000, false);
    await archive.start(2000, streams);
    await archive.end(4000, true);
    expect(recorders[0]!.start).toHaveBeenCalledWith(1000);
    expect(await store.load('meeting')).toMatchObject({
      finalized: true,
      durationMs: 4000,
      parts: [
        { part: 1, startMs: 0, endMs: 2000, sources: ['mic'], partial: false },
        { part: 2, startMs: 2000, endMs: 4000, sources: ['mic'], partial: false },
      ],
    });
    expect(await (await store.blob('meeting', 2, 'mic')).text()).toBe('opus-chunk');
    expect(notice).not.toHaveBeenCalled();
    const restarted = new BrowserAudioArchive(store, 'meeting', notice);
    expect(await restarted.restore()).toBe(4000);
    await restarted.start(5000, streams);
    await restarted.end(7000, true);
    expect((await store.load('meeting'))?.parts).toHaveLength(3);
    expect((await store.load('meeting'))?.parts[2]).toMatchObject({
      part: 3,
      startMs: 5000,
      endMs: 7000,
    });
    expect(await (await store.blob('meeting', 1, 'mic')).text()).toBe('opus-chunk');
    expect(await (await store.blob('meeting', 3, 'mic')).text()).toBe('opus-chunk');
  });

  it('writes chunks incrementally per part/source, round-trips clock metadata and deletes only local audio', async () => {
    const root = new Directory();
    const store = new AudioStore('alice', async () => root);
    await store.save(metadata);
    const writer = await store.writer('meeting', 1, 'mic');
    await writer.write(new Blob(['first']));
    await writer.write(new Blob(['second']));
    await writer.close();
    expect(await (await store.blob('meeting', 1, 'mic')).text()).toBe('firstsecond');
    expect(await store.load('meeting')).toEqual(metadata);
    expect(((await store.directory('meeting')) as Directory).files.has('1-mic.webm')).toBe(true);
    await store.delete('meeting');
    expect(await store.load('meeting')).toBeNull();
  });
  it('handles absent/empty archives and rejects invalid meeting paths', async () => {
    const store = new AudioStore('alice', async () => new Directory());
    expect(await store.load('missing')).toBeNull();
    await expect(store.directory('../outside', true)).rejects.toThrow('Invalid meeting id');
  });
  it('surfaces quota failures and degrades unavailable OPFS to a recording notice', async () => {
    const root = new Directory();
    const store = new AudioStore('alice', async () => root);
    ((await store.directory('meeting', true)) as Directory).full = true;
    await expect(store.save(metadata)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    const notice = vi.fn();
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    const archive = new BrowserAudioArchive(
      new AudioStore('alice', async () => {
        throw new Error('Unavailable');
      }),
      'meeting',
      notice,
    );
    await archive.start(0, []);
    await archive.end(2000, true);
    expect(notice).toHaveBeenCalledWith(
      'Audio is not being saved in this browser. Transcript recording continues.',
    );
  });
});
