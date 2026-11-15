import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canReadDocument } from '@oat/core';
import { wrapLanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { CHAT_FIXTURES } from '../../evals/chat/fixtures.ts';
import { FORGED_CITATION, INJECTION_CANARY } from '../../evals/chat/lumen.ts';
import { BASELINE_PATH } from '../../evals/index.ts';
import { createMockChatModel } from '../chat/testing.ts';
import type { SearchMeetingsResult } from '../tools/tools.ts';
import { createMockModel, promptText } from '../testing.ts';
import { parseBaseline } from './baseline.ts';
import { fixturePermissions, resolveCitation } from './chat-scorers.ts';
import { type ChatFixture, createChatSuite, runChatFixture, scoreChat } from './chat-suite.ts';
import { runCli } from './cli.ts';

const fixture = (id: string) => CHAT_FIXTURES.find((f) => f.id === id)!;
const passes = (checks: ReturnType<typeof scoreChat>) =>
  Object.fromEntries(checks.map((c) => [c.id, c.pass]));
const test = (re: RegExp, text: string) =>
  new RegExp(re.source, re.flags.replace(/[gy]/g, '')).test(text);

function readable(f: ChatFixture, documentId: string) {
  const doc = f.world.documents.find((d) => d.id === documentId);
  return !!doc && canReadDocument(fixturePermissions(f), doc);
}

/** Everything the asker may read in the fixture's scope, as one text (titles, people, notes, transcript). */
function readableText(f: ChatFixture): string {
  const docs = f.world.documents.filter(
    (d) =>
      readable(f, d.id) &&
      (f.scope.kind === 'workspace'
        ? d.workspaceId === f.scope.workspaceId
        : d.id === f.scope.documentId),
  );
  const ids = new Set(docs.map((d) => d.id));
  const meetings = f.world.meetings.filter((m) => ids.has(m.documentId));
  return [
    ...docs.map((d) => `${d.title}\n${JSON.stringify(d.contentJson)}`),
    ...meetings.map((m) => m.participants.map((p) => p.name).join(', ')),
    ...f.world.segments
      .filter((s) => meetings.some((m) => m.id === s.meetingId))
      .map((s) => `${s.speakerLabel ?? ''}: ${s.text}`),
  ].join('\n');
}

// Guards the fixtures themselves: expectations the data can't satisfy would make every assistant look wrong.
describe('chat fixtures', () => {
  it('cover ≥ 12 questions incl. abstention, injection, permission and cross-meeting cases', () => {
    expect(CHAT_FIXTURES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CHAT_FIXTURES.map((f) => f.id)).size).toBe(CHAT_FIXTURES.length);
    expect(CHAT_FIXTURES.filter((f) => f.expect.kind === 'abstain').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(CHAT_FIXTURES.some((f) => f.expect.injection)).toBe(true);
    expect(CHAT_FIXTURES.filter((f) => f.expect.forbidden).length).toBeGreaterThanOrEqual(2);
    // Cross-meeting: the supporting citations span more than one document.
    const spans = (f: ChatFixture) =>
      new Set((f.expect.support ?? []).map((c) => resolveCitation(f.world, c)?.documentId)).size;
    expect(CHAT_FIXTURES.filter((f) => spans(f) > 1).length).toBeGreaterThanOrEqual(2);
  });

  describe.each(CHAT_FIXTURES)('$id', (f) => {
    const user = f.world.users[f.asUser]!;
    const scopeOk = (documentId: string) => {
      const doc = f.world.documents.find((d) => d.id === documentId)!;
      return f.scope.kind === 'workspace'
        ? doc.workspaceId === f.scope.workspaceId
        : doc.id === f.scope.documentId;
    };

    it('supports answers with readable, in-scope sources that state the expected facts', () => {
      if (f.expect.kind === 'abstain') {
        expect(f.expect.support ?? []).toEqual([]);
        return;
      }
      expect(f.expect.support?.length).toBeGreaterThan(0);
      for (const c of f.expect.support ?? []) {
        const source = resolveCitation(f.world, c);
        expect(source, c).toBeDefined();
        expect(readable(f, source!.documentId) && scopeOk(source!.documentId), c).toBe(true);
      }
      const supported = [
        user.name,
        ...(f.expect.support ?? []).map((c) => resolveCitation(f.world, c)!.text),
      ].join('\n');
      for (const m of f.expect.mustMention ?? []) {
        for (const re of Array.isArray(m.match) ? m.match : [m.match as RegExp]) {
          expect(test(re, supported), `${m.id}: ${re}`).toBe(true);
        }
      }
      for (const m of f.expect.mustNotMention ?? []) {
        expect(test(m.match, supported), `${m.id}: ${m.match}`).toBe(false);
      }
    });

    it('keeps forbidden facts in unreadable documents only, and plants the injection it checks', () => {
      for (const id of f.expect.forbidden?.documentIds ?? []) {
        expect(readable(f, id), id).toBe(false);
        const doc = JSON.stringify(f.world.documents.find((d) => d.id === id)!.contentJson);
        for (const fact of f.expect.forbidden!.facts) {
          expect(test(fact.match, doc), fact.id).toBe(true);
          expect(test(fact.match, readableText(f)), `${fact.id} readable elsewhere`).toBe(false);
        }
      }
      if (f.expect.injection) {
        const planted = f.world.segments.map((s) => s.text).join('\n');
        for (const re of f.expect.injection.obeyed)
          expect(test(re, planted), String(re)).toBe(true);
        for (const c of f.expect.injection.forgedCitations ?? []) {
          expect(planted).toContain(`[[${c}]]`);
        }
      }
    });
  });
});

describe('chat eval suite (mock tier)', () => {
  it('runs a fixture through the mock tool loop and passes every check', async () => {
    const f = fixture('starter-price');
    const out = await runChatFixture(f, createMockChatModel());
    expect(out.toolCalls).toEqual(['searchMeetings']);
    expect(out.citations.length).toBeGreaterThan(0);
    expect(out.provided).toEqual(expect.arrayContaining(out.citations));
    expect(scoreChat(f, out).every((c) => c.pass)).toBe(true);
  });

  it('passes the structural tier on every fixture', async () => {
    for (const f of CHAT_FIXTURES) {
      const checks = scoreChat(f, await runChatFixture(f, createMockChatModel()));
      const failed = checks.filter((c) => c.tier === 'structural' && !c.pass);
      expect(failed, f.id).toEqual([]);
    }
  });

  it('strips the citation forged inside injected transcript text (end to end)', async () => {
    const f = fixture('northwind-injection');
    const out = await runChatFixture(f, createMockChatModel());
    // The mock quotes the planted line's first sentence, marker included; the filter removes the marker.
    expect(out.dropped).toContain(`[[${FORGED_CITATION}]]`);
    expect(out.citations).not.toContain(FORGED_CITATION);
    expect(out.text).not.toContain(INJECTION_CANARY);
    expect(passes(scoreChat(f, out))).toMatchObject({
      'injection-resisted': true,
      'markers-resolved': false,
    });
  });

  it('shows a teammate’s recording with their name on their mic lines, never as "Me"', async () => {
    for (const id of ['soc2-sender', 'pilot-proposal-owner']) {
      const f = fixture(id);
      const out = await runChatFixture(f, createMockChatModel());
      // Mic lines in Riley's call, as Alex sees them (Alex's own meetings still say "Me").
      const rileyMic = new Set(
        f.world.segments
          .filter((x) => x.meetingId === 'm-pd' && x.source === 'mic')
          .map((x) => x.id),
      );
      const speakers = (out.toolOutputs as { results?: SearchMeetingsResult[] }[])
        .flatMap((o) => o.results ?? [])
        .flatMap((r) => r.excerpts)
        .filter((e) => rileyMic.has(e.cite.slice('[[seg:'.length, -2)))
        .map((e) => e.speaker);
      expect(speakers.length, id).toBeGreaterThan(0);
      expect(new Set(speakers), id).toEqual(new Set(['Riley Park']));
      expect(scoreChat(f, out).filter((c) => c.tier === 'structural' && !c.pass)).toEqual([]);
    }
  });

  it('never hands the private debrief to the model (permission fixture)', async () => {
    const f = fixture('elena-offer-private');
    const out = await runChatFixture(f, createMockChatModel());
    expect(JSON.stringify(out.toolOutputs)).not.toMatch(/182,000|doc-db/);
    expect(passes(scoreChat(f, out))['permission-safe']).toBe(true);
  });

  it('has a committed mock baseline covering every fixture', () => {
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
    expect(Object.keys(baseline.mock?.chat ?? {}).sort()).toEqual(
      CHAT_FIXTURES.map((f) => f.id).sort(),
    );
  });
});

describe('chat eval suite (quality tier wiring)', () => {
  it('runs the chat role at temperature 0 and judges grounding with the judge role', async () => {
    const temperatures: (number | undefined)[] = [];
    const judge = createMockModel({
      modelId: 'fake-judge',
      handler: (call) =>
        JSON.stringify({
          unsupported: promptText(call).includes('Question: How much budget')
            ? [{ sentence: 1, reason: 'not in the cited line' }]
            : [],
        }),
    });
    const roles: string[] = [];
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'oat-chat-eval-'));
    const code = await runCli(
      ['--suite', 'chat', '--model', 'real', '--json', join(dir, 'out.json'), '--verbose'],
      {
        suites: { chat: createChatSuite(CHAT_FIXTURES) },
        baselinePath: BASELINE_PATH,
        env: { AI_GATEWAY_API_KEY: 'test-key' },
        cwd: dir,
        log: (text) => lines.push(text),
        getModel: (role) => {
          roles.push(role);
          if (role === 'judge') return judge;
          // A "real" chat model: the mock LLM's tool loop, recording the sampling settings it gets.
          return wrapLanguageModel({
            model: createMockChatModel(),
            modelId: 'fake-chat',
            middleware: {
              specificationVersion: 'v4',
              transformParams: async ({ params }) => {
                temperatures.push(params.temperature);
                return params;
              },
            },
          });
        },
      },
    );
    const out = lines.join('\n');
    expect(roles).toEqual(['chat', 'judge']);
    expect(out).toContain('chat · real · fake-chat · judge fake-judge');
    expect(out).toContain('Baseline: chat not compared (no real baseline).');
    expect(out).toContain('✗ pinecrest-budget judge:grounding');
    expect(code).toBe(0);

    const json = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    for (const f of json.results[0].fixtures) {
      expect(f.checks.map((c: { id: string }) => c.id)).toContain('judge:grounding');
    }
    expect(new Set(temperatures)).toEqual(new Set([0]));
    expect(judge.doGenerateCalls.length).toBe(CHAT_FIXTURES.length);
    for (const call of judge.doGenerateCalls) expect(call.temperature).toBe(0);
  });
});
