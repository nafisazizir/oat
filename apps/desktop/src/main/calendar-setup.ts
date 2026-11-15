/**
 * Where the Mac's calendar events and the mic-apps signal come from (7.3), per `DesktopConfig`:
 * - packaged: EventKit and `mic-apps watch` through the bundled sidecar;
 * - dev: off unless `OAT_CALENDAR` / `OAT_DETECTION` ask for the sidecar or a fixture (e2e uses fixtures, in
 *   process: no sidecar binary, no EventKit, no Core Audio).
 *
 * Safety: nothing here prompts. The one prompting call (`calendar request-access`) runs only from
 * `requestAccess`, which only the user's "Connect" click reaches.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { locateSidecarBinary } from '@oat/audio/node';
import { FixtureCalendarSource, parseEventLines, parseEvents } from '@oat/calendar';
import { SidecarCalendarSource } from '@oat/calendar/node';
import { type CalendarAccessStatus, CalendarAccessStatusSchema } from '@oat/core';
import type { MicAppsSource } from '@oat/detection';
import { SidecarMicAppsSource } from '@oat/detection/node';
import { z } from 'zod';

import type { LocalCalendar } from './calendar-service.ts';
import type { CalendarConfig, DetectionConfig } from './config.ts';
import type { Logger } from './ipc.ts';
import { ReplayMicAppsSource } from './replay-mic-apps.ts';
import { sidecarLocateOptions } from './sidecar.ts';

/** System Settings → Privacy & Security → Calendars. */
export const CALENDAR_PRIVACY_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';

export interface CalendarSetupOptions {
  calendar: CalendarConfig;
  detection: DetectionConfig;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
  openExternal: (url: string) => void;
  log: Logger;
}

const FixtureFileSchema = z.union([
  z.array(z.unknown()),
  z.object({ access: CalendarAccessStatusSchema.optional(), events: z.array(z.unknown()) }),
]);

/**
 * A calendar fixture file: a JSON array of normalised events, `{ access?, events }` (to start without access,
 * e.g. `not_determined`), or JSON lines (`*.jsonl`, as `oat-audio calendar events` prints).
 */
export function readCalendarFixture(file: string): FixtureCalendarSource {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) return new FixtureCalendarSource({ events: parseEventLines(text) });
  const json = FixtureFileSchema.parse(JSON.parse(text));
  const events = Array.isArray(json) ? json : json.events;
  const access: CalendarAccessStatus = Array.isArray(json)
    ? 'full_access'
    : (json.access ?? 'full_access');
  return new FixtureCalendarSource({ events: parseEvents(events), access });
}

export function createCalendarSetup(o: CalendarSetupOptions) {
  const locate = () =>
    locateSidecarBinary(
      sidecarLocateOptions({
        isPackaged: o.isPackaged,
        env: o.env,
        ...(o.resourcesPath ? { resourcesPath: o.resourcesPath } : {}),
      }),
    );

  function localCalendar(): LocalCalendar | null {
    const c = o.calendar;
    if (c.kind === 'off') return null;
    if (c.kind === 'fixture') {
      try {
        const source = readCalendarFixture(c.file);
        // "Connect" on a fixture grants access in memory: the flow is testable without macOS prompts.
        return { source, requestAccess: async () => source.setAccess('full_access') };
      } catch (error) {
        o.log.error(`calendar: fixture ${c.file} unreadable`, error);
        return null;
      }
    }
    let binary: string | undefined;
    try {
      binary = locate();
    } catch (error) {
      o.log.warn(`calendar: ${String(error)}`);
    }
    if (!binary) {
      o.log.warn('calendar: oat-audio sidecar not found; no Mac calendar');
      return null;
    }
    const sidecarBinary = binary;
    return {
      source: new SidecarCalendarSource({ binary: sidecarBinary, env: o.env }),
      requestAccess: () =>
        new Promise<void>((resolve) => {
          // Prompts (macOS asks the user): only ever from the user's "Connect" click. Waits for the answer.
          execFile(
            sidecarBinary,
            ['calendar', 'request-access'],
            { timeout: 5 * 60_000 },
            (error) => {
              if (error) o.log.warn(`calendar: request-access: ${error.message}`);
              resolve();
            },
          );
        }),
      openSettings: () => o.openExternal(CALENDAR_PRIVACY_URL),
    };
  }

  function micApps(): MicAppsSource | null {
    const d = o.detection;
    if (d.kind === 'off') return null;
    if (d.kind === 'fixture') {
      try {
        return ReplayMicAppsSource.fromFile(d.file);
      } catch (error) {
        o.log.error(`detection: fixture ${d.file} unreadable`, error);
        return null;
      }
    }
    let binary: string | undefined;
    try {
      binary = locate();
    } catch (error) {
      o.log.warn(`detection: ${String(error)}`);
    }
    if (!binary) {
      o.log.warn('detection: oat-audio sidecar not found; no meeting detection');
      return null;
    }
    return new SidecarMicAppsSource({ binary, env: o.env });
  }

  return { localCalendar, micApps };
}
