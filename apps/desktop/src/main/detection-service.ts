/**
 * "Start notes?" (task 7.3): runs `@oat/detection`'s `Detector` (D-21 rules) in main while signed in and
 * turns its prompts — plus the calendar's "meeting starting" (~1 min before events with attendees) — into one
 * prompt on screen: a native notification and the in-app banner (`prompt:changed`).
 *
 * - `start` makes (or reopens) the event's note and starts recording it (the host's `startNotes`).
 * - `dismiss` ("Not now") and `silence` ("Don't ask for Zoom", kept per account in `<userData>/detection-<userId>.json`).
 * - At most one prompt at a time; a detected call replaces a "starting" prompt (it is the more specific one).
 *   The D-21 rate limit is the detector's and covers detected prompts only.
 *   A recording dismisses both (the detector does it for its own; D-21: no prompt while recording).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MeetingPrompt } from '@oat/core/bridge';
import type { CalendarEvent } from '@oat/core';
import { type DetectionAction, Detector, type MicAppsSource, promptTitle } from '@oat/detection';
import { z } from 'zod';

import type { Logger } from './ipc.ts';

/** A shown native notification. */
export interface ShownNotification {
  close(): void;
}

export interface NotifyRequest {
  title: string;
  body: string;
  onClick: () => void;
}

export interface StartNotesRequest {
  event: CalendarEvent | null;
  input?: 'sidecar' | 'file';
  fixture?: string;
}

export interface DetectionServiceOptions {
  /** Mic-using processes; `null` when detection is off (dev default). */
  source: MicAppsSource | null;
  /** Where silenced apps are kept: one file per account (`detection-<userId>.json`) in this folder. */
  dir: string;
  calendar: {
    readonly events: readonly CalendarEvent[];
    find(eventId: string): CalendarEvent | null;
  };
  /** Makes/reopens the note and starts recording it; resolves with the note's document id. */
  startNotes: (request: StartNotesRequest) => Promise<{ documentId: string | null }>;
  notify: (request: NotifyRequest) => ShownNotification | null;
  onPrompt: (prompt: MeetingPrompt | null) => void;
  /** A notification was clicked and its notes started: show the window. */
  onOpened?: (documentId: string | null) => void;
  now?: () => Date;
  /** How long a "starting" prompt stays up. Default 2 min (like a detected one). */
  startingTimeoutMs?: number;
  log?: Logger;
}

const SettingsSchema = z.object({ silenced: z.array(z.string().max(64)).max(200) });

export class DetectionServiceError extends Error {
  override name = 'DetectionServiceError';
}

export class DetectionService {
  readonly #o: DetectionServiceOptions;
  readonly #now: () => Date;
  #detector: Detector | null = null;
  #silenced: string[];
  #recording = false;
  #prompt: MeetingPrompt | null = null;
  #notification: ShownNotification | null = null;
  #startingTimer: ReturnType<typeof setTimeout> | undefined;
  #startingSeq = 0;
  #running = false;
  #user: string | null = null;

  constructor(options: DetectionServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#silenced = [];
  }

  get prompt(): MeetingPrompt | null {
    return this.#prompt;
  }

