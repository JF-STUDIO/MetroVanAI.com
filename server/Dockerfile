FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    hugin-tools \
    enblend \
    dcraw \
    imagemagick \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/tsconfig.json ./server/

# Fix pnpm build script policy and install deps
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm config set dedup-peer-dependents false
RUN pnpm install --frozen-lockfile --filter ./server...

COPY server ./server

WORKDIR /app/server
# Increase memory limit for TSC
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN pnpm run build && rm -rf node_modules

FROM node:22-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    hugin-tools \
    enblend \
    dcraw \
    imagemagick \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/server/node_modules ./server/node_modules
COPY --from=base /app/server/package.json ./server/package.json
COPY --from=base /app/server/dist ./server/dist

ENV NODE_ENV=production

WORKDIR /app/server
CMD ["node", "dist/index.js"]
