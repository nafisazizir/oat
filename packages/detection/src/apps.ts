/**
 * Meeting-app data (D-21): which processes holding the mic count as a meeting app, and how helper processes
 * map to the app the user sees. Pure data + one resolver; change the lists here, not in the reducer.
 *
 * Bundle ids are public facts about each app. The big ones (Zoom, Teams, Slack, FaceTime, the browsers) are
 * well known; the long tail should be confirmed at the human checkpoint (`oat-audio mic-apps watch` during a
 * real call) and corrected here.
 */
import { z } from 'zod';

/** What the sidecar reports per process (`oat-audio mic-apps`, PROTOCOL.md → "Mic apps"). */
export const MicAppProcessSchema = z.object({
  pid: z.number().int(),
  /** The process's own bundle id (a helper's, for browser / Electron helpers). */
  bundleId: z.string().nullable(),
  /** Bundle id of the outermost `.app` containing the executable, when different from `bundleId`. */
  appBundleId: z.string().nullable().default(null),
});
export type MicAppProcess = z.infer<typeof MicAppProcessSchema>;
export type MicAppProcessInput = z.input<typeof MicAppProcessSchema>;

/**
 * `native` apps prompt on their own; `browser`s only when a calendar event overlaps (D-21's deliberate
 * difference: browsers use the mic for many non-meeting things).
 */
export type MeetingAppKind = 'native' | 'browser';
/** How the UI talks about a session in this app ("Zoom call", "Slack huddle"). */
export type MeetingNoun = 'call' | 'meeting' | 'huddle';

export interface MeetingApp {
  /** Stable id, used by the per-app silence list. */
  id: string;
  name: string;
  kind: MeetingAppKind;
  noun: MeetingNoun;
  /** Main bundle ids of the app (any release channel). */
  bundleIds: readonly string[];
  /**
   * The app must hold the mic this long before it counts as a call (unless a calendar event overlaps).
   * Messaging apps record voice notes / clips that take the mic for many seconds; 0 for dedicated call apps
   * (the 2 s prompt delay still applies).
   */
  minHoldMs: number;
}

/** `minHoldMs` for messaging apps (voice notes, Slack clips). */
export const MESSAGING_MIN_HOLD_MS = 15_000;

const app = (
  id: string,
  name: string,
  kind: MeetingAppKind,
  noun: MeetingNoun,
  bundleIds: string[],
  minHoldMs = 0,
): MeetingApp => ({ id, name, kind, noun, bundleIds, minHoldMs });
const M = MESSAGING_MIN_HOLD_MS;

/** The allowlist. Anything not listed (voice memos, dictation, Oat itself, …) is ignored. */
export const MEETING_APPS: readonly MeetingApp[] = [
  // Native meeting clients
  app('zoom', 'Zoom', 'native', 'meeting', ['us.zoom.xos']),
  app('teams', 'Microsoft Teams', 'native', 'meeting', [
    'com.microsoft.teams2',
    'com.microsoft.teams',
  ]),
  app('slack', 'Slack', 'native', 'huddle', ['com.tinyspeck.slackmacgap'], M),
  app('facetime', 'FaceTime', 'native', 'call', ['com.apple.FaceTime']),
  app('webex', 'Webex', 'native', 'meeting', ['Cisco-Systems.Spark', 'com.webex.meetingmanager']),
  app('discord', 'Discord', 'native', 'call', ['com.hnc.Discord'], M),
  app('around', 'Around', 'native', 'call', ['co.teamport.around']),
  app('tuple', 'Tuple', 'native', 'call', ['app.tuple.app']),
  app('whatsapp', 'WhatsApp', 'native', 'call', ['net.whatsapp.WhatsApp', 'desktop.WhatsApp'], M),
  app('skype', 'Skype', 'native', 'call', ['com.skype.skype'], M),
  app('signal', 'Signal', 'native', 'call', ['org.whispersystems.signal-desktop'], M),
  app(
    'telegram',
    'Telegram',
    'native',
    'call',
    ['ru.keepcoder.Telegram', 'org.telegram.desktop'],
    M,
  ),
  app('gather', 'Gather', 'native', 'meeting', ['com.gather.Gather']),
  // Browsers (web meetings: Meet, Zoom/Teams web, …)
  app('chrome', 'Google Chrome', 'browser', 'meeting', [
    'com.google.Chrome',
    'com.google.Chrome.beta',
    'com.google.Chrome.dev',
    'com.google.Chrome.canary',
  ]),
  app('arc', 'Arc', 'browser', 'meeting', ['company.thebrowser.Browser']),
  app('dia', 'Dia', 'browser', 'meeting', ['company.thebrowser.dia']),
  app('safari', 'Safari', 'browser', 'meeting', [
    'com.apple.Safari',
    'com.apple.SafariTechnologyPreview',
  ]),
  app('edge', 'Microsoft Edge', 'browser', 'meeting', [
    'com.microsoft.edgemac',
    'com.microsoft.edgemac.Beta',
    'com.microsoft.edgemac.Dev',
    'com.microsoft.edgemac.Canary',
  ]),
  app('firefox', 'Firefox', 'browser', 'meeting', [
    'org.mozilla.firefox',
    'org.mozilla.firefoxdeveloperedition',
    'org.mozilla.nightly',
  ]),
  app('brave', 'Brave', 'browser', 'meeting', ['com.brave.Browser']),
  app('vivaldi', 'Vivaldi', 'browser', 'meeting', ['com.vivaldi.Vivaldi']),
  app('opera', 'Opera', 'browser', 'meeting', ['com.operasoftware.Opera']),
  app('chromium', 'Chromium', 'browser', 'meeting', ['org.chromium.Chromium']),
];

