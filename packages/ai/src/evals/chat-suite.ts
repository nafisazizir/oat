/**
 * The `chat` eval suite (6.2 groundwork for 6.5): fixture questions over a small synthetic workspace →
 * `streamAssistant` (the same tool loop and citation filter as `/api/chat`) → scorers.
 *
 * - structural (absolute gate): the assistant answered, cited something, and every citation in the answer
 *   resolves to a transcript segment or note block the asking user may read;
 * - property (baseline-compared): must-mention facts, must-not-mention (leaks from notes the user can't read),
 *   and whether the answer cites one of the expected sources.
 *
 * Mock mode runs the mock LLM's scripted tool loop in-process (search → quote + cite the top results), so the
 * whole path is exercised offline; answer quality needs `--model real`.
 */
import { canReadDocument, createPermissionContext, type Role } from '@oat/core';
import { CitationRegistry, extractCitations } from '../chat/citations.ts';
import { loadDocumentContext, streamAssistant } from '../chat/run.ts';
import { createMockChatModel } from '../chat/testing.ts';
import { createMemoryAssistantData } from '../tools/memory.ts';
import type {
  DocumentRecord,
  MeetingRecord,
  SegmentRecord,
  ToolContext,
  ToolScope,
} from '../tools/types.ts';
import type { CheckResult, EvalSuite } from './types.ts';

export interface ChatWorld {
  users: Record<string, { name: string; memberships: Record<string, Role> }>;
  documents: readonly DocumentRecord[];
  meetings: readonly MeetingRecord[];
  segments: readonly SegmentRecord[];
}

export interface ChatFixture {
  id: string;
  description: string;
  world: ChatWorld;
  /** Key into `world.users`. */
  asUser: string;
  scope: ToolScope;
  question: string;
  now: string;
  expect: {
    mustMention: { id: string; match: RegExp | readonly RegExp[] }[];
    /** Facts from documents the user can't read (or wrong facts): must not appear. */
    mustNotMention?: { id: string; match: RegExp }[];
    /** The answer should cite at least one of these (`seg:<id>` / `block:<id>`). */
    citeOneOf: readonly string[];
  };
}

export interface ChatOutput {
  text: string;
  citations: string[];
  dropped: string[];
  toolCalls: string[];
}

function toolContextFor(fixture: ChatFixture): ToolContext {
  const user = fixture.world.users[fixture.asUser];
  if (!user) throw new Error(`unknown user ${fixture.asUser}`);
  return {
    permissions: createPermissionContext({
      userId: fixture.asUser,
      memberships: Object.entries(user.memberships).map(([workspaceId, role]) => ({
        workspaceId,
        userId: fixture.asUser,
        role,
      })),
    }),
    data: createMemoryAssistantData(fixture.world),
    scope: fixture.scope,
  };
}

export async function runChatFixture(
  fixture: ChatFixture,
  model: Parameters<typeof streamAssistant>[0]['model'],
  temperature?: number,
): Promise<ChatOutput> {
  const tools = toolContextFor(fixture);
  const registry = new CitationRegistry();
  const context =
    fixture.scope.kind === 'document'
      ? await loadDocumentContext(tools, registry, {
          me: { name: fixture.world.users[fixture.asUser]!.name },
        })
      : undefined;
  const run = await streamAssistant({
    model,
    tools,
    registry,
    ...(context ? { documentContext: context.rendered } : {}),
    messages: [{ id: 'q', role: 'user', parts: [{ type: 'text', text: fixture.question }] }],
    now: new Date(fixture.now),
    ...(temperature !== undefined ? { temperature } : {}),
  });
  const text = await run.result.text;
  const steps = await run.result.steps;
  return {
    text,
    citations: extractCitations(text).map((c) => `${c.kind}:${c.id}`),
    dropped: run.citations.dropped,
    toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
  };
}

const check = (
  id: string,
  tier: CheckResult['tier'],
  pass: boolean,
  detail?: string,
): CheckResult => ({
  id,
  tier,
  score: pass ? 1 : 0,
  pass,
  ...(detail && !pass ? { detail } : {}),
});

/** A cited id the user may read in the fixture world (segment → its meeting's document). */
function readableCitation(fixture: ChatFixture, citation: string): boolean {
  const [kind, id] = citation.split(/:(.*)/s) as [string, string];
  const ctx = toolContextFor(fixture).permissions;
  const visible = (documentId: string) => {
    const doc = fixture.world.documents.find((d) => d.id === documentId);
    return !!doc && doc.deletedAt === null && canReadDocument(ctx, doc);
  };
  if (kind === 'seg') {
    const segment = fixture.world.segments.find((s) => s.id === id);
    const meeting = fixture.world.meetings.find((m) => m.id === segment?.meetingId);
    return !!meeting && visible(meeting.documentId);
  }
  return fixture.world.documents.some(
    (d) => visible(d.id) && JSON.stringify(d.contentJson).includes(`"id":${JSON.stringify(id)}`),
  );
}

export function scoreChat(fixture: ChatFixture, output: unknown): CheckResult[] {
  const out = output as Partial<ChatOutput> | undefined;
  const text = typeof out?.text === 'string' ? out.text : '';
  const citations = Array.isArray(out?.citations) ? out.citations : [];
  const bad = citations.filter((c) => !readableCitation(fixture, c));
  const checks: CheckResult[] = [
    check('answered', 'structural', text.trim().length > 0, 'empty answer'),
    check('cited', 'structural', citations.length > 0, 'no citations'),
    check('citations-valid', 'structural', bad.length === 0, `invalid: ${bad.join(', ')}`),
    check(
      'cites-source',
      'property',
      citations.some((c) => fixture.expect.citeOneOf.includes(c)),
      `cited ${citations.join(', ') || 'nothing'}`,
    ),
  ];
  const plain = text.replace(/\[\[[^\]]*\]\]/g, ' ');
  for (const m of fixture.expect.mustMention) {
    const patterns = Array.isArray(m.match) ? m.match : [m.match as RegExp];
    checks.push(
      check(
        `mention:${m.id}`,
        'property',
        patterns.every((p) => p.test(plain)),
        'missing',
      ),
    );
  }
  for (const m of fixture.expect.mustNotMention ?? []) {
    checks.push(check(`no-leak:${m.id}`, 'property', !m.match.test(plain), 'mentioned'));
  }
  return checks;
}

export function createChatSuite(fixtures: readonly ChatFixture[]): EvalSuite<ChatFixture> {
  return {
    name: 'chat',
    fixtures,
    role: 'chat',
    mockModel: () => createMockChatModel(),
    run: (fixture, ctx) => runChatFixture(fixture, ctx.model, ctx.temperature),
    score: scoreChat,
  };
}
