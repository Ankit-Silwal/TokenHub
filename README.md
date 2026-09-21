# TokenHub

A permission-based AI lending platform. Next.js frontend, Node.js / TypeScript backend, PostgreSQL persistence, and Codex CLI chat.

## Workspace
- `frontend/` — Next.js App Router, React and TypeScript.
- `backend/` — Express API, PostgreSQL schema, authentication, access grants and Codex integration.
- PostgreSQL handles session storage, rate limits and concurrency. Redis is not required.

## Local setup

Requires Node.js 22.12+ and PostgreSQL 17 (or Docker).
```sh
npm install
cp backend/.env.example backend/.env
docker compose up -d
npm run db:migrate
npm run dev
```
Generate a 32-byte encryption key using the command in `backend/.env.example` and put it in `backend/.env`. Open http://localhost:3000.

If Docker is unavailable, set `EMBEDDED_DB=true` for local development. This uses persistent PGlite (PostgreSQL compiled to WASM). Production uses the regular PostgreSQL driver.

## Milestones
1. Separate frontend/backend workspaces, database and credential security.
2. Lending, approval, one-time access codes, Codex chat and UI.
3. Integration tests, browser verification, and deployment documentation.
