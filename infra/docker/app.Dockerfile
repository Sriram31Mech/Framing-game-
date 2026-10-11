# syntax=docker/dockerfile:1.7
#
# Bharat Harvest application image: API server (serves the built client), simulation worker and a
# one-shot migration entrypoint, all in one image.
#
#   docker build -f infra/docker/app.Dockerfile -t bharat-harvest/app .
#
#   server  (default): node apps/server/dist/main.js
#   worker           : node apps/worker/dist/main.js
#   migrate          : node packages/core/dist/migrate.js
#   seed (one-off)   : node packages/core/dist/seed.js
#
# Build stages run on the build host's platform (the output is plain JS); only the production
# dependency install runs on the target platform, so `--platform linux/amd64,linux/arm64` works.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------------------------
# base: Node + pnpm (via corepack, version pinned by package.json "packageManager")
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------------------------
# manifests: just package.json files + lockfile, so dependency layers only rebuild when they change
FROM base AS manifests
COPY . /src
RUN mkdir -p /out \
 && cd /src \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out/ \; \
 && cp pnpm-lock.yaml pnpm-workspace.yaml /out/

# ---------------------------------------------------------------------------------------------
# deps: full (dev) dependency install for building
FROM base AS deps
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------
# build: bundle server/worker with esbuild (scripts/build-node.mjs), client with Vite,
# and bundle the migration CLI so the runtime image needs no tsx/TypeScript.
FROM deps AS build
COPY . .
RUN pnpm -r build
RUN cd packages/core \
 && node ../../scripts/build-node.mjs src/db/migrate-cli.ts dist/migrate.js \
 && if [ -f src/db/seed-cli.ts ]; then \
      node ../../scripts/build-node.mjs src/db/seed-cli.ts dist/seed.js; \
    fi

# ---------------------------------------------------------------------------------------------
# prod-deps: production-only node_modules for the external (non-bundled) runtime dependencies of
# server + worker (fastify & plugins, pg, pino, prom-client, zod …), installed from the frozen
# lockfile for just those projects. `shamefully-hoist` exposes every installed package at
# /app/node_modules so bundles in apps/*/dist and packages/core/dist can resolve externals that
# came from workspace packages (e.g. zod via @bh/core). Runs on the TARGET platform in case a
# dependency ships native binaries. Workspace packages (@bh/*) are compiled into the bundles, so
# their node_modules links are dropped.
FROM ${NODE_IMAGE} AS prod-deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=pnpm-store-prod,target=/pnpm/store \
    printf 'shamefully-hoist=true\n' > .npmrc \
 && pnpm install --prod --frozen-lockfile --ignore-scripts \
      --filter '@bh/server...' --filter '@bh/worker...' \
 && rm -rf node_modules/@bh apps/*/node_modules/@bh packages/*/node_modules/@bh \
 && mkdir -p apps/server/node_modules apps/worker/node_modules packages/core/node_modules

# ---------------------------------------------------------------------------------------------
# runtime
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="bharat-harvest" \
      org.opencontainers.image.description="Bharat Harvest API server, simulation worker and web client" \
      org.opencontainers.image.source="https://github.com/Sriram31Mech/Framing-game-" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV NODE_ENV=production \
    APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MIGRATIONS_DIR=/app/migrations \
    SERVE_CLIENT_DIR=/app/client \
    GIT_SHA=${GIT_SHA} \
    NODE_OPTIONS=--enable-source-maps

# Package managers are not needed at runtime; removing them shrinks the image and attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

WORKDIR /app
# Everything is root-owned and read-only for the `node` user that runs the processes.
COPY package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY apps/server/package.json ./apps/server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/apps/client/dist ./client
COPY infra/migrations ./migrations

USER node
EXPOSE 8080

# Liveness of the API server. The worker/migrate services override this in compose.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
