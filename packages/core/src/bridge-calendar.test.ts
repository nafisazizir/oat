import { describe, expect, it } from 'vitest';

import { bridgeChannels, bridgeContract } from './bridge.ts';

const invoke = bridgeContract.invoke;

describe('calendar + detection bridge channels (7.3)', () => {
  it('are part of the contract', () => {
    for (const c of [
      'calendar:get',
      'calendar:refresh',
      'calendar:connect',
      'calendar:start-notes',
      'prompt:get',
      'prompt:respond',
    ]) {
      expect(bridgeChannels.invoke).toContain(c);
    }
    for (const c of ['calendar:changed', 'prompt:changed', 'notes:open']) {
      expect(bridgeChannels.subscribe).toContain(c);
    }
  });

  it('prompt:respond takes a known action and a plain fixture name only', () => {
    const req = invoke['prompt:respond'].request;
    expect(req.safeParse({ promptId: 'prompt-1', action: 'start' }).success).toBe(true);
    expect(
      req.safeParse({ promptId: 'prompt-1', action: 'start', input: 'file', fixture: 'standup' })
        .success,
    ).toBe(true);
    expect(req.safeParse({ promptId: 'prompt-1', action: 'record' }).success).toBe(false);
    expect(
      req.safeParse({ promptId: 'prompt-1', action: 'start', fixture: '../etc/passwd' }).success,
    ).toBe(false);
    expect(req.safeParse({ promptId: '', action: 'dismiss' }).success).toBe(false);
  });

  it('calendar:connect and calendar:start-notes are strict', () => {
    expect(invoke['calendar:connect'].request.safeParse({ provider: 'google' }).success).toBe(true);
    expect(invoke['calendar:connect'].request.safeParse({ provider: 'outlook' }).success).toBe(
      false,
    );
    const start = invoke['calendar:start-notes'].request;
    expect(start.safeParse({ eventId: 'eventkit:abc' }).success).toBe(true);
    expect(start.safeParse({ eventId: 'eventkit:abc', title: 'x' }).success).toBe(false);
    expect(start.safeParse({ eventId: '' }).success).toBe(false);
  });

  it('a meeting note without a calendar event parses with calendarEvent null', () => {
    const note = invoke['meeting:get'].response.parse({
      documentId: 'd1',
      meetingId: 'm1',
      workspaceId: 'ws',
      workspaceName: null,
      title: 'Weekly sync',
      contentJson: { type: 'doc' },
      visibility: 'private',
      editable: true,
      recordedHere: true,
      trashed: false,
      startedAt: null,
      endedAt: null,
      updatedAt: '2026-11-15T10:00:00.000Z',
      participants: [],
    });
    expect(note?.calendarEvent).toBeNull();
  });
});
