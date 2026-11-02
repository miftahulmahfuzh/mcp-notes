# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`notesd`, a local daemon (Hono on `127.0.0.1:7317`) that serves one Postgres-backed notes store three ways: an MCP server at `/mcp` for Claude Code, a JSON/SSE API at `/api`, and the React "wall" web app at `/`. See `README.md` for the full tour, HTTP API and MCP tool tables.

## Commands

```sh
npm run dev                  # daemon with reload (tsx watch src/main.ts)
npm run dev:web              # Vite dev server for web/, proxied to the daemon
npm run build && npm start   # tsc server build + vite build, then node dist/main.js
npm run typecheck            # server (tsconfig.json) AND web (tsconfig.web.json)
npm test                     # unit tests: tests/unit/** (node) + web/src/**/*.test.tsx (jsdom)
npx vitest run tests/unit/path/file.test.ts         # one file
npx vitest run -t "name fragment"                   # one test by name
npm run test:int             # integration tests against pgvector Postgres in Docker (scripts/test-int.sh)
npm run db:generate          # new drizzle migration after editing src/db/schema.ts
npm run db:migrate           # apply migrations (uses the unpooled URL)
scripts/install.sh           # idempotent: build, systemd user unit, MCP registration, skills, hooks
```

- There is a single `vitest.config.ts`; env flags switch which suite runs (integration, `test:live*`). Do not add a second config. Live tests are opt-in, billed, and never part of `npm test` or `test:int`.
- Web test files opt into jsdom with a `// @vitest-environment jsdom` first-line pragma.
- Embeddings in `npm test` / `test:int` come from deterministic fakes, with no network calls.
- Config lives in `.env.local` (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY`). Env var table is in `README.md`.
- Node >= 22.22 (`.nvmrc`). ESM throughout; server imports use `.js` suffixes.

## Architecture

- **One notes service is the only writer.** `src/notes/service.ts` writes the revision in the same transaction as every body change and emits an event on `src/notes/events.ts`. HTTP routes (`src/http/*`), MCP tools (`src/mcp/*`) and the chat agent all go through it. The web app listens on `/api/events` (SSE) and re-fetches, and also polls every 60s to pick up edits from a daemon on another machine.
- **Wiring:** `src/main.ts` / `src/daemon.ts` build `AppDeps` (`src/deps.ts`: config, db, events, service, optional embedder/imageEmbedder, chat) and hand it to routes and background jobs (`src/background.ts`).
- **Notes are one plain-text body.** No title or fields. Tags are `#hashtags` re-parsed from the body on every write (`src/notes/tags.ts`). Deletes (notes, images, files) are soft; hard delete exists only in the wall's recycle bin (`src/notes/binRepo.ts`, same-origin-only routes).
- **Two machines share the database, not the disk.** Photos and files live under `NOTES_DATA_DIR` (default `~/mcp-notes-data`) and are recorded with a host. Anything made on another machine reports `available: false` / 404 `not_on_this_machine`. Handle that in new image or file code, and in the UI.
- **Images are never re-encoded.** Originals stay byte for byte; thumb/display/preview are derived copies (`src/images/derive.ts`). HEIC is kept as HEIC with a JPEG made for viewing. The `~/mcp-notes-data/inbox` folder is watched for ingest.
- **Search is hybrid.** Full text (Postgres `simple` config) blended with pgvector similarity, tag match and recency; weights are in `src/search/blend.ts`. Embedding happens in the background after a write commits and never blocks or fails a save. Vectors are keyed to the sha256 of the body they came from. Without `OPENROUTER_API_KEY`, search degrades to full text and reports `fallback`. Image embeddings (`src/embeddings/image*`) back `similar_images`.
- **Chat bar** (`src/chat/*`) runs on the Claude Agent SDK, with GLM as fallback (`CHAT_BRAIN`). Chat threads and messages are persisted (`drizzle/0006_chat_history.sql`), and `/n` exchanges are saved by the capture hook via `POST /api/capture/claude-code`.
- **Connectors** (`src/connectors/*`: expenses, runs, seer) expose read-only `*_schema`, `*_sql` and curated tools against the user's other apps' databases, found through sibling repos' `.env.local` (`EXPENSE_TRACKING_DIR`, `RUN_INSIGHTS_DIR`, `SEER_DIR`). `guard.ts`/`sql.ts` enforce read-only SQL. Their integration tests rebuild each schema from the sibling repos' migrations and skip a repo that is missing.
- **Claude Code integration lives in `claude/`:** the `/n` and `/migrate` skills (symlinked into `~/.claude/skills` by `install.sh`), hooks (`claude/hooks/notes-capture|paste|prompt.mjs`, merged into `~/.claude/settings.json`), and the `note-links` mod (has its own tsconfig and tests).
- **Web app** (`web/`, Vite + React 19, Phosphor icons) is built to `web/dist` and served statically by the daemon; `web/fullscreen.html` is the separate full-screen photo page (`/full/:imageId`).
- **DB:** Drizzle schema in `src/db/schema.ts`, SQL migrations in `drizzle/`. The pooled Neon host is used by the daemon, the direct host by migrations; a non-Neon URL goes through `node-postgres`.

## Conventions

- Note ids look like `A-B32`; lookup is case-insensitive and tolerates a missing dash. Ids are generated server-side (`src/notes/ids.ts`). Never invent one.
- `.workflows/` holds task/plan/orchestration records from the planning tooling, and `docs/` holds roadmap and design briefs. Check them for the intent behind a feature before changing it.
