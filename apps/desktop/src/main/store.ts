/**
 * Main-owned live state shared by every window (auth status, recording status, active meeting). Small and
 * volatile: built fresh on every launch. Each change bumps `seq` by one and is pushed to all windows as a
 * full snapshot (`state:changed`); renderers ignore anything older than what they have
 * (`renderer/src/main-state.ts`), so a late `state:get` reply can't roll them back.
 */
import {
  initialMainState,
  type MainState,
  type MainStateSnapshot,
  mainStateSchema,
} from '@oat/core/bridge';

export type StateListener = (snapshot: MainStateSnapshot) => void;

export class MainStore {
  #seq = 0;
  #state: MainState;
  #listeners = new Set<StateListener>();

  constructor(initial: MainState = initialMainState()) {
    this.#state = mainStateSchema.parse(initial);
  }

  snapshot(): MainStateSnapshot {
    return { seq: this.#seq, state: this.#state };
  }

  get state(): MainState {
    return this.#state;
  }

  /**
   * Applies an immutable update. Returning the same object is a no-op (no seq bump, no broadcast). The
   * result is schema-checked, so a bad update throws here instead of reaching a window.
   */
  update(recipe: (state: MainState) => MainState): MainStateSnapshot {
    const next = recipe(this.#state);
    if (next === this.#state) return this.snapshot();
    this.#state = Object.freeze(mainStateSchema.parse(next));
    this.#seq += 1;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