/**
 * Helper processes that hold the mic on behalf of an app but are not inside its bundle (so `appBundleId`
 * can't name the app) and don't share its bundle-id prefix. Exact bundle id → the app's main bundle id.
 */
export const HELPER_PARENTS: Readonly<Record<string, string>> = {
  // Safari (and WebKit generally) captures in the WebKit GPU / content processes.
  'com.apple.WebKit.GPU': 'com.apple.Safari',
  'com.apple.WebKit.WebContent': 'com.apple.Safari',
  // FaceTime audio runs in the AV conferencing daemon.
  'com.apple.avconferenced': 'com.apple.FaceTime',
  // Firefox content / media processes.
  'org.mozilla.plugincontainer': 'org.mozilla.firefox',
};

/**
 * Vendor prefixes whose processes all belong to one app (Zoom ships several differently named helpers).
 * Checked after exact ids, the helper map and the `<main id>.` prefix rule.
 */
export const HELPER_PREFIXES: readonly (readonly [prefix: string, parent: string])[] = [
  ['us.zoom.', 'us.zoom.xos'],
];

const byBundleId = new Map<string, MeetingApp>();
for (const a of MEETING_APPS) for (const id of a.bundleIds) byBundleId.set(id, a);
const appsById = new Map(MEETING_APPS.map((a) => [a.id, a]));

export function meetingAppById(id: string): MeetingApp | null {
  return appsById.get(id) ?? null;
}

/** The meeting app a bundle id belongs to, or null. Exact → helper map → `<main>.…` → vendor prefix. */
export function meetingAppForBundleId(bundleId: string | null | undefined): MeetingApp | null {
  if (!bundleId) return null;
  const exact = byBundleId.get(bundleId);
  if (exact) return exact;
  const parent = HELPER_PARENTS[bundleId];
  if (parent) return byBundleId.get(parent) ?? null;
  // `com.google.Chrome.helper`, `com.microsoft.teams2.modulehost`, `com.hnc.Discord.helper`, …: the longest
  // main id that is a dotted prefix wins (`com.google.Chrome.beta.helper` → Chrome, PWAs → their browser).
  let best: { len: number; app: MeetingApp } | null = null;
  for (const [id, a] of byBundleId) {
    if (bundleId.startsWith(`${id}.`) && (!best || id.length > best.len))
      best = { len: id.length, app: a };
  }
  if (best) return best.app;
  for (const [prefix, main] of HELPER_PREFIXES)
    if (bundleId.startsWith(prefix)) return byBundleId.get(main) ?? null;
  return null;
}

/**
 * The meeting app a mic-using process belongs to, or null (not a meeting app). The containing app (the
 * outermost `.app` the user sees) is tried first — so a native app's embedded web helper with a
 * browser-like id still counts as that app — then the process's own bundle id (helpers outside any `.app`,
 * e.g. the WebKit GPU process).
 */
export function resolveMeetingApp(process: MicAppProcessInput): MeetingApp | null {
  return meetingAppForBundleId(process.appBundleId) ?? meetingAppForBundleId(process.bundleId);
}
