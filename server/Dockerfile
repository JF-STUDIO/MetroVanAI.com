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

RUN pnpm install --prod=false --filter ./server...

COPY server ./server

WORKDIR /app/server
RUN pnpm run build

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
