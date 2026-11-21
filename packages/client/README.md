# @oat/client

Private, browser-safe TypeScript client for Oat's REST API (D-37). No Node, Next or Electron runtime
dependencies. Shared DTOs are imported as types from `@oat/services/dto/*` and `@oat/core`; normal
requests/responses are not runtime-validated. Dates on the wire are ISO strings, including calendar events.

## Transports

```ts
import { createOatClient, fetchTransport } from '@oat/client';

const oat = createOatClient(fetchTransport());
// Defaults: baseUrl: '', fetch: globalThis.fetch, credentials: 'same-origin'.
// Tests or cross-origin hosts can inject fetch, baseUrl and credentials.
const { workspaces, activeWorkspaceId } = await oat.workspaces.list();
if (activeWorkspaceId) {
  const notes = await oat.documents.list({ workspaceId: activeWorkspaceId });
}
```

Add `"@oat/client": "workspace:*"` to a consumer's dependencies. There is no build step; like
`@oat/services`, exports point at TypeScript source. Web UI wiring is deliberately deferred.

`OatTransport` takes `{method, path, query?, body?, signal?, stream?}` and resolves
`{status, headers?, json(), body?}`. Paths are `/api/...` without a query; query values are strings,
numbers or booleans (null/undefined omitted). Bodies are JSON. Streaming transports must provide the
raw `ReadableStream<Uint8Array>` and response headers (especially AI SDK stream headers and export
content type). The same methods can use a future desktop bridge transport. The main process will attach
the Keychain bearer token; the renderer must never receive it. This package does not implement auth.

## Methods

ID arguments are positional; request bodies/queries use shared DTOs; the final argument accepts
`{signal?: AbortSignal}`. Each HTTP method has `.endpoint = {method, path}` metadata with bracketed
path parameters for the route inventory test.

- `documents`: list, get, create, update, delete (trash), deleteForever, restore, move, sharing,
  updateSharing, meeting, addParticipant, removeParticipant, pipeline, runPipeline, notion, pushToNotion.
- `folders`: tree (flat parentId-linked tree), create, update, move, delete.
  The server removes folders immediately and trashes their notes; there is **no folder restore route**.
  Restore individual notes with `documents.restore` (at the workspace root).
- `enhancements`: enhance, latest, list, get, restore, stream.
- `templates`: list, get, create, duplicate, update, delete.
- `tasks`: list, update, assignees.
- `chat`: send, threads, thread (includes messages/sources), decideProposal.
- `search(query)`; `profile`: get, update; `pipeline`: settings, updateSettings.
- `notion`: status, targets, target, disconnect, connectUrl.
- `calendar`: upcoming, notes; `calendar.google`: status, disconnect.
- `workspaces`: list, create, switchActive, get, update, delete, leave, members, updateMember,
  removeMember, invites, invite, resendInvite, revokeInvite, setJoinPolicy, allowMyDomain, removeDomain,
  joinRequests, approveJoinRequest, declineJoinRequest, join, requestAccess, createMy, joinable, export.
- `invites`: accept, decline.

`notion.connectUrl()` returns the OAuth **POST form action** path. Submit a browser form containing
`workspaceId`; the server redirects the browser to Notion. Do not GET this path or send it through
a JSON transport. OAuth callback is browser-owned too. Auth/sign-in, STT credentials, sync, and health
are intentionally outside this feature client.

## Errors

```ts
import { OatApiError } from '@oat/client';

try {
  await oat.documents.get('document-id');
} catch (error) {
  if (error instanceof OatApiError) {
    console.error(error.status, error.code, error.message);
  }
}
```

Client HTTP failures throw `OatApiError`, parsing `{error:{code,message}}`. Malformed/non-JSON errors
use `http_error`; `details` preserves additional data such as a stale-version server document.
Offline/transport failures use status `0`, code `unavailable`. Cancellation preserves `AbortError`
(or the signal's explicit reason). HTTP 204 resolves to `undefined`; JSON null remains null.

## Streams and cancellation

```ts
import { readSse, toFetch } from '@oat/client';

const abort = new AbortController();
const stream = await oat.enhancements.stream(
  'enhancement-id',
  { lastEventId: '1-0' },
  { signal: abort.signal },
);
for await (const event of readSse(stream, { signal: abort.signal })) {
  const payload = JSON.parse(event.data); // EnhanceEvent from @oat/services/dto/enhance
  console.log(event.event, event.id, payload);
}
// abort.abort() cancels a pending HTTP request/read.
// Leaving readSse/readLines early cancels the reader and releases its lock.
```

Enhancement SSE uses event/type, JSON data, and resumable ids; it ends after completed/failed.
`readLines` handles chunked UTF-8 and CR/LF/CRLF; `readSse` handles comments/multiline data.

`chat.send(input, {signal})` returns a native streaming `Response`.
`workspaces.export(id, {signal})` also returns a `Response` (binary ZIP and download headers preserved).

For AI SDK `DefaultChatTransport`/`useChat`, pass `toFetch(transport)` as its custom fetch:

```ts
// new DefaultChatTransport({ api: '/api/chat', fetch: toFetch(desktopBridgeTransport) })
```

`toFetch` accepts API path strings, URL objects and Request objects, with RequestInit overrides.
It only dispatches `/api/*` paths, supported methods and JSON bodies. Absolute HTTP URLs are reduced
to their API path; the transport controls the actual origin. Custom headers, credentials and other
RequestInit policies cannot cross the deliberately minimal transport contract; authentication belongs
to the transport. Repeated query keys and non-JSON bodies are rejected. Unlike typed client methods,
HTTP failures remain Responses (fetch/AI SDK semantics); offline failures reject with `OatApiError`.

## Adding an endpoint

1. Read the route handler's method, schema, query conventions and actual response.
2. Put missing wire types in `@oat/services/dto` (move/re-export app-only types, don't duplicate them).
3. Add an `endpoint<Result>()(method, path, inputMapper)` method in `src/client.ts`; use `response`
   or `stream` mode for raw bodies. Keep DTO imports type-only.
4. Add mapping/result/error tests. The route inventory test checks every non-skipped route **and method**
   against the actual client functions' metadata. OAuth redirect exceptions are explicit.
5. Run `pnpm --filter @oat/client test` and `pnpm run ci --fast`.

Workspace scripts are discovered by Turbo/CI automatically. The client test task also hashes the web
route files so route-inventory results cannot be reused from a stale Turbo cache.
