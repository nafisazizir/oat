'use client';

import { OatApiError, readSse, type OatClient } from '@oat/client';
import { useMemo } from 'react';
import { useFeatureUi } from './provider';

export type EnhanceSource = EventTarget & {
  readyState: number;
  close(): void;
  onerror: (() => void) | null;
};

const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });

export function enhancementSource(client: OatClient, id: string): EnhanceSource {
  const controller = new AbortController();
  const { signal } = controller;
  const source: EnhanceSource = Object.assign(new EventTarget(), {
    readyState: 0,
    onerror: null as (() => void) | null,
    close() {
      source.readyState = 2;
      controller.abort();
    },
  });
  queueMicrotask(async () => {
    let lastEventId: string | undefined;
    while (!signal.aborted) {
      try {
        const body = await client.enhancements.stream(id, { lastEventId }, { signal });
        source.readyState = 1;
        for await (const event of readSse(body, { signal })) {
          if (signal.aborted) return;
          if (event.id !== undefined) lastEventId = event.id;
          const value = JSON.parse(event.data) as { type?: string };
          if (
            !value ||
            value.type !== event.event ||
            !['preview', 'completed', 'failed'].includes(event.event)
          )
            throw new Error('Invalid enhancement event.');
          source.dispatchEvent(new MessageEvent(event.event, { data: event.data }));
        }
      } catch (error) {
        if (signal.aborted) return;
        if (
          error instanceof OatApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        )
          source.readyState = 2;
      }
      if (signal.aborted) return;
      source.onerror?.();
      if (source.readyState === 2) return;
      source.readyState = 0;
      await pause(signal);
    }
  });
  return source;
}

export function useEnhanceClient() {
  const { client } = useFeatureUi();
  return useMemo(
    () => ({
      start: client.enhancements.enhance,
      latest: client.enhancements.latest,
      versions: client.enhancements.list,
      version: client.enhancements.get,
      restore: client.enhancements.restore,
      stream: (id: string) => enhancementSource(client, id),
    }),
    [client],
  );
}
