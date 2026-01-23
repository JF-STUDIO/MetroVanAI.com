# Metrovan AI Photography Studio

Monorepo structure:
- client: Vite + React frontend
- server: Node/Express backend

Prerequisites:
- Node.js
- pnpm (recommended)

Install dependencies:
```
pnpm install
```

Run locally:
```
pnpm dev:client
pnpm dev:server
```

Build for production:
```
pnpm build
pnpm build:server
```

Environment:
- Configure frontend env in `client/.env.local` as needed.
- Configure backend env in `server/.env` (or similar) as needed.
