import type { SyncPushEntry, SyncPushResponse } from '@oat/core/sync';

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
