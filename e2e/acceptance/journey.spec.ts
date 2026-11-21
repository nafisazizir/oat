/**
 * Task 9.4: the v1 acceptance journey (SPEC §9), end to end, the way one user and a teammate use Oat:
 *
 *  1. sign up on the web (magic link → Mailpit), connect Notion (mock) and turn on "Auto-send meeting notes";
 *  2. open the built desktop app (cold start measured) and sign it in through the already signed-in browser;
 *  3. "New meeting note" records the `standup-short` fixture (FileSource in real time, never real capture):
 *     the live transcript shows me/them (first-segment latency measured), I jot a note, the fixture ends;
 *  4. it syncs; the post-meeting pipeline (agents server) enhances it, indexes it and sends it to Notion;
 *     the enhanced note reaches the desktop;
 *  5. share by link → a stranger reads it; a teammate is invited to a team workspace, signs up, accepts and
 *     reads it through the link;
 *  6. the note's assistant answers with citations (a transcript chip jumps to that moment);
 *  7. search finds it on the web (⌘K) and on the desktop (local FTS);
 *  8. playback on the desktop: clicking a transcript line seeks there;
 *  9. (3.9) the owner switches the desktop to the team workspace and records a meeting there; shared with the
 *     workspace on the web, the teammate finds and opens it on the web — no public link.
 *
 * Every external service is a mock (D-11): the compose stack's STT mock, apps/web's `e2e/web-server.ts`
 * in-process mocks for the LLM and Notion. Timings vs SPEC §8 go to `test-results/acceptance-timings.json`
 * (and `docs/tasks/evidence/9.4/` with screenshots when `E2E_SCREENSHOTS=1`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMailpit, extractFirstLink, uniqueAddress, waitFor } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import {
  deliverDeepLink,
  evidence,
  home,
  launchApp,
  openTranscript,
  scaled,
  syncStatus,
  waitForSignInUrl,
  writeEvidence,
} from '../../apps/desktop/e2e/helpers';
import { openMagicLink, signInWithMagicLink } from '../../apps/web/e2e/auth-helpers';
import { hydrationAware } from '../../apps/web/e2e/fixtures';
import { mocksUrlFile } from '../../apps/web/e2e/paths';

test.skip(process.platform !== 'darwin', 'the acceptance journey drives the macOS desktop app');

const FIXTURE = 'standup-short';
const TASK = '9.4';
const truth = JSON.parse(
  readFileSync(
    fileURLToPath(new URL(`../../fixtures/audio/${FIXTURE}.segments.json`, import.meta.url)),
    'utf8',
  ),
) as { source: 'mic' | 'system'; startMs: number; endMs: number; text: string }[];
const TIMINGS_FILE = fileURLToPath(
  new URL('./test-results/acceptance-timings.json', import.meta.url),
);

const mailpit = createMailpit();
const run = Math.random().toString(36).slice(2, 7);
const TITLE = `Billing standup ${run}`;
const NOTE = 'Ping finance about the new tax rates';
const TEAM = `Acceptance team ${run}`;
/** 3.9: the meeting recorded into the team workspace from the desktop. */
const TASK_39 = '3.9';
const TEAM_TITLE = `Team retro ${run}`;
const TEAM_NOTE = 'Rotate the on-call schedule';

/** Measured durations (ms) and facts, printed as they come and written at the end. */
const timings: Record<string, unknown> = {};
function record(name: string, value: unknown) {
  timings[name] = typeof value === 'number' ? Math.round(value) : value;
  console.log(`[acceptance] ${name}: ${JSON.stringify(timings[name])}`);
}

/** Desktop IPC through the preload bridge (the renderer's `window.oat`). */
const invoke = <T>(p: Page, channel: string, payload?: unknown) =>
  p.evaluate(
    async ([c, body]) => {
      const oat = (
        window as unknown as {
          oat: {
            invoke(
              c: string,
              b?: unknown,
            ): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
          };
        }
      ).oat;
      const r = body === undefined ? await oat.invoke(c) : await oat.invoke(c, body);
      if (!r.ok) throw new Error(r.error!.message);
      return r.value;
    },
    [channel, payload] as const,
  ) as Promise<T>;

