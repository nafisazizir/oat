export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.search(/[\r\n]/)) !== -1) {
        // Wait for the LF of a CRLF split across chunks.
        if (!done && end === pending.length - 1 && pending[end] === '\r') break;
        const line = pending.slice(0, end);
        const width = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
        pending = pending.slice(end + width);
        yield line;
      }
      if (done) break;
    }
    if (pending) yield pending;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try {
      await reader.cancel();
    } catch {
      /* Preserve the original read error. */
    } finally {
      reader.releaseLock();
    }
  }
}

export type SseEvent = { event: string; data: string; id?: string };

/** Enhancement SSE uses event/type, JSON data, and an id that can be passed back as lastEventId. */
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SseEvent> {
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;
  for await (const line of readLines(stream, options)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
      event = 'message';
      data = [];
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
      if (field === 'id' && !value.includes('\0')) id = value;
    }
  }
}
