import { describe, expect, it } from 'vitest';
import { CHAT_FIXTURES } from '../../evals/chat/fixtures.ts';
import { createMockChatModel } from '../chat/testing.ts';
import { runChatFixture, scoreChat } from './chat-suite.ts';

const fixture = CHAT_FIXTURES[0]!;
const byId = (checks: ReturnType<typeof scoreChat>) =>
  Object.fromEntries(checks.map((c) => [c.id, c.pass]));

describe('chat eval suite', () => {
  it('runs a fixture through the mock tool loop', async () => {
    const out = await runChatFixture(fixture, createMockChatModel());
    expect(out.toolCalls).toEqual(['searchMeetings']);
    expect(out.citations.length).toBeGreaterThan(0);
    expect(scoreChat(fixture, out).every((c) => c.pass)).toBe(true);
  });

  it('fails citations the user cannot read, leaks and missing facts', () => {
    const checks = byId(
      scoreChat(fixture, {
        text: 'It goes to thirty euros [[block:tp-b1]].',
        citations: ['block:tp-b1'],
        dropped: [],
        toolCalls: [],
      }),
    );
    expect(checks).toMatchObject({
      answered: true,
      cited: true,
      'citations-valid': false,
      'cites-source': false,
      'mention:nine-euros': false,
      'no-leak:theo-thirty': false,
    });
  });

  it('copes with a missing output', () => {
    const checks = byId(scoreChat(fixture, undefined));
    expect(checks).toMatchObject({ answered: false, cited: false, 'citations-valid': true });
  });
});
