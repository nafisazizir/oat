# @oat/indexing worker image (6.1). Build context is the repo root (see docker-compose.yml, profile `app`):
#   docker build -f packages/indexing/Dockerfile .
#
# Runs `packages/indexing/src/cli/worker.ts` with Node's built-in TypeScript support (like the `migrate`
# image), so no build step: workspace packages are TS source with `.ts` imports. `--experimental-transform-types`
# rather than plain stripping, because some transitively imported files use non-erasable syntax (parameter
# properties in @oat/editor's Markdown parser). Production dependencies only, installed from the workspace
# manifests + lockfile (a source edit reuses that layer).

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

FROM base AS deps
COPY --from=manifests /manifests ./
RUN --mount=type=cache,id=oat-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter '@oat/indexing...'
COPY packages/ packages/

FROM node:24.22.3-alpine AS worker
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo ./
USER node
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "packages/indexing/src/cli/worker.ts"]
