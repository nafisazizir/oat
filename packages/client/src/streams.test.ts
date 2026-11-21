import { expect, it, vi } from 'vitest';

import { readLines, readSse } from './index.ts';

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

it('reads lines across chunks and CRLF boundaries including a final unterminated line', async () => {
  expect(await collect(readLines(stream('a\r', '\nb\rc\n', 'd')))).toEqual(['a', 'b', 'c', 'd']);
});
it('decodes UTF-8 split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('é\n');
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 1));
      c.enqueue(bytes.slice(1));
      c.close();
    },
  });
  expect(await collect(readLines(input))).toEqual(['é']);
});
it('parses enhancement event names, JSON data, ids, comments and multiline data', async () => {
  expect(
    await collect(
      readSse(
        stream(
          ': heartbeat\n',
          'id: 1-0\nevent: preview\ndata: {"type":"preview"}\r',
          '\n\r\nevent: completed\ndata: one\ndata: two\n\n',
        ),
      ),
    ),
  ).toEqual([
    { id: '1-0', event: 'preview', data: '{"type":"preview"}' },
    { id: '1-0', event: 'completed', data: 'one\ntwo' },
  ]);
});
it('handles empty streams and drops incomplete SSE events', async () => {
  expect(await collect(readLines(stream()))).toEqual([]);
  expect(await collect(readSse(stream('event: preview\ndata: incomplete')))).toEqual([]);
});
it('cancels a stream and releases its lock when the iterator exits early', async () => {
  const cancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('one\ntwo\n'));
    },
    cancel,
  });
  for await (const _line of readLines(input)) break;
  expect(cancel).toHaveBeenCalledOnce();
  expect(input.locked).toBe(false);
});
it('aborts a pending read and cancels the source', async () => {
  const cancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({ cancel });
  const abort = new AbortController();
  const pending = collect(readSse(input, { signal: abort.signal }));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(input.locked).toBe(false);
});
it('handles an already aborted signal', async () => {
  const input = stream();
  await expect(collect(readLines(input, { signal: AbortSignal.abort() }))).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(input.locked).toBe(false);
});
it('preserves source errors and releases the reader', async () => {
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('broken'));
    },
  });
  await expect(collect(readLines(input))).rejects.toThrow('broken');
  expect(input.locked).toBe(false);
});