/** Console errors and uncaught page errors of a web page (asserted empty at the end). */
const consoleErrors: string[] = [];
function watchConsole(page: Page, who: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${who}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${who}: ${e.message}`));
}

/** The newest email to `to` whose subject matches (an invite and a magic link can arrive close together). */
const mailTo = (to: string, subject: RegExp) =>
  waitFor(
    async () => {
      const latest = await mailpit.latestFor(to);
      return latest && subject.test(latest.Subject) ? latest : undefined;
    },
    { timeout: scaled(15_000), message: `no "${subject.source}" email to ${to}` },
  );

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);

/** Share of the expected words found in order in `words` (LCS / expected length). */
function wordRecall(words: string[], expected: string[]): number {
  const dp = Array.from({ length: words.length + 1 }, () =>
    new Array<number>(expected.length + 1).fill(0),
  );
  for (let i = 1; i <= words.length; i++) {
    for (let j = 1; j <= expected.length; j++) {
      dp[i]![j] =
        words[i - 1] === expected[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[words.length]![expected.length]! / expected.length;
}

interface Segment {
  id: string;
  source: 'mic' | 'system';
  startMs: number;
  endMs: number;
  text: string;
}
interface PipelineRun {
  status: string;
  steps: { step: string; outcome: string; reason?: string; at: string }[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

let userDataDir: string | undefined;
let app: ElectronApplication | undefined;

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('v1 acceptance: sign up → record → enhance → share → teammate → chat → Notion → search → playback', async ({
  browser,
  baseURL,
}) => {
  const journeyStart = Date.now();
  const webUrl = baseURL!;
  const origin = { origin: webUrl };
  // `next dev` compiles a route on its first request: do the desktop's hot ones now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: origin });
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: origin });

  const ownerEmail = uniqueAddress('acceptance-owner');
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = hydrationAware(await ownerContext.newPage());
  watchConsole(web, 'owner');
  // The dev-only Next.js indicator sits over the assistant's send button in the bottom-right corner.
  await web.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(style);
    });
  });

  await test.step('sign up on the web', async () => {
    const t0 = Date.now();
    await web.goto(`${webUrl}/sign-in`);
    await signInWithMagicLink(web, ownerEmail, webUrl);
    await expect(web).toHaveURL(/\/home$/);
    await expect(web.getByTestId('workspace-switcher')).toBeVisible();
    record('signUpMs', Date.now() - t0);
  });

  await test.step('connect Notion (mock) and turn on auto-send after meetings', async () => {
    await web.goto(`${webUrl}/settings/integrations`);
    const after = web.locator('[data-testid="after-meetings-card"]:visible');
    await expect(after.getByTestId('pipeline-autoEnhance')).toBeChecked();
    const card = web.locator('[data-testid="notion-card"]:visible');
    await card.getByRole('button', { name: 'Connect Notion' }).click();
    await web.waitForURL(/\/settings\/integrations\?connected=notion$/);
    await card.getByRole('button', { name: 'Choose page or database' }).click();
    await web.getByRole('combobox', { name: 'Search Notion pages and databases' }).fill('meeting');
    await web.getByTestId('notion-target-option').filter({ hasText: 'Meeting notes' }).click();
    await expect(card.getByTestId('notion-target')).toContainText('Meeting notes');
    const autoSend = card.getByTestId('pipeline-autoSendToNotion');
    const saved = web.waitForResponse(
      (r) => r.url().endsWith('/api/settings/pipeline') && r.request().method() === 'PUT',
    );
    await autoSend.click();
    expect((await saved).status()).toBe(200);
    await expect(autoSend).toBeChecked();
    await evidence(web, 'web-integrations', TASK);
  });

  let page!: Page;
  await test.step('desktop: cold start, sign in through the browser', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'oat-acceptance-'));
    ({ app, page } = await launchApp(userDataDir, webUrl, {
      OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
      // No calendar, no meeting detection: nothing real on this Mac is touched (EventKit, mic apps).
      OAT_CALENDAR: 'off',
      OAT_DETECTION: 'off',
      // 7.5: a stopped meeting ends at once (no post-stop grace period); auto-stop has nothing to act on
      // without detection or a calendar event, and in-person recordings never stop by themselves.
      OAT_END_GRACE_MS: '0',
    }));
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 820),
    );
    const info = await invoke<{ coldStartMs: number | null }>(page, 'app:info');
    record('coldStartMs', info.coldStartMs);
    expect(info.coldStartMs, 'SPEC §8: cold start < 2 s').not.toBeNull();
    expect(info.coldStartMs!).toBeLessThan(2000);

    // "Sign in with your browser": the browser the user just signed up in continues to the app.
    await page.getByRole('button', { name: 'Sign in with your browser' }).click();
    const signInUrl = await waitForSignInUrl(app!);
    await web.goto(signInUrl);
    await expect(web.getByTestId('desktop-email')).toContainText(ownerEmail);
    const codeResponse = web.waitForResponse(
      (r) => r.url().endsWith('/api/auth/desktop/code') && r.request().method() === 'POST',
    );
    await web.getByRole('button', { name: 'Continue to the app' }).click();
    const { redirectUrl } = (await (await codeResponse).json()) as { redirectUrl: string };
    await deliverDeepLink(app!, redirectUrl);
    await expect(page.getByTestId('signed-in-email')).toHaveText(ownerEmail);
    await expect(home(page)).toContainText('No notes yet');
  });

  let meetingId!: string;
  let documentId!: string;
  let stoppedAt!: number;
  await test.step('record the fixture meeting: live transcript, notes, it ends', async () => {
    // When each voice's first segment (and first interim) becomes visible.
    await page.evaluate(() => {
      const seen: Record<string, number> = {};
      (window as unknown as { __seen: Record<string, number> }).__seen = seen;
      const check = () => {
        for (const el of document.querySelectorAll<HTMLElement>(
          '[data-testid=transcript-segment]',
        )) {
          const source = el.dataset.source!;
          seen[source] ??= Date.now();
          if (el.dataset.final === 'false') seen[`${source}:interim`] ??= Date.now();
        }
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    });

    await page.getByTestId('new-meeting').click();
    // The note opens; its transcript is closed until asked for (ui-calm), so open it at once: the latency
    // below is measured to the first *visible* segment.
    await openTranscript(page);
    await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
    const started = await invoke<{ meetingId: string; startedAt: number }>(page, 'recording:get');
    meetingId = started.meetingId;
    documentId = (await page
      .getByTestId('meeting-list-item')
      .first()
      .getAttribute('data-document-id'))!;
    expect(documentId).toBeTruthy();

    // Jot a note and name the meeting while it transcribes.
    const title = page.getByTestId('note-title');
    await expect(title).toHaveValue(/^Meeting, /);
    await page.getByRole('textbox', { name: 'My notes' }).click();
    await page.keyboard.type(NOTE);
    await title.fill(TITLE);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

    const panel = page.getByTestId('transcript-panel');
    await expect(
      panel.locator('[data-testid=transcript-segment][data-source=mic]').first(),
    ).toBeVisible({ timeout: scaled(20_000) });
    await expect(
      panel.locator('[data-testid=transcript-segment][data-source=system]').first(),
    ).toBeVisible({ timeout: scaled(20_000) });
    await expect(page.getByTestId('stt-status')).toHaveText('Live');
    const seen = await page.evaluate(
      () => (window as unknown as { __seen: Record<string, number> }).__seen,
    );
    const latency = {
      mic: seen.mic! - (started.startedAt + truth.find((t) => t.source === 'mic')!.startMs),
      system:
        seen.system! - (started.startedAt + truth.find((t) => t.source === 'system')!.startMs),
      interimFirst: { mic: seen['mic:interim'] === seen.mic, system: !!seen['system:interim'] },
    };
    record('firstSegmentLatencyMs', latency);
    expect(latency.mic, 'SPEC §8: interim < 1.5 s (me)').toBeLessThan(1500);
    expect(latency.system, 'SPEC §8: interim < 1.5 s (them)').toBeLessThan(1500);
    await evidence(page, 'desktop-live', TASK);

    // The fixture (~33 s of audio) ends by itself: the recording stops and the meeting ends.
    await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
      timeout: scaled(60_000),
    });
    stoppedAt = Date.now();
    record('recordingMs', stoppedAt - started.startedAt);
    await expect(page.getByRole('button', { name: 'Continue recording' })).toBeVisible();
    // Playable on its own once the archive files are closed (9.4 finding 0: it used to stay "recording").
    await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused', {
      timeout: scaled(15_000),
    });
    record('playableAfterStopMs', Date.now() - stoppedAt);

    // The transcript is the fixture's ground truth, per voice.
    const { segments } = await invoke<{ segments: Segment[] }>(page, 'meeting:transcript', {
      documentId,
    });
    const recall: Record<string, number> = {};
    for (const source of ['mic', 'system'] as const) {
      const heard = normalize(
        segments
          .filter((s) => s.source === source)
          .map((s) => s.text)
          .join(' '),
      );
      const expected = normalize(
        truth
          .filter((t) => t.source === source)
          .map((t) => t.text)
          .join(' '),
      );
      recall[source] = Math.round(wordRecall(heard, expected) * 1000) / 1000;
      expect(recall[source], `${source} transcript vs ground truth`).toBeGreaterThanOrEqual(0.95);
    }
    record('transcriptWordRecall', recall);
    await evidence(page, 'desktop-stopped', TASK);
  });

  await test.step('sync: the note, notes and transcript reach the server', async () => {
    const t0 = Date.now();
    await expect
      .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
        timeout: scaled(30_000),
      })
      .toBe(0);
    await expect(syncStatus(page)).toHaveAccessibleName('All changes synced');
    record('syncDrainMs', Date.now() - t0);
  });

  let run!: PipelineRun;
  await test.step('post-meeting pipeline: enhance → index → Notion', async () => {
    const pipelineUrl = `${webUrl}/api/documents/${documentId}/pipeline`;
    run = await waitFor(
      async () => {
        const res = await web.request.get(pipelineUrl);
        const body = (await res.json()) as { run: PipelineRun | null };
        if (body.run?.status === 'failed')
          throw new Error(`pipeline failed: ${JSON.stringify(body)}`);
        return body.run?.status === 'completed' ? body.run : undefined;
      },
      { timeout: scaled(120_000), interval: 250, message: 'pipeline completed' },
    );
    const done = Date.now();
    expect(run.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['enhance', 'ran'],
      ['index', 'ran'],
      ['notion', 'ran'],
    ]);
    const at = (step: string) => Date.parse(run.steps.find((s) => s.step === step)!.at);
    const runStart = Date.parse(run.startedAt ?? run.createdAt);
    record('pipeline', {
      stopToCompletedMs: done - stoppedAt,
      queuedMs: runStart - Date.parse(run.createdAt),
      enhanceMs: at('enhance') - runStart,
      indexMs: at('index') - at('enhance'),
      notionMs: at('notion') - at('index'),
      runMs: Date.parse(run.finishedAt!) - Date.parse(run.createdAt),
    });

    // The note on the web: enhanced (AI blocks), my line kept, the header says so.
    await web.goto(`${webUrl}/d/${documentId}`);
    await expect(web.getByTestId('document-title')).toHaveValue(TITLE);
    await expect(web.getByTestId('pipeline-status')).toHaveText('Post-meeting: done');
    const detail = (await (
      await web.request.get(`${webUrl}/api/documents/${documentId}`)
    ).json()) as {
      contentJson: unknown;
    };
    const content = JSON.stringify(detail.contentJson);
    expect(content).toContain('"origin":"ai"');
    expect(content).toContain(NOTE);
    await expect(
      (await openTranscript(web)).getByTestId('transcript-segment').first(),
    ).toBeVisible();
    await evidence(web, 'web-enhanced', TASK);

    // …and on the desktop, through sync.
    await expect
      .poll(
        async () => {
          await invoke(page, 'sync:now');
          const local = await invoke<{ contentJson: unknown }>(page, 'meeting:get', { documentId });
          return JSON.stringify(local.contentJson).includes('"origin":"ai"');
        },
        { timeout: scaled(30_000), message: 'enhanced note synced to the desktop' },
      )
      .toBe(true);
    await evidence(page, 'desktop-enhanced', TASK);
  });

  await test.step('Notion (mock) received the page', async () => {
    await web.reload();
    // The Notion link and button are in the note's "More actions" menu (ui-calm; as in web pipeline.spec).
    await web.getByTestId('document-more').click();
    const link = web.getByTestId('notion-link');
    await expect(link).toContainText('In Notion');
    const href = (await link.getAttribute('href'))!;
    await web.keyboard.press('Escape');
    await expect(link).toBeHidden();
    const mocksUrl = readFileSync(mocksUrlFile(new URL(webUrl).port), 'utf8').trim();
    const log = (await (await fetch(`${mocksUrl}/_requests?provider=notion`)).json()) as {
      requests: { method: string; path: string; body: string | null }[];
    };
    const created = log.requests.filter(
      (r) => r.method === 'POST' && r.path === '/notion/v1/pages' && !!r.body?.includes(TITLE),
    );
    expect(created).toHaveLength(1);
    // The page as Notion shows it (the mock's HTML view): title and the note's content.
    const view = await (await fetch(href)).text();
    expect(view).toContain(TITLE);
    expect(view).toContain(NOTE);
  });

  let shareLink!: string;
  await test.step('share via link: a stranger reads it, read-only', async () => {
    await web.getByTestId('share-button').click();
    const dialog = web.getByTestId('share-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('Anyone with the link', { exact: true }).click();
    shareLink = await dialog.getByTestId('share-link').inputValue();
    expect(shareLink).toMatch(/\/share\/[A-Za-z0-9_-]{22,}$/);
    await evidence(web, 'web-share-dialog', TASK);
    await web.keyboard.press('Escape');
    await expect(web.getByTestId('visibility-badge')).toHaveText('Only you + link');

    const strangerContext = await browser.newContext();
    const stranger = hydrationAware(await strangerContext.newPage());
    watchConsole(stranger, 'stranger');
    const res = await stranger.goto(shareLink);
    expect(res?.status()).toBe(200);
    const view = stranger.getByTestId('shared-document');
    await expect(view.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(view).toContainText(NOTE);
    await expect(stranger.locator('[contenteditable="true"], textarea')).toHaveCount(0);
    await evidence(stranger, 'share-view', TASK);
    await strangerContext.close();
  });

  await test.step('assistant: answers about the meeting with citations', async () => {
    await web.goto(`${webUrl}/d/${documentId}`);
    await web.getByTestId('assistant-toggle').click();
    const panel = web.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    const t0 = Date.now();
    const input = web.getByTestId('chat-input');
    await input.fill('What is the billing migration waiting on before we ship it?');
    await input.press('Enter');
    const answer = web.locator('[data-testid="chat-message"][data-role="assistant"]').last();
    await expect(answer.getByTestId('chat-answer')).toHaveText(/\w{3,}/, {
      timeout: scaled(60_000),
    });
    const segChip = answer.locator('[data-testid="citation-chip"][data-kind="seg"]').first();
    await expect(segChip).toHaveAttribute('data-state', 'ready', { timeout: scaled(30_000) });
    record('chatAnswerMs', Date.now() - t0);
    record('chatCitations', await answer.getByTestId('citation-chip').count());
    await evidence(web, 'web-assistant', TASK);
    // A transcript citation opens the transcript at that moment.
    await segChip.click();
    await expect(web).toHaveURL(new RegExp(`/d/${documentId}\\?t=\\d+&seg=`));
    const focused = web.getByTestId('transcript-panel').locator('[data-focused]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toBeInViewport();
  });

  await test.step('search finds it: web ⌘K and the desktop’s local index', async () => {
    await web.goto(`${webUrl}/home`);
    const t0 = Date.now();
    await web.keyboard.press('ControlOrMeta+k');
    const palette = web.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await web.keyboard.type('staging');
    const transcriptHit = palette
      .getByTestId('search-result-transcript')
      .filter({ hasText: TITLE });
    await expect(transcriptHit.first()).toBeVisible();
    record('webSearchMs', Date.now() - t0);
    await evidence(web, 'web-search', TASK);
    await transcriptHit.first().click();
    await expect(web).toHaveURL(new RegExp(`/d/${documentId}\\?t=\\d+`));

    // The desktop's search is a dialog behind the sidebar's Search button (ui-calm-shell).
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const local = page.getByLabel('Search notes and transcripts on this Mac');
    await local.fill('staging');
    await expect(page.getByTestId('local-search-results')).toContainText(TITLE);
    await evidence(page, 'desktop-search', TASK);
    await local.fill('');
    await page.keyboard.press('Escape');
    await expect(local).toBeHidden();
  });

  let teammate!: Page;
  let teammateContext!: Awaited<ReturnType<typeof browser.newContext>>;
  await test.step('a teammate is invited, signs up, accepts, and reads the shared note', async () => {
    // A team workspace with the teammate in it (5.1/5.2).
    await web.goto(`${webUrl}/home`);
    await web.getByTestId('workspace-switcher').click();
    await web.getByRole('menuitem', { name: 'Create workspace' }).click();
    const create = web.getByTestId('create-workspace-dialog');
    await create.getByLabel('Name').fill(TEAM);
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(create).toBeHidden();
    await expect(web.getByTestId('workspace-switcher')).toContainText(TEAM);

    const teammateEmail = uniqueAddress('acceptance-teammate');
    await web.goto(`${webUrl}/settings/workspace/members`);
    await web.getByRole('button', { name: 'Invite people' }).click();
    const invite = web.getByTestId('invite-dialog');
    await invite.getByLabel('Email').fill(teammateEmail);
    await invite.getByRole('button', { name: 'Send invite' }).click();
    await expect(invite).toBeHidden();
    const inviteLink = extractFirstLink(await mailTo(teammateEmail, /invited you to .* on Oat$/))!;
    expect(inviteLink).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);

    teammateContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    teammate = hydrationAware(await teammateContext.newPage());
    watchConsole(teammate, 'teammate');
    await teammate.goto(inviteLink);
    await expect(teammate.getByRole('heading', { level: 1, name: `Join ${TEAM}` })).toBeVisible();
    await teammate.getByRole('link', { name: 'Sign in to accept' }).click();
    await teammate.getByLabel('Work email').fill(teammateEmail);
    await teammate.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(teammate.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await openMagicLink(
      teammate,
      extractFirstLink(await mailTo(teammateEmail, /^Sign in to Oat$/))!,
    );
    await teammate.getByRole('button', { name: 'Accept invitation' }).click();
    await teammate.waitForURL(/\/home$/, { waitUntil: 'load' });
    await expect(teammate.getByTestId('workspace-switcher')).toContainText(TEAM);

    // This meeting note lives in the owner's first workspace (documents never move between
    // workspaces, D-18): the teammate reads it through the link. (3.9: the next meeting is recorded into
    // the team workspace — see the last step.)
    const res = await teammate.goto(shareLink);
    expect(res?.status()).toBe(200);
    const view = teammate.getByTestId('shared-document');
    await expect(view.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(view).toContainText(NOTE);
    await evidence(teammate, 'teammate-share-view', TASK);
    // …and nothing more: the note itself stays the owner's.
    expect((await teammate.request.get(`${webUrl}/api/documents/${documentId}`)).status()).not.toBe(
      200,
    );
  });

  await test.step('playback on the desktop: a transcript line seeks the audio there', async () => {
    await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
    const info = await invoke<{ status: string; durationMs: number }>(page, 'playback:open', {
      meetingId,
    });
    expect(info.status).toBe('available');
    await page
      .getByTestId('playback-audio')
      .evaluate((el) => ((el as HTMLAudioElement).muted = true));
    const { segments } = await invoke<{ segments: Segment[] }>(page, 'meeting:transcript', {
      documentId,
    });
    const target = segments.filter((s) => s.startMs > 5_000)[1]!;
    const line = page.locator(`[data-segment-id="${target.id}"]`);
    await line.scrollIntoViewIfNeeded();
    await line.locator('p').click();
    const audio = () =>
      page.getByTestId('playback-audio').evaluate((el) => {
        const a = el as HTMLAudioElement;
        return { ms: a.currentTime * 1000, seeking: a.seeking };
      });
    await expect
      .poll(async () => {
        const a = await audio();
        return !a.seeking && Math.abs(a.ms - target.startMs) <= 100;
      })
      .toBe(true);
    await expect(line).toHaveAttribute('data-active', 'true');
    record('playbackSeek', {
      startMs: target.startMs,
      errorMs: Math.round((await audio()).ms - target.startMs),
      durationMs: info.durationMs,
    });
    await evidence(page, 'desktop-playback', TASK);
  });

  await test.step('3.9: the owner records into the team workspace on the desktop; the teammate reads it on the web', async () => {
    // The team workspace (and my role there) reached the desktop by sync; switch to it.
    await expect
      .poll(
        async () =>
          (
            await invoke<{ workspaces: { name: string }[] }>(page, 'workspaces:list')
          ).workspaces.map((w) => w.name),
        { timeout: scaled(20_000) },
      )
      .toContain(TEAM);
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menu').getByTestId('workspace-option').filter({ hasText: TEAM }).click();
    await expect(page.getByTestId('workspace-switcher')).toContainText(TEAM);
    await expect(page.getByTestId('workspace-hint')).toHaveCount(0);

    // "New meeting note" records into the team workspace; a few seconds of the fixture are enough.
    await page.getByTestId('new-meeting').click();
    await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
    const { meetingId: teamMeetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
    await expect(page.getByTestId('note-workspace')).toHaveText(TEAM);
    const item = page.getByTestId('meeting-list-item');
    await expect(item).toHaveCount(1); // the list shows the team workspace's notes only
    const teamDocumentId = (await item.first().getAttribute('data-document-id'))!;
    await page.getByTestId('note-title').fill(TEAM_TITLE);
    await page.getByRole('textbox', { name: 'My notes' }).click();
    await page.keyboard.type(TEAM_NOTE);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    await expect(
      (await openTranscript(page)).locator('[data-testid=transcript-segment]').first(),
    ).toBeVisible({ timeout: scaled(20_000) });
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
      timeout: scaled(30_000),
    });
    expect(
      (
        await invoke<{ meetingId: string | null }>(page, 'meeting:get', {
          documentId: teamDocumentId,
        })
      ).meetingId,
    ).toBe(teamMeetingId);
    await evidence(page, 'desktop-team-recording', TASK_39);
    await expect
      .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
        timeout: scaled(30_000),
      })
      .toBe(0);

    // On the server it is in the team workspace, private (D-25 default): the teammate can't open it yet.
    const teamDocUrl = `${webUrl}/api/documents/${teamDocumentId}`;
    expect((await teammate.request.get(teamDocUrl)).status()).not.toBe(200);

    // The owner shares it with the workspace on the web (not a public link).
    await web.goto(`${webUrl}/d/${teamDocumentId}`);
    await expect(web.getByTestId('visibility-badge')).toHaveText('Private');
    await web.getByTestId('share-button').click();
    const dialog = web.getByTestId('share-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('Workspace', { exact: true }).click();
    await expect(dialog.getByTestId('share-link')).toHaveCount(0);
    await web.keyboard.press('Escape');
    await expect(web.getByTestId('visibility-badge')).toContainText(TEAM);

    // The teammate finds it in the team workspace on the web and opens it — no share link involved.
    await teammate.goto(`${webUrl}/home`);
    await expect(teammate.getByTestId('workspace-switcher')).toContainText(TEAM);
    const entry = teammate.getByTestId('tree-item').filter({ hasText: TEAM_TITLE });
    await expect(entry.first()).toBeVisible({ timeout: scaled(15_000) });
    await entry.first().click();
    await expect(teammate).toHaveURL(new RegExp(`/d/${teamDocumentId}`));
    await expect(teammate.getByText(TEAM_NOTE)).toBeVisible();
    expect((await teammate.request.get(teamDocUrl)).status()).toBe(200);
    await evidence(teammate, 'teammate-team-note', TASK_39);
  });
  await teammateContext.close();

  record('journeyMs', Date.now() - journeyStart);
  expect(consoleErrors, 'browser console errors').toEqual([]);
  await ownerContext.close();

  const out = {
    ...timings,
    fixture: FIXTURE,
    specBars: {
      interimLatencyMs: '< 1500 (SPEC §8)',
      enhanceMs: '< 30000 for a 1-hour meeting (SPEC §8; here a 33 s fixture with the mock LLM)',
      coldStartMs: '< 2000 (SPEC §8)',
    },
    timeoutScale: Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1),
    at: new Date().toISOString(),
  };
  mkdirSync(fileURLToPath(new URL('./test-results/', import.meta.url)), { recursive: true });
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  writeEvidence('timings.json', out, TASK);
});
