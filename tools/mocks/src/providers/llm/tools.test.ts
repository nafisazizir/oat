import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { citedItems, NO_CITATIONS_REPLY, planToolTurn } from './tools.ts';

const search = {
  type: 'function',
  function: {
    name: 'searchMeetings',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};
const read = {
  type: 'function',
  function: {
    name: 'getDocument',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } } },
  },
};

const user = (content: string) => ({ role: 'user', content });

function post(body: unknown) {
  const { app } = createApp();
  return app.request('/llm/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('planToolTurn', () => {
  it('searches with the user message when a query tool is offered', () => {
    expect(planToolTurn([user('What did we decide on pricing?')], [read, search], 'auto')).toEqual({
      kind: 'call',
      name: 'searchMeetings',
      arguments: JSON.stringify({ query: 'What did we decide on pricing?' }),
    });
  });

  it('honours mock:tool directives and forced tool choice', () => {
    expect(
      planToolTurn([user('mock:tool getDocument {"documentId":"d1"}')], [search, read], 'auto'),
    ).toEqual({ kind: 'call', name: 'getDocument', arguments: '{"documentId":"d1"}' });
    expect(
      planToolTurn([user('hi')], [search, read], {
        type: 'function',
        function: { name: 'getDocument' },
      }),
    ).toEqual({ kind: 'call', name: 'getDocument', arguments: '{}' });
  });

  it('does nothing without tools, with tool_choice none, or without a query tool', () => {
    expect(planToolTurn([user('hi')], undefined, undefined)).toBeUndefined();
    expect(planToolTurn([user('hi')], [search], 'none')).toBeUndefined();
    expect(planToolTurn([user('hi')], [read], 'auto')).toBeUndefined();
  });

  it('answers from tool results with their citation markers', () => {
    const output = {
      results: [
        {
          excerpts: [
            {
              cite: '[[seg:a1]]',
              text: '<oat:excerpt>Pricing stays flat. More later.</oat:excerpt>',
            },
            { cite: '[[block:b2]]', text: 'Launch moves to May' },
          ],
        },
      ],
    };
    const plan = planToolTurn(
      [
        user('pricing?'),
        { role: 'assistant', content: null },
        { role: 'tool', content: JSON.stringify(output) },
      ],
      [search],
      'auto',
    );
    expect(plan).toEqual({
      kind: 'answer',
      content: 'Pricing stays flat. [[seg:a1]] Launch moves to May. [[block:b2]]',
    });
    expect(
      planToolTurn([user('x'), { role: 'tool', content: '{"ok":true}' }], [search], 'auto'),
    ).toEqual({ kind: 'answer', content: NO_CITATIONS_REPLY });
  });

  it('finds cited items at any depth', () => {
    expect(citedItems({ a: [{ b: { cite: 'c', text: 't' } }] })).toEqual([
      { cite: 'c', text: 't' },
    ]);
  });
});

describe('POST /llm/v1/chat/completions with tools', () => {
  it('returns an OpenAI tool call (non-streaming)', async () => {
    const res = await post({ model: 'm', messages: [user('pricing?')], tools: [search] });
    const body = (await res.json()) as {
      choices: { message: { tool_calls: unknown[]; content: unknown }; finish_reason: string }[];
    };
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
    expect(body.choices[0]!.message.content).toBeNull();
    expect(body.choices[0]!.message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_mock_/),
        type: 'function',
        function: { name: 'searchMeetings', arguments: '{"query":"pricing?"}' },
      },
    ]);
  });

  it('streams the tool call as one delta and finishes with tool_calls', async () => {
    const res = await post({
      model: 'm',
      messages: [user('pricing?')],
      tools: [search],
      stream: true,
    });
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: ') && !f.endsWith('[DONE]'))
      .map(
        (f) =>
          JSON.parse(f.slice(6)) as {
            choices: { delta: { tool_calls?: unknown }; finish_reason: string | null }[];
          },
      );
    expect(frames.some((f) => f.choices[0]?.delta.tool_calls)).toBe(true);
    expect(frames.at(-1)!.choices[0]!.finish_reason).toBe('tool_calls');
  });
});
