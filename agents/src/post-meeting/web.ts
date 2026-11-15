/**
 * The spike's one seam into apps/web (8.2): the enhance job (D-20/D-26: one run per note, idempotency keys,
 * version-checked apply, Redis event log for the note's SSE readers) and "Send to Notion" (8.1: the sender's
 * own connection, `document_export` lease, re-push updates the same page) are server modules of the web app.
 * The post-meeting steps reuse them as they are, instead of re-implementing their rules.
 *
 * 8.3 moves these services into a workspace package (both the web routes and the agents import it) and this
 * file, the `@/` path mapping in tsconfig.json and the alias in vitest.config.ts go away.
 */
export { loadActor, type Actor } from '../../../apps/web/src/server/actor.ts';
export { ApiError } from '../../../apps/web/src/server/api/errors.ts';
export {
  createRedisBroker,
  type EnhanceBroker,
} from '../../../apps/web/src/server/enhance/broker.ts';
export {
  type EnhanceDeps,
  startEnhancement,
} from '../../../apps/web/src/server/enhance/service.ts';
export { type NotionDeps, sendToNotion } from '../../../apps/web/src/server/notion.ts';
