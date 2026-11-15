import { Hono } from 'hono';
import type { MockProvider } from '../provider.ts';

/**
 * Reference provider showing the shape every real provider follows: a Hono sub-app, optional websocket
 * routes, in-memory state owned by the factory closure, and a `reset()` hook. Real providers (llm, stt,
 * notion, gcal) land in later tasks; copy this file as a starting point.
 */
export function exampleProvider(): MockProvider {
  let counter = 0;
  const app = new Hono();

  // Echoes the request back, so tests can check what a client sent.
  app.all('/echo', async (c) => {
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? null : await c.req.text();
    return c.json({ method: c.req.method, query: c.req.query(), body });
  });

  app.get('/counter', (c) => c.json({ count: counter }));
  app.post('/counter', (c) => c.json({ count: ++counter }));

  return {
    name: 'example',
    description: 'Reference provider (echo + counter + websocket echo); not a real service.',
    app,
    // Websocket echo at /example/ws: sends back every frame (text stays text, binary stays binary).
    websockets: [
      {
        path: '/ws',
        handle(socket) {
          socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
        },
      },
    ],
    reset: () => {
      counter = 0;
    },
  };
}
