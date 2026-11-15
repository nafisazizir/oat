/**
 * The live transcript as a set of segments keyed by their stable id (D-19), shared by the main process
 * (`TranscriptBuffer`, the source of truth for `transcript:get`) and every window (the panel's store).
 *
 * Merge rules (`@oat/stt` `SttSegment` contract):
 * - an interim upserts its id (the newest interim for an id wins);
 * - a final replaces the interim with its id and is never downgraded by a late interim;
 * - a final with empty text is a **retraction**: the segment with that id is removed.
 *
 * Pure TS, no Electron or DOM.
 */
import type { LiveSegment } from '@oat/core/bridge';

export type { LiveSegment };

/** A final with no text: "drop the interim with this id". */
export function isRetraction(segment: LiveSegment): boolean {
  return segment.isFinal && segment.text === '';
}

/** Time order; ties (same start) by source then id, so every window shows the same order. */
export function compareSegments(a: LiveSegment, b: LiveSegment): number {
  return (
    a.startMs - b.startMs ||
    (a.source === b.source ? 0 : a.source === 'mic' ? -1 : 1) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export class TranscriptStore {
  readonly #byId = new Map<string, LiveSegment>();
  #ordered: readonly LiveSegment[] | null = [];

  /** Applies upserts/retractions in order. Returns whether anything visible changed. */
  apply(segments: readonly LiveSegment[]): boolean {
    let changed = false;
    for (const segment of segments) {
      const current = this.#byId.get(segment.id);
      if (isRetraction(segment)) {
        if (current) {
          this.#byId.delete(segment.id);
          changed = true;
        }
        continue;
      }
      // A final is final: an out-of-order interim for the same id must not bring back provisional text.
      if (current?.isFinal && !segment.isFinal) continue;
      if (current && sameSegment(current, segment)) continue;
      this.#byId.set(segment.id, segment);
      changed = true;
    }
    if (changed) this.#ordered = null;
    return changed;
  }

  /** Every live segment in time order. The array is cached and replaced (never mutated) on change. */
  get segments(): readonly LiveSegment[] {
    this.#ordered ??= [...this.#byId.values()].sort(compareSegments);
    return this.#ordered;
  }

  get size(): number {
    return this.#byId.size;
  }

  get(id: string): LiveSegment | undefined {
    return this.#byId.get(id);
  }

  clear(): void {
    if (this.#byId.size === 0) return;
    this.#byId.clear();
    this.#ordered = [];
  }
}

function sameSegment(a: LiveSegment, b: LiveSegment): boolean {
  return (
    a.text === b.text &&
    a.isFinal === b.isFinal &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.source === b.source
  );
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
