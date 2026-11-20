import type { SyncPushEntry, SyncPushResponse } from '@oat/core/sync';

export const hasSyncBacklog = (since: number | null, now: number) =>
  since !== null && now - since > 5000;

type Entry = SyncPushEntry extends infer E
  ? E extends { version: number }
    ? Omit<E, 'version'>
    : never
  : never;

export class RecordingQueue {
  #version = 0;
  #pending: SyncPushEntry[] = [];
  #flight: Promise<void> | undefined;
  #error: string | null = null;
  readonly #push: (entries: SyncPushEntry[]) => Promise<SyncPushResponse>;
  readonly #changed: (pending: number, error: string | null) => void;

  constructor(
    push: (entries: SyncPushEntry[]) => Promise<SyncPushResponse>,
    changed: (pending: number, error: string | null) => void,
  ) {
    this.#push = push;
    this.#changed = changed;
  }
  get pending() {
    return this.#pending.length;
  }
  get entries() {
    return this.#pending.slice();
  }
  restore(entries: SyncPushEntry[]) {
    this.#pending = entries.slice();
    this.#version = Math.max(this.#version, 0, ...entries.map((entry) => entry.version));
    this.#changed(this.pending, this.#error);
  }
  clear() {
    this.#pending = [];
    this.#error = null;
    this.#changed(0, null);
  }
  enqueue(entry: Entry) {
    this.#pending.push({ ...entry, version: ++this.#version } as SyncPushEntry);
    this.#changed(this.pending, this.#error);
  }
  flush(): Promise<void> {
    if (this.#flight) return this.#flight;
    this.#flight = this.#drain().finally(() => {
      this.#flight = undefined;
    });
    return this.#flight;
  }
  async #drain() {
    while (this.pending) {
      const batch = this.#pending.slice(0, 100);
      try {
        const response = await this.#push(batch);
        const ok = new Set(response.results.filter((r) => r.status === 'ok').map((r) => r.version));
        this.#pending = this.#pending.filter((e) => !ok.has(e.version));
        const rejected = response.results.find((r) => r.status === 'rejected');
        if (rejected?.status === 'rejected') throw new Error(rejected.message);
        if (batch.some((e) => !ok.has(e.version)))
          throw new Error('Transcript sync was not acknowledged.');
        this.#error = null;
        this.#changed(this.pending, null);
      } catch (error) {
        this.#error = error instanceof Error ? error.message : 'Transcript sync failed.';
        this.#changed(this.pending, this.#error);
        return;
      }
    }
  }
}

const outboxPrefix = (userId: string) => `oat-recording-pending:${encodeURIComponent(userId)}:`;
export function savePendingRecording(
  userId: string,
  entries: SyncPushEntry[],
  storage = globalThis.localStorage,
) {
  if (!entries.length) return;
  if (!storage)
    throw new Error('Pending transcript could not be saved locally. Retry before signing out.');
  storage.setItem(`${outboxPrefix(userId)}${crypto.randomUUID()}`, JSON.stringify(entries));
}
export async function retryPendingRecordings(
  userId: string,
  push: (entries: SyncPushEntry[]) => Promise<SyncPushResponse>,
  storage = globalThis.localStorage,
) {
  if (!storage) return;
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
    (key): key is string => key !== null && key.startsWith(outboxPrefix(userId)),
  );
  for (const key of keys) {
    const entries: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(entries))
      throw new Error('Saved transcript recovery data could not be read.');
    const queue = new RecordingQueue(push, () => {});
    queue.restore(entries as SyncPushEntry[]);
    await queue.flush();
    if (queue.pending) storage.setItem(key, JSON.stringify(queue.entries));
    else storage.removeItem(key);
  }
}
