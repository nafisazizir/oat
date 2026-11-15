// Entrypoint of the `oat-agents` image (agents/Dockerfile, 8.3): optional localhost forwards, then the agents
// server (`agents/src/cli/serve.ts start`: bootstraps the Workflow world's database, then `eve start`).
//
// Forwards, like the web image (docker/web/entrypoint.mjs): URLs the agents hand to browsers must be the
// host's. The Notion mock builds page links from the request's Host header, so the agents call the mocks as
// `localhost:14010` and that is forwarded to `mocks:14010` here; "Open in Notion" links then work on the host.
// OAT_LOCALHOST_FORWARDS="<listenPort>=<host>:<port>,..."; unset (production): no forwards.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

const spec = process.env.OAT_LOCALHOST_FORWARDS?.trim();

for (const entry of (spec ?? '').split(',').filter((part) => part.trim())) {
  const match = /^(\d+)=([\w.-]+):(\d+)$/.exec(entry.trim());
  if (!match) throw new Error(`OAT_LOCALHOST_FORWARDS: bad entry "${entry}"`);
  const [listen, host, port] = [Number(match[1]), match[2], Number(match[3])];
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    client.pipe(upstream).pipe(client);
  });
  server.listen(listen, '127.0.0.1');
  await once(server, 'listening');
  console.log(`entrypoint: forwarding 127.0.0.1:${listen} → ${host}:${port}`);
}

const child = spawn(
  process.execPath,
  [
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    'agents/src/cli/serve.ts',
    'start',
  ],
  { stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
