import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';

import { describeChatError, formatWait } from './chat-client';

const apiError = (statusCode: number, body: unknown) =>
  new APICallError({
    message: 'failed',
    url: '/api/chat',
    requestBodyValues: undefined,
    statusCode,
    responseBody: JSON.stringify(body),
  });

describe('describeChatError', () => {
  it('429 says when to try again', () => {
    const failure = describeChatError(
      apiError(429, {
        error: { code: 'rate_limited', message: 'slow down' },
        retryAfter: 42,
      }),
    );
    expect(failure).toMatchObject({ kind: 'rate_limited', retryAfter: 42 });
    expect(failure.message).toMatch(/Try again in 42 s/);
  });

  it('429 without retryAfter still explains', () => {
    expect(describeChatError(apiError(429, {})).message).toMatch(/Try again in a moment/);
  });

  it('uses the server message for other API errors', () => {
    expect(
      describeChatError(apiError(400, { error: { code: 'bad_request', message: 'Too long.' } })),
    ).toEqual({ kind: 'error', message: 'Too long.' });
    expect(describeChatError(apiError(404, {})).kind).toBe('not_found');
  });

  it('stream errors carry the server’s short message; network failures say offline', () => {
    expect(describeChatError(new Error('The assistant ran into a problem.')).message).toBe(
      'The assistant ran into a problem.',
    );
    expect(describeChatError(new TypeError('Failed to fetch')).kind).toBe('offline');
  });
});

describe('formatWait', () => {
  it.each([
    [42, '42 s'],
    [120, '2 min'],
    [7200, '2 h'],
  ])('%i → %s', (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});
