/**
 * Whether each account finished first-run setup on this Mac (9.2), in `<userData>/onboarding.json`:
 * `{ "version": 1, "accounts": { "<userId>": { "completedAt": <ms>, "guide": true|false } } }`.
 * Per account per Mac like the other device settings (D-30): another account signing in here gets its own setup.
 * A missing or unreadable file means "never set up" (the walkthrough shows again: harmless).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { OnboardingState } from '@oat/core/bridge';
import { z } from 'zod';

const AccountSchema = z.object({
  completedAt: z.number().nullable().default(null),
  /** The first-meeting guide card is still to be shown. */
  guide: z.boolean().default(false),
});
const FileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), AccountSchema),
});
type Account = z.infer<typeof AccountSchema>;

export interface OnboardingStoreOptions {
  file: string;
  /** `off` (e2e default, `OAT_ONBOARDING=off`): never shows the walkthrough or the guide by itself. */
  mode: 'auto' | 'off';
  now?: () => number;
  log: { warn(message: string): void };
}

export class OnboardingStore {
  readonly #o: OnboardingStoreOptions;
  #accounts: Record<string, Account>;

  constructor(options: OnboardingStoreOptions) {
    this.#o = options;
    this.#accounts = this.#read();
  }

  state(userId: string | null): OnboardingState {
    if (!userId) return { needed: false, guide: false };
    const account = this.#accounts[userId];
    if (this.#o.mode === 'off') return { needed: false, guide: account?.guide ?? false };
    return { needed: !account?.completedAt, guide: account?.guide ?? false };
  }

  /** Finished (or the dialog was closed): never shown by itself again for this account; `guide` shows the card. */
  complete(userId: string, guide: boolean): OnboardingState {
    const now = (this.#o.now ?? Date.now)();
    this.#accounts[userId] = { completedAt: this.#accounts[userId]?.completedAt ?? now, guide };
    this.#write();
    return this.state(userId);
  }

  dismissGuide(userId: string): OnboardingState {
    const account = this.#accounts[userId];
    this.#accounts[userId] = { completedAt: account?.completedAt ?? null, guide: false };
    this.#write();
    return this.state(userId);
  }

  #read(): Record<string, Account> {
    let text: string;
    try {
      text = readFileSync(this.#o.file, 'utf8');
    } catch {
      return {};
    }
    try {
      return FileSchema.parse(JSON.parse(text)).accounts;
    } catch (error) {
      this.#o.log.warn(`onboarding: ${this.#o.file} unreadable, starting over (${String(error)})`);
      return {};
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#o.file), { recursive: true });
      const tmp = `${this.#o.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, accounts: this.#accounts }, null, 2)}\n`);
      renameSync(tmp, this.#o.file);
    } catch (error) {
      // Kept in memory for this launch; the walkthrough may show again next time.
      this.#o.log.warn(`onboarding: could not save (${String(error)})`);
    }
  }
}
