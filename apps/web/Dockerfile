# @oat/web images (1.9, D-11). Build context is the repo root (see docker-compose.yml, profile `app`):
#   docker build -f apps/web/Dockerfile .                  → target `web`: Next standalone server, :3000
#   docker build -f apps/web/Dockerfile --target migrate .  → one-shot `@oat/db` migrations
#
# Layer caching: dependencies are installed from the workspace manifests + lockfile only (stage
# `manifests`), so source edits reuse the install layer; the pnpm store is a BuildKit cache mount, so even
# a lockfile change only downloads what is new.

FROM node:24.22.3-alpine AS base
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# Every package.json in the workspace plus the lockfile, nothing else. This stage re-runs on any change in
# the context, but its output only changes when a manifest does, so `COPY --from=manifests` stays cached.
FROM base AS manifests
COPY . /context
RUN cd /context \
  && find . -name package.json -not -path '*/node_modules/*' > /tmp/manifests \
  && echo pnpm-lock.yaml >> /tmp/manifests \
  && echo pnpm-workspace.yaml >> /tmp/manifests \
  && mkdir /manifests \
  && tar -cf - -T /tmp/manifests | tar -xf - -C /manifests

# --- web ---------------------------------------------------------------------------------------------------

FROM base AS web-deps
COPY --from=manifests /manifests ./
# `@oat/web...` = the app and the workspace packages it depends on (TS source, D-15), with dev deps
# (TypeScript, Tailwind) because `next build` needs them.
RUN --mount=type=cache,id=oat-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --filter '@oat/web...'

FROM web-deps AS web-build
# Root configs the app tsconfig pulls in (next build type-checks the whole `apps/web` project).
COPY tsconfig.base.json eslint.config.js vitest.shared.ts ./
COPY packages/ packages/
# Workspace deps outside packages/: the app's e2e + int tests (type-checked by `next build`) import them.
COPY tools/mocks/ tools/mocks/
COPY agents/ agents/
# Ground-truth JSON that @oat/mocks imports (audio binaries are excluded by .dockerignore).
COPY fixtures/ fixtures/
COPY apps/web/ apps/web/
RUN pnpm --filter @oat/web build

FROM node:24.22.3-alpine AS migrate-deps
WORKDIR /repo
RUN corepack enable
COPY --from=manifests /manifests ./
RUN --mount=type=cache,id=oat-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter '@oat/db...'
COPY packages/ packages/

# --- migrate: `node packages/db/src/cli/migrate.ts` with Node's built-in type stripping -------------------
# @oat/db is TS source with `.ts` imports and erasable syntax only (verbatimModuleSyntax), so plain Node runs
# the same CLI as `pnpm --filter @oat/db db:migrate`, against `DATABASE_URL`. Prod deps only.
FROM node:24.22.3-alpine AS migrate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=migrate-deps /repo ./
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/db/src/cli/migrate.ts"]

# --- web runtime (default target, keep it last) -----------------------------------------------------------
# Only Next's standalone output: server.js + the traced subset of node_modules (workspace packages are
# compiled into the server chunks). Runs as the unprivileged `node` user.
FROM node:24.22.3-alpine AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node docker/web/entrypoint.mjs ./entrypoint.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "entrypoint.mjs"]