  get silenced(): readonly string[] {
    return this.#silenced;
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * Signed in as `userId`: start listening with that account's silenced apps (no-op when already running for
   * it; another account restarts). With detection off it only loads the settings.
   */
  async start(userId: string): Promise<void> {
    if (this.#running && this.#user === userId) return;
    if (this.#running) await this.stop();
    this.#running = true;
    this.#user = userId;
    this.#silenced = this.#readSilenced();
    const source = this.#o.source;
    if (!source) return;
    const detector = new Detector({
      source,
      now: this.#now,
      events: this.#o.calendar.events,
      silenced: this.#silenced,
      recording: this.#recording,
    });
    detector.onAction((action) => this.#onAction(action));
    detector.onError((error) => {
      this.#o.log?.warn(`detection: mic-apps watch stopped: ${error.message}; restarting in 5 s`);
      const timer = setTimeout(() => {
        if (this.#detector !== detector) return; // signed out (or restarted) meanwhile
        void detector
          .stop()
          .then(() => (this.#detector === detector ? detector.start() : undefined))
          .catch((e: unknown) => this.#o.log?.warn(`detection: restart failed: ${String(e)}`));
      }, 5_000);
      timer.unref?.();
    });
    this.#detector = detector;
    try {
      await detector.start();
      this.#o.log?.info(`detection: watching ${source.name}`);
    } catch (error) {
      this.#o.log?.warn(`detection: couldn't start (${String(error)}); no "Start notes?" prompts`);
      this.#detector = null;
    }
  }

  /** Signed out: stop listening and clear the prompt. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#user = null;
    const detector = this.#detector;
    this.#detector = null;
    this.#clear();
    await detector?.stop();
  }

  setRecording(recording: boolean): void {
    if (recording === this.#recording) return;
    this.#recording = recording;
    this.#detector?.setRecording(recording);
    if (recording && this.#prompt?.kind === 'starting') this.#clear();
  }

  setEvents(events: readonly CalendarEvent[]): void {
    this.#detector?.setEvents(events);
  }

  /** The calendar says an event with attendees is about to start. */
  startingSoon(event: CalendarEvent): void {
    if (!this.#running || this.#recording || this.#prompt) return;
    const id = `soon-${++this.#startingSeq}`;
    this.#show({
      id,
      kind: 'starting',
      title: event.title,
      eventId: event.id,
      appId: null,
      appName: null,
      at: this.#now().getTime(),
    });
    this.#startingTimer = setTimeout(
      () => {
        if (this.#prompt?.id === id) this.#clear();
      },
      this.#o.startingTimeoutMs ?? 2 * 60_000,
    );
    this.#startingTimer.unref?.();
  }

  /** The user answered the prompt (banner or notification). */
  async respond(
    promptId: string,
    action: 'start' | 'dismiss' | 'silence',
    request: Omit<StartNotesRequest, 'event'> = {},
  ): Promise<{ documentId: string | null }> {
    const prompt = this.#prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new DetectionServiceError('That prompt is no longer on screen.');
    }
    if (action === 'silence' && prompt.appId) {
      this.#silence(prompt.appId);
      // The detector dismisses its prompt for a silenced app; make sure it is gone either way.
      if (this.#prompt?.id === promptId) this.#close(prompt);
      return { documentId: null };
    }
    if (action !== 'start') {
      this.#close(prompt);
      return { documentId: null };
    }
    const event = prompt.eventId ? this.#o.calendar.find(prompt.eventId) : null;
    const result = await this.#o.startNotes({ ...request, event });
    if (this.#prompt?.id === promptId) this.#close(prompt);
    return result;
  }

  // --- internals -----------------------------------------------------------------------------------------

  #onAction(action: DetectionAction): void {
    switch (action.type) {
      case 'prompt': {
        if (this.#prompt) this.#clear(); // a "starting" prompt gives way (the detector only has one at a time)
        this.#show({
          id: action.promptId,
          kind: 'detected',
          title: promptTitle(action),
          eventId: action.event?.id ?? null,
          appId: action.app.id,
          appName: action.app.name,
          at: action.at.getTime(),
        });
        break;
      }
      case 'dismiss':
        if (this.#prompt?.id === action.promptId) this.#clear();
        break;
      case 'meetingEnded':
        // Auto-stop is 7.5; nothing to do yet.
        break;
    }
  }

  #show(prompt: MeetingPrompt): void {
    this.#prompt = prompt;
    this.#o.onPrompt(prompt);
    const body =
      prompt.kind === 'starting'
        ? 'Starts in about a minute. Start notes to record and transcribe it.'
        : prompt.eventId
          ? `${prompt.appName ?? 'A meeting app'} is using your microphone. Start notes to record and transcribe.`
          : `${prompt.appName ?? 'A meeting app'} is using your microphone.`;
    try {
      this.#notification = this.#o.notify({
        title:
          prompt.kind === 'starting'
            ? `${prompt.title || 'Your meeting'} is starting`
            : `Start notes for ${prompt.title}?`,
        body,
        onClick: () => {
          void this.respond(prompt.id, 'start').then(
            (r) => this.#o.onOpened?.(r.documentId),
            (error: unknown) => {
              this.#o.log?.warn(`detection: start from notification failed: ${String(error)}`);
              this.#o.onOpened?.(null);
            },
          );
        },
      });
    } catch (error) {
      this.#o.log?.warn(`detection: notification failed: ${String(error)}`);
    }
  }

  /** The user acted on it: the detector must not dismiss it later. */
  #close(prompt: MeetingPrompt): void {
    if (prompt.kind === 'detected') this.#detector?.promptClosed(prompt.id);
    this.#clear();
  }

  #clear(): void {
    clearTimeout(this.#startingTimer);
    this.#startingTimer = undefined;
    this.#notification?.close();
    this.#notification = null;
    if (this.#prompt === null) return;
    this.#prompt = null;
    this.#o.onPrompt(null);
  }

  #silence(appId: string): void {
    if (!this.#silenced.includes(appId)) this.#silenced = [...this.#silenced, appId];
    try {
      const file = this.#file();
      if (file) writeFileSync(file, `${JSON.stringify({ silenced: this.#silenced })}\n`);
    } catch (error) {
      this.#o.log?.warn(`detection: couldn't save silenced apps: ${String(error)}`);
    }
    this.#detector?.setSilenced(this.#silenced);
  }

  /** The signed-in account's settings file (its id made filename-safe). */
  #file(): string | null {
    if (!this.#user) return null;
    return join(this.#o.dir, `detection-${this.#user.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  #readSilenced(): string[] {
    try {
      const file = this.#file();
      return file ? SettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).silenced : [];
    } catch {
      return [];
    }
  }
}
