/**
 * Microphone + system-audio permissions for onboarding (9.2). Electron-free (the prompting calls are injected),
 * so the choices are unit-tested.
 *
 * - Status: `oat-audio permissions` (AVCaptureDevice status + TCC preflight): **never prompts**. TCC attributes
 *   the sidecar to its responsible process, the Oat app, so this is the app's own grant.
 * - Request (only from the user's "Allow" click, and only while macOS never asked — a denied permission can only
 *   be changed in System Settings): the microphone through Electron's `systemPreferences.askForMediaAccess` (the
 *   app's own prompt, which the sidecar inherits); system audio has no request API, so the sidecar opens a
 *   2-second system-audio capture, which makes macOS ask (nothing is kept: stdout is discarded). Both are human
 *   checkpoints (docs/tasks/9.2-onboarding.md); automated runs use `FixturePermissions`.
 * - `OAT_PERMISSIONS=fixture:<file.json>` (dev only): the states come from a JSON file and "Allow" answers in
 *   memory (`answers`, default granted) — no sidecar, no prompt.
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { PermissionState } from '@oat/core/bridge';
import { z } from 'zod';

/** System Settings → Privacy & Security panes (opened when the user must change a permission there). */
export const PRIVACY_URLS = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  // "Screen & System Audio Recording" (macOS 14.4+ lists "System Audio Recording Only" in the same pane).
  system_audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
} as const;

export interface AudioPermissions {
  microphone: PermissionState;
  systemAudio: PermissionState;
  systemAudioSupported: boolean;
}

export type AudioPermissionKind = 'microphone' | 'system_audio';

export interface PermissionSource {
  /** Never prompts. */
  status(): Promise<AudioPermissions>;
  /** Asks macOS (prompts). Only from the user's click; resolves once answered (or given up). */
  request(kind: AudioPermissionKind): Promise<void>;
}

const stateSchema = z.enum(['granted', 'denied', 'not_determined', 'restricted', 'unknown']);
/** Unknown words from a newer sidecar read as `unknown` rather than failing. */
const looseState = z.string().transform((s): PermissionState => {
  const parsed = stateSchema.safeParse(s);
  return parsed.success ? parsed.data : 'unknown';
});

const SidecarPermissionsSchema = z.object({
  microphone: looseState,
  system_audio: looseState,
  system_audio_supported: z.boolean().optional(),
});

/** Parses `oat-audio permissions` (one JSON object, README "Permissions & bundling"). */
export function parsePermissionsJson(text: string): AudioPermissions {
  const json = SidecarPermissionsSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? ''));
  return {
    microphone: json.microphone,
    systemAudio: json.system_audio,
    systemAudioSupported: json.system_audio_supported ?? true,
  };
}

export const UNKNOWN_PERMISSIONS: AudioPermissions = {
  microphone: 'unknown',
  systemAudio: 'unknown',
  systemAudioSupported: true,
};

/** Only a permission macOS never asked about (or can't tell) can be requested; the rest is System Settings. */
export function canRequest(state: PermissionState): boolean {
  return state === 'not_determined' || state === 'unknown';
}

export interface SidecarPermissionsOptions {
  /** The sidecar binary (undefined: not built / not bundled → every state `unknown`). */
  binary: () => string | undefined;
  /** Electron `systemPreferences.askForMediaAccess('microphone')` (prompts once). */
  askForMicrophone: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  log: { warn(message: string): void };
}

export class SidecarPermissions implements PermissionSource {
  readonly #o: SidecarPermissionsOptions;

  constructor(options: SidecarPermissionsOptions) {
    this.#o = options;
  }

  status(): Promise<AudioPermissions> {
    const binary = this.#binary();
    if (!binary) return Promise.resolve(UNKNOWN_PERMISSIONS);
    return new Promise((resolve) => {
      execFile(binary, ['permissions'], { timeout: 10_000, env: this.#o.env }, (error, stdout) => {
        if (error) {
          this.#o.log.warn(`permissions: ${error.message}`);
          return resolve(UNKNOWN_PERMISSIONS);
        }
        try {
          resolve(parsePermissionsJson(stdout));
        } catch (e) {
          this.#o.log.warn(`permissions: unreadable answer (${String(e)})`);
          resolve(UNKNOWN_PERMISSIONS);
        }
      });
    });
  }

  async request(kind: AudioPermissionKind): Promise<void> {
    if (kind === 'microphone') {
      await this.#o.askForMicrophone().catch((error: unknown) => {
        this.#o.log.warn(`permissions: microphone request failed (${String(error)})`);
      });
      return;
    }
    const binary = this.#binary();
    if (!binary) return;
    // No request API for process taps: creating one makes macOS ask. Two seconds, audio discarded.
    await new Promise<void>((resolve) => {
      const child = spawn(binary, ['capture', '--system', '--duration', '2'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: this.#o.env,
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
      child.on('error', (error) => {
        this.#o.log.warn(`permissions: system audio request failed (${error.message})`);
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #binary(): string | undefined {
    try {
      return this.#o.binary();
    } catch (error) {
      this.#o.log.warn(`permissions: ${String(error)}`);
      return undefined;
    }
  }
}

const FixtureSchema = z.object({
  microphone: stateSchema.default('not_determined'),
  system_audio: stateSchema.default('not_determined'),
  system_audio_supported: z.boolean().default(true),
  /** What macOS "answers" to a request (default `granted`). */
  answers: z
    .object({
      microphone: z.enum(['granted', 'denied']).optional(),
      system_audio: z.enum(['granted', 'denied']).optional(),
    })
    .default({}),
});

/**
 * Permission states from a JSON fixture (dev/e2e): `{ microphone, system_audio, system_audio_supported?,
 * answers?: { microphone?, system_audio? } }`. A request changes the state in memory, like macOS would — and
 * only from `not_determined`/`unknown`, also like macOS. `requests` lists what was asked (tests).
 */
export class FixturePermissions implements PermissionSource {
  #state: AudioPermissions;
  readonly #answers: Partial<Record<AudioPermissionKind, 'granted' | 'denied'>>;
  readonly requests: AudioPermissionKind[] = [];

  constructor(fixture: unknown) {
    const f = FixtureSchema.parse(fixture);
    this.#state = {
      microphone: f.microphone,
      systemAudio: f.system_audio,
      systemAudioSupported: f.system_audio_supported,
    };
    this.#answers = f.answers;
  }

  static fromFile(file: string): FixturePermissions {
    return new FixturePermissions(JSON.parse(readFileSync(file, 'utf8')));
  }

  status(): Promise<AudioPermissions> {
    return Promise.resolve({ ...this.#state });
  }

  request(kind: AudioPermissionKind): Promise<void> {
    this.requests.push(kind);
    const key = kind === 'microphone' ? 'microphone' : 'systemAudio';
    if (canRequest(this.#state[key])) {
      this.#state = { ...this.#state, [key]: this.#answers[kind] ?? 'granted' };
    }
    return Promise.resolve();
  }
}
