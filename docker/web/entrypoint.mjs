// Entrypoint of the `oat-web` image (apps/web/Dockerfile): optional localhost forwards, then Next's
// standalone server in the same process.
//
// Why forwards: some URLs are used both by the server and by a browser or the desktop app on the host
// (the OAuth issuer, the mocks' STT/LLM base). mock-oauth2-server even derives the token `iss` and every
// discovery endpoint from the request's Host header. Inside compose, `http://oauth:8080/google` would
// give the server a different issuer and browser-unreachable endpoints than the host's
// `http://localhost:18089/google`. Forwarding 127.0.0.1:18089 → oauth:8080 inside the container makes
// the host's URLs valid here too, so the container uses the same .env values as the host with no app code
// for the mismatch.
//
// OAT_LOCALHOST_FORWARDS="<listenPort>=<host>:<port>,..." e.g. "18089=oauth:8080,14010=mocks:14010".
// Unset (production): no forwards, nothing listens besides Next.
import { once } from 'node:events';
import net from 'node:net';

const spec = process.env.OAT_LOCALHOST_FORWARDS?.trim();

/** @param {string} entry */
function parse(entry) {
  const match = /^(\d+)=([\w.-]+):(\d+)$/.exec(entry.trim());
  if (!match)
    throw new Error(`OAT_LOCALHOST_FORWARDS: bad entry "${entry}" (want <port>=<host>:<port>)`);
  return { listen: Number(match[1]), host: match[2], port: Number(match[3]) };
}

/**
 * Listens on both loopback addresses: `localhost` resolves to ::1 first for some clients (busybox wget,
 * Node without happy eyeballs). ::1 is skipped if the container has no IPv6.
 * @param {{ listen: number, host: string, port: number }} forward
 */
async function startForward({ listen, host, port }) {
  const bound = [];
  for (const address of ['127.0.0.1', '::1']) {
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
    server.listen(listen, address);
    try {
      await once(server, 'listening'); // rejects if 'error' fires first
      bound.push(address.includes(':') ? `[${address}]` : address);
    } catch (error) {
      if (address === '::1' && error?.code === 'EADDRNOTAVAIL') continue;
      throw error;
    }
  }
  console.log(`entrypoint: forwarding ${bound.join(', ')} :${listen} → ${host}:${port}`);
}

if (spec) {
  for (const entry of spec.split(',').filter((part) => part.trim())) {
    await startForward(parse(entry));
  }
}

await import('./apps/web/server.js');
