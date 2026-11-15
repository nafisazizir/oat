/**
 * The `chat` eval suite (6.2, expanded in 6.5): fixture questions over small synthetic workspaces →
 * `streamAssistant` (the same tool loop and citation filter as `/api/chat`) → scorers (`./chat-scorers.ts`)
 * → with `--model real`, the grounding judge (`./chat-judge.ts`).
 *
 * Mock mode runs the mock LLM's scripted tool loop in-process (search → quote + cite the top results), so the
 * whole path — tools, permission checks, fencing, citation filter — is exercised offline and must pass the
 * structural tier. Answer quality (abstaining, resisting injections, precise citations) needs `--model real`;
 * the mock's property scores are recorded in the baseline so plumbing changes can't silently move them.
 */
import { CitationRegistry, extractCitations } from '../chat/citations.ts';
import { loadDocumentContext, streamAssistant } from '../chat/run.ts';
import { createMockChatModel } from '../chat/testing.ts';
import { createMemoryAssistantData } from '../tools/memory.ts';
import type { ToolContext } from '../tools/types.ts';
import { judgeChat } from './chat-judge.ts';
import {
  type ChatFixture,
  type ChatOutput,
  fixturePermissions,
  scoreChat,
} from './chat-scorers.ts';
import type { EvalSuite } from './types.ts';

export type { ChatExpectations, ChatFixture, ChatOutput, ChatWorld } from './chat-scorers.ts';
export { scoreChat } from './chat-scorers.ts';

function toolContextFor(fixture: ChatFixture): ToolContext {
  return {
    permissions: fixturePermissions(fixture),
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
    // Read after the stream finished: the registry has every id the tools handed out.
    provided: [
      ...[...registry.segments].map((id) => `seg:${id}`),
      ...[...registry.blocks].map((id) => `block:${id}`),
    ],
    toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
    toolOutputs: steps.flatMap((s) => s.toolResults.map((r) => r.output)),
  };
}

export function createChatSuite(fixtures: readonly ChatFixture[]): EvalSuite<ChatFixture> {
  return {
    name: 'chat',
    fixtures,
    role: 'chat',
    mockModel: () => createMockChatModel(),
    run: (fixture, ctx) => runChatFixture(fixture, ctx.model, ctx.temperature),
    score: scoreChat,
    judge: judgeChat,
  };
}
