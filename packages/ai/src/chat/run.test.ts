import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createMockModel } from '../testing.ts';
import { TEAM, toolContext, users } from '../tools/test-world.ts';
import { CitationRegistry, extractCitations } from './citations.ts';
import {
  completeParts,
  loadDocumentContext,
  registerHistory,
  streamAssistant,
  trimHistory,
} from './run.ts';
import { createMockChatModel } from './testing.ts';

const user = (text: string, id = 'u1'): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('streamAssistant (mock LLM tool loop)', () => {
  it('searches, then answers with citations that all came from tool output', async () => {
    const run = await streamAssistant({
      model: createMockChatModel(),
      tools: toolContext(users.bob),
      messages: [user('What did Dana say about the starter plan price?')],
    });
    const text = await run.result.text;
    const steps = await run.result.steps;
    expect(steps[0]!.toolCalls.map((c) => c.toolName)).toEqual(['searchMeetings']);
    const cited = extractCitations(text);
    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) {
      expect(
        c.kind === 'seg' ? run.registry.segments.has(c.id) : run.registry.blocks.has(c.id),
      ).toBe(true);
    }
    expect(run.citations.kept).toEqual(cited);
    // Bob can't read the private meeting: nothing from it, even when transcript text tries to cite it.
    expect(text).not.toContain('seg-secret');
    expect(text).not.toContain('Salary');
  });

  it('strips citations the model invents', async () => {
    const run = await streamAssistant({
      model: createMockModel({
        responses: ['The price stays [[seg:seg-1]][[seg:made-up]]. [[block:b-price]]'],
      }),
      tools: toolContext(users.bob),
      messages: [user('price?')],
    });
    expect(await run.result.text).toBe('The price stays . ');
    expect(run.citations.dropped).toEqual([
      '[[seg:seg-1]]',
      '[[seg:made-up]]',
      '[[block:b-price]]',
    ]);
  });

  it('a document chat gets the note context; its refs and block ids are citable', async () => {
    const ctx = toolContext(users.bob, {
      kind: 'document',
      workspaceId: TEAM,
      documentId: 'd-standup',
    });
    const registry = new CitationRegistry();
    const context = await loadDocumentContext(ctx, registry, { me: { name: 'Bob' } });
    expect(context?.rendered).toContain('<oat:transcript>');
    expect(registry.resolve('seg', 's2')).toBe('seg-2');
    expect(registry.resolve('block', 'b-price')).toBe('b-price');
    const run = await streamAssistant({
      model: createMockModel({
        responses: ['Dana wants twelve dollars [[seg:s2]] as noted [[block:b-price]].'],
      }),
      tools: ctx,
      registry,
      documentContext: context!.rendered,
      messages: [user('price?')],
    });
    expect(await run.result.text).toBe(
      'Dana wants twelve dollars [[seg:seg-2]] as noted [[block:b-price]].',
    );
    expect(run.result).toBeDefined();
    // Not visible → no context.
    const hidden = toolContext(users.bob, {
      kind: 'document',
      workspaceId: TEAM,
      documentId: 'd-secret',
    });
    expect(
      await loadDocumentContext(hidden, new CitationRegistry(), { me: { name: 'Bob' } }),
    ).toBeUndefined();
  });

  it('passes the user profile into document and workspace chats, fenced as data', async () => {
    const profile = {
      aboutMe: 'Role: PM\nWhat I care about:\nPricing',
      vocabulary: ['Brightsmile'],
    };
    const docCtx = toolContext(users.bob, {
      kind: 'document',
      workspaceId: TEAM,
      documentId: 'd-standup',
    });
    const loaded = await loadDocumentContext(docCtx, new CitationRegistry(), {
      me: { name: 'Bob' },
      ...profile,
    });
    expect(loaded?.rendered).toContain('<oat:about_me>\nRole: PM\nWhat I care about:\nPricing\n');
    expect(loaded?.rendered).toContain('Correct spellings of names and terms: Brightsmile');

    const seen: string[] = [];
    const model = createMockModel({
      handler: (call) => {
        seen.push(JSON.stringify(call.prompt));
        return 'ok';
      },
    });
    const run = await streamAssistant({
      model,
      tools: toolContext(users.bob),
      profile,
      messages: [user('hi')],
    });
    await run.result.text;
    expect(seen.join('')).toContain('<oat:about_me>');
    expect(seen.join('')).toContain('Brightsmile');
  });

  it('collects updateDocument proposals without writing', async () => {
    const run = await streamAssistant({
      model: createMockChatModel(),
      tools: toolContext(users.bob),
      messages: [
        user(
          'mock:tool updateDocument {"documentId":"d-standup","edits":[{"find":"first week of May","replace":"second week of May"}]}',
        ),
      ],
    });
    await run.result.text;
    expect(run.proposals).toEqual([
      expect.objectContaining({ documentId: 'd-standup', baseVersion: 3, status: 'pending' }),
    ]);
  });
});

describe('aborted turns', () => {
  const aborted: UIMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'tool-searchMeetings',
        toolCallId: 'call-1',
        state: 'input-available',
        input: { query: 'price' },
      },
    ],
  };

  it('a tool call without a result in history does not break the next turn', async () => {
    const run = await streamAssistant({
      model: createMockChatModel(),
      tools: toolContext(users.bob),
      messages: [user('price?', 'u0'), aborted, user('What did Dana say about the starter plan?')],
    });
    expect(extractCitations(await run.result.text).length).toBeGreaterThan(0);
  });

  it('completeParts drops unfinished tool calls before saving', () => {
    const done = {
      type: 'tool-getDocument' as const,
      toolCallId: 'call-2',
      state: 'output-available' as const,
      input: {},
      output: {},
    };
    expect(completeParts([...aborted.parts, done, { type: 'text', text: 'x' }])).toEqual([
      { type: 'step-start' },
      done,
      { type: 'text', text: 'x' },
    ]);
  });
});

describe('history', () => {
  it('trimHistory keeps the newest messages and starts on a user turn', () => {
    const msgs: UIMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text: 'x'.repeat(400) }],
    }));
    expect(trimHistory(msgs, 4).map((m) => m.id)).toEqual(['6', '7', '8', '9']);
    expect(trimHistory(msgs, 3).map((m) => m.id)).toEqual(['8', '9']);
    expect(trimHistory(msgs, 100, 150).map((m) => m.id)).toEqual(['9']);
  });

  it('registerHistory allows ids from earlier tool results', () => {
    const registry = new CitationRegistry();
    registerHistory(registry, [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            type: 'tool-searchMeetings',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: { results: [{ excerpts: [{ cite: '[[seg:old-1]]', text: 'x' }] }] },
          },
        ],
      },
    ]);
    expect(registry.resolve('seg', 'old-1')).toBe('old-1');
  });
});
