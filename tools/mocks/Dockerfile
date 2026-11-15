# @oat/mocks image. Build context is the repo root (see docker-compose.yml), so the pnpm lockfile and
# catalog are available. Stage 1 installs and bundles with esbuild; stage 2 ships one JS file, no node_modules.

FROM node:24.22.3-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY tools/mocks/package.json tools/mocks/
RUN pnpm install --frozen-lockfile --filter @oat/mocks
COPY tools/mocks/ tools/mocks/
# The stt provider bundles fixture ground truth (mock_fixture=<name>); esbuild inlines these JSON files.
COPY fixtures/audio/*.segments.json fixtures/audio/
RUN pnpm --filter @oat/mocks build

FROM node:24.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MOCKS_HOST=0.0.0.0 \
    MOCKS_PORT=14010
COPY --from=build /repo/tools/mocks/dist/main.js ./main.js
USER node
EXPOSE 14010
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1:14010/health >/dev/null || exit 1
CMD ["node", "main.js"]
