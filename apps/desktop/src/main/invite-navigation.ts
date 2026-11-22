import { parseInviteLink } from '@oat/core/invite-link';

export class InviteNavigation {
  #token: string | null = null;
  constructor(private readonly notify: () => void) {}
  open(raw: unknown): boolean {
    const token = parseInviteLink(raw);
    if (!token) return false;
    this.#token = token;
    this.notify();
    return true;
  }
  get route() {
    return this.#token ? { view: 'invite' as const, token: this.#token } : null;
  }
  clear() {
    this.#token = null;
  }
}
