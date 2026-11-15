# @oat/agents image (8.3, D-29). Build context is the repo root (see docker-compose.yml, profile `app`):
#   docker build -f agents/Dockerfile .
#
# Builds the eve app (`agent:build`: telemetry off, no model-catalog fetch, D-11) and runs `eve start` through
# `agents/src/cli/serve.ts`, which first creates/migrates the Workflow world's own database. Workspace packages
# are TS source, so the serve script runs on Node's TypeScript support (`--experimental-transform-types`, like the
# index worker); the eve server itself runs from its build output.

FROM node:24.22.3-alpine AS base
WORKDIR /repo
RUN corepack enable

# Every package.json in the workspace plus the lockfile, nothing else (same trick as apps/web/Dockerfile).
FROM base AS manifests
COPY . /context
RUN cd /context \
  && find . -name package.json -not -path '*/node_modules/*' > /tmp/manifests \
  && echo pnpm-lock.yaml >> /tmp/manifests \
  && echo pnpm-workspace.yaml >> /tmp/manifests \
  && mkdir /manifests \
  && tar -cf - -T /tmp/manifests | tar -xf - -C /manifests

# eve's CLI and the build helpers (tsx) are needed at build time; the serve script needs eve's CLI at runtime.
FROM base AS build
COPY --from=manifests /manifests ./
RUN --mount=type=cache,id=oat-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --filter '@oat/agents...'
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY agents/ agents/
ENV EVE_TELEMETRY_DISABLED=1
RUN pnpm --filter @oat/agents agent:build

FROM node:24.22.3-alpine AS agents
WORKDIR /repo
ENV NODE_ENV=production \
    EVE_TELEMETRY_DISABLED=1 \
    OAT_AGENTS_HOST=0.0.0.0 \
    OAT_AGENTS_PORT=3100
# Owned by `node`: eve writes its runtime state (traces, caches) under agents/.eve.
COPY --from=build --chown=node:node /repo ./
COPY --chown=node:node docker/agents/entrypoint.mjs ./entrypoint.mjs
USER node
EXPOSE 3100
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD wget -qO- http://127.0.0.1:3100/eve/v1/health >/dev/null || exit 1
CMD ["node", "entrypoint.mjs"]
