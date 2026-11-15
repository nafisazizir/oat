/**
 * Keeps `AudioEvent` in lock-step with the sidecar wire protocol: parses the event table and error-code list in
 * `native/oat-audio/PROTOCOL.md` and compares them with the TypeScript model. A protocol change that is not
 * mirrored here fails this test.
 */
import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIO_EVENT_TYPES,
  SIDECAR_ERROR_CODES,
  type AudioEventOf,
  type AudioEventType,
  type AudioStopReason,
} from './types.ts';

const PROTOCOL = new URL('../../../native/oat-audio/PROTOCOL.md', import.meta.url);

/** One fully populated example per event type; the compiler checks each against the union. */
const EXAMPLES: { [K in AudioEventType]: AudioEventOf<K> } = {
  started: {
    type: 'started',
    tUs: 0,
    sampleRate: 16_000,
    frameMs: 50,
    sources: ['mic', 'system'],
    protocol: 1,
    version: '0.1.0',
    synthetic: false,
    aec: true,
  },
  stopped: { type: 'stopped', tUs: 1, reason: 'command', samples: { mic: 1, system: 1 } },
  paused: { type: 'paused', tUs: 1 },
  resumed: { type: 'resumed', tUs: 1 },
  error: { type: 'error', tUs: 1, source: 'mic', code: 'device_lost', message: 'm', fatal: true },
  device_changed: { type: 'device_changed', tUs: 1, source: 'mic', device: 'd' },
  format_changed: {
    type: 'format_changed',
    tUs: 1,
    source: 'mic',
    deviceSampleRate: 16_000,
    previousDeviceSampleRate: 48_000,
    channels: 1,
  },
  level: { type: 'level', tUs: 1, source: 'system', rmsDb: -20, peakDb: -6 },
  overrun: {
    type: 'overrun',
    tUs: 1,
    source: 'system',
    stage: 'output',
    droppedSamples: 800,
    droppedMs: 50,
  },
};

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

let doc: string;
beforeAll(async () => {
  doc = await readFile(PROTOCOL, 'utf8');
});

function eventTable(): Map<string, string[]> {
  const section = doc.slice(doc.indexOf('### Event frames'), doc.indexOf('### Clock'));
  const rows = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const [types = '', , fields = ''] = line
      .split('|')
      .slice(1)
      .map((c) => c.trim());
    // Field names are the backticked tokens outside parentheses (inside are allowed values / notes).
    const names = ticks(fields.replace(/\([^)]*\)/g, ''));
    for (const type of ticks(types)) rows.set(type, names);
  }
  return rows;
}

describe('AudioEvent ↔ PROTOCOL.md (protocol 1)', () => {
  it('the doc is protocol 1', () => {
    expect(doc).toMatch(/^# oat-audio wire protocol — `protocol: 1`/);
  });

  it('covers exactly the event types in the protocol table', () => {
    const table = eventTable();
    expect(table.size).toBeGreaterThanOrEqual(9);
    expect([...table.keys()].sort()).toEqual([...AUDIO_EVENT_TYPES].sort());
  });

  it.each([...AUDIO_EVENT_TYPES])(
    '`%s` carries exactly the protocol fields (camelCase)',
    (type) => {
      const protocolFields = (eventTable().get(type) ?? []).map(camel).sort();
      const ours = Object.keys(EXAMPLES[type])
        .filter((k) => !['type', 'tUs', 'source'].includes(k))
        .sort();
      expect(ours).toEqual(protocolFields);
    },
  );

  it('knows every error code the sidecar emits', () => {
    const start = doc.indexOf('Error codes currently emitted');
    const paragraph = doc.slice(start, doc.indexOf('Treat unknown codes', start));
    const codes = ticks(paragraph).filter((t) => /^[a-z_]+$/.test(t));
    expect(codes.length).toBeGreaterThan(5);
    expect([...SIDECAR_ERROR_CODES].sort()).toEqual([...new Set(codes)].sort());
  });

  it('stop reasons in the doc are all valid AudioStopReason values', () => {
    const stoppedRow = doc.split('\n').find((l) => l.startsWith('| `stopped`')) ?? '';
    const reasons = ticks(stoppedRow.match(/`reason` \(([^)]*)\)/)?.[1] ?? '');
    expect(reasons.length).toBeGreaterThan(0);
    // Exhaustive (compiler-checked) list of our reasons.
    const ours: Record<AudioStopReason, true> = {
      duration: true,
      command: true,
      stdin_eof: true,
      signal: true,
      error: true,
      output_closed: true,
      end_of_input: true,
    };
    for (const reason of reasons) expect(ours).toHaveProperty(reason);
  });
});
