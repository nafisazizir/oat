import { startMocks } from './server.ts';

// MOCKS_HOST is 0.0.0.0 in the container; natively we only listen on loopback.
const mocks = await startMocks({
  port: Number(process.env.MOCKS_PORT ?? 14010),
  hostname: process.env.MOCKS_HOST ?? '127.0.0.1',
});
console.log(
  `@oat/mocks listening on ${mocks.url} ` +
    `(providers: ${mocks.providers.map((p) => p.name).join(', ') || 'none'})`,
);

function shutdown(signal: string) {
  console.log(`@oat/mocks: ${signal}, shutting down`);
  void mocks.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
