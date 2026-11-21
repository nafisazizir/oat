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
content type). The desktop bridge transport below uses the same methods for JSON/text APIs. Main attaches
the Keychain bearer token; the renderer never receives it. This package does not implement auth.

## Desktop bridge transport

`@oat/client/bridge` exports `bridgeTransport(oat)`, structurally typed against the invoke/subscribe
portion of `OatBridge` (type-only core imports, no Electron dependency):

```ts
import { createOatClient } from '@oat/client';
import { bridgeTransport } from '@oat/client/bridge';

const transport = bridgeTransport(window.oat);
const client = createOatClient(transport);
// AI SDK: new DefaultChatTransport({ api: '/api/chat', fetch: toFetch(transport) })
```

Main owns authentication and the Keychain token. The renderer receives only JSON results or UTF-8
stream events. Main matches methods/paths against the exported `apiRoutes` inventory, rejects ambiguous
paths/unsafe IDs, disables redirects, and returns only safe stream headers. Sign-out or owner
destruction/navigation aborts its streams. No feature UI is wired to the ready desktop renderer client.

HTTP failure envelopes still become `OatApiError`; bridge unauthorized/forbidden map to 401/403,
offline/unavailable to status 0. Subscriptions are installed before opening, so early chunks cannot be
lost. Reader cancellation or AbortSignal abort sends stream-cancel and unsubscribes. If aborted while
stream-open is still waiting for HTTP headers, the renderer stops waiting immediately and sends cancel
when the stream id arrives; the protocol cannot cancel a not-yet-returned id. Plain-request abort also
stops renderer waiting; main retains its existing ten-second timeout.

The specified bridge carries text, not binary: main refuses ZIP/binary streaming responses rather than
corrupting bytes through UTF-8. Workspace export remains available through the web/fetch transport;
desktop binary download support needs a separate binary/file-download contract.

## Feature methods

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
