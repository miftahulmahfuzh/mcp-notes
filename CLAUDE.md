# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`notesd`, a local daemon (Hono on `127.0.0.1:7317`) that serves one Postgres-backed notes store three ways: an MCP server at `/mcp` for Claude Code, a JSON/SSE API at `/api`, and the React "wall" web app at `/`. `README.md` is the short overview; the detail lives in one guide per subsystem under `docs/guide/`. Read the guide before changing a subsystem:

| Changing | Read first |
| --- | --- |
| The wall, notes, photos, files, recycle bin | `docs/guide/wall.md` |
| MCP server, `/n`, hooks, the `note-links` mod | `docs/guide/claude-code.md` |
| Search, embeddings, `similar_images` | `docs/guide/search.md` |
| Chat bar, chat history | `docs/guide/chat.md` |
| Session graph (`/projects`), ingest, context rot | `docs/guide/sessions.md` |
| Connectors, daily-words (`/v`, `/j`) | `docs/guide/connectors.md` |
| Seer Adversarial (`/adversary`) | `docs/guide/adversary.md` |
| Movies (`/movies`), VLC | `docs/guide/movies.md` |
| Wiring, data model, disk layout, limitations | `docs/guide/architecture.md` |
| Install, tests, docs tooling | `docs/guide/install.md` |
| Tools, routes, settings | `docs/guide/reference/{mcp-tools,http-api,configuration}.md` |

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
npm run docs:gen             # regenerate docs/guide/reference/{mcp-tools,http-api}.md from the code
npm run docs:check           # stale reference, undocumented route or env var, broken link, unused picture
npm run docs:shots -- wall   # retake a guide's pictures from a throwaway daemon (scripts/docs/shots/<guide>.mjs)
scripts/install.sh           # idempotent: build, systemd user unit, MCP registration, skills, hooks
```

- There is a single `vitest.config.ts`; env flags switch which suite runs (integration, `test:live*`). Do not add a second config. Live tests are opt-in, billed, and never part of `npm test` or `test:int`.
- Web test files opt into jsdom with a `// @vitest-environment jsdom` first-line pragma.
- Embeddings in `npm test` / `test:int` come from deterministic fakes, with no network calls.
- Config lives in `.env.local` (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY`). Every variable is in `docs/guide/reference/configuration.md`.
- Node >= 22.22 (`.nvmrc`). ESM throughout; server imports use `.js` suffixes.

## Docs are checked against the code

`tests/unit/docs/reference.test.ts` (same checks as `npm run docs:check`) fails `npm test` on drift. In the same change as the code:

- **New or changed MCP tool:** `npm run docs:gen`.
- **New or changed HTTP route:** describe it in `scripts/docs/httpRoutes.ts`, then `npm run docs:gen`.
- **New environment variable:** add a row to `docs/guide/reference/configuration.md` (a name that is not a setting goes in `scripts/docs/envVars.ts` with a reason).
- **Changed behaviour:** update the subsystem's guide. Never hand-edit the two generated reference files, and never copy tool, route or env tables into a guide or the README.
- **Changed UI:** retake the pictures with `npm run docs:shots -- <guide>`. Pictures come only from the throwaway daemon with seeded data, never from the live one. A picture nothing shows fails the test.
- Keep `README.md` short: one line per subsystem and a link. Detail goes in the guide.

## Architecture

The rules that are easy to break. The guides have the rest.

- **One notes service is the only writer.** `src/notes/service.ts` writes the revision in the same transaction as every body change and emits an event on `src/notes/events.ts`. HTTP routes (`src/http/*`), MCP tools (`src/mcp/*`) and the chat agent all go through it. The web app listens on `/api/events` (SSE) and re-fetches; it also polls every 5 minutes while visible, and on focus when the last load is older than 60 s, to pick up edits from the other machine.
- **Wiring:** `src/main.ts` / `src/daemon.ts` build `AppDeps` (`src/deps.ts`) and hand it to routes and background jobs (`src/background.ts`).
- **Notes are one plain-text body.** No title or fields. Tags are `#hashtags` re-parsed from the body on every write (`src/notes/tags.ts`). Deletes (notes, images, files) are soft; hard delete exists only in the wall's recycle bin (`src/notes/binRepo.ts`, same-origin-only routes).
- **Two machines share the database, not the disk.** Photos, files, transcripts and videos live on one host and are recorded with it. Anything made on the other machine reports `available: false` / 404 `not_on_this_machine`. Handle that in new image, file, session or movie code, and in the UI.
- **Images are never re-encoded.** Originals stay byte for byte; thumb/display/preview are derived copies (`src/images/derive.ts`). HEIC is kept as HEIC with a JPEG made for viewing.
- **Search is hybrid** (`src/search/blend.ts` holds the weights). Embedding happens in the background after a write commits and never blocks or fails a save. Vectors are keyed to the sha256 of the body they came from. Without `OPENROUTER_API_KEY`, search degrades to full text and reports `fallback`.
- **Chat bar** (`src/chat/*`) runs on the Claude Agent SDK, with GLM as fallback (`CHAT_BRAIN`). Its tool allow list is `allowedChatTools` in `src/chat/status.ts`. Threads and messages are persisted, and `/n` exchanges are saved by the capture hook via `POST /api/capture/claude-code`.
- **Connectors** (`src/connectors/*`: expenses, runs, seer, dword) find the owner's other apps through sibling repos' `.env.local` (`EXPENSE_TRACKING_DIR`, `RUN_INSIGHTS_DIR`, `SEER_DIR`, `DAILY_WORDS_DIR`). `guard.ts`/`sql.ts` enforce read-only SQL; daily-words alone has a narrow write path (`src/dword/*`). Their integration tests rebuild each schema from the sibling repos' migrations and skip a repo that is missing.
- **Claude Code sessions** (`src/sessions/*`): a background ingester tails `~/.claude/projects/**/*.jsonl` from stored byte offsets. `SessionsRepo` (`src/sessions/repo.ts`) is the only writer of the session tables.
  - Parent links have a source, `fork` > `env` > `hook` > `heuristic`; a worse source never overwrites a better one.
  - A fork starts with a copy of its parent's records. Every reader of a transcript skips records that have a uuid and start before `fork_cut_offset` (`isCopiedRecord`); records without a uuid are always read.
  - Stored replies are the assistant text after a turn's last tool call only, redacted and capped; a turn split across reads must store what one read would.
  - Backfills run once per host behind a version constant (`REPLIES_VERSION`, `FORK_BACKFILL_VERSION`). A session vector is current only at `SESSION_EMBED_TEXT_VERSION`: bump it when `buildEmbedText` changes.
  - To add search context, write one `CandidateSource` (`src/sessions/search.ts`).
  - Transcripts, `session_transcript` and resume work only on the owning host. Every path (`CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SWARM_SCRIPT`, tmux, claude bin) is injectable, and tests never touch the real `~/.claude`.
- **Seer Adversarial** (`src/adversary/*`) writes Claude's verdicts, `paused` marks and leases into Seer's DB through `seerWriter.ts` only (a table allow-list; the connector guard stays read-only). `adversary_reviews` is written only by `reviewsRepo.ts`. Only verdicts decided before the session's open count. `NOTESD_ADVERSARY=off` starts nothing; tests use `DEFAULT_ADVERSARY_CONFIG` (off).
- **Movies** (`src/movies/*`): `MoviesRepo` (`src/movies/repo.ts`) is the only writer of the `movie_*` tables; the review is a normal note written through `NotesService`.
  - Titles are shared and never deleted with their files; files are per host and soft-deleted; play events are never deleted.
  - Watch state is derived at read time by `state.ts` only. Never store it.
  - The roots are polled, never watched (`/mnt/c` is drvfs and sends no inotify events).
  - Play starts the Windows `vlc.exe` and reads its status with Windows `curl.exe` (WSL NAT cannot reach Windows loopback). Never reuse or kill a VLC notesd did not start.
  - `NOTESD_MOVIES=off` or no roots starts nothing; tests use `DEFAULT_MOVIES_CONFIG` (off) and inject every path and binary.
- **Claude Code integration lives in `claude/`:** skills (symlinked into `~/.claude/skills` by `install.sh`), six hooks (`claude/hooks/notes-capture|link|paste|prompt|session|spawn.mjs`, merged into `~/.claude/settings.json` by `scripts/claude-hooks.mjs`; `notes-prompt` must stay I/O-free when no node id matches), and the `note-links` mod (own tsconfig and tests).
- **Web app** (`web/`, Vite + React 19, Phosphor icons) is built to `web/dist` and served statically by the daemon; `web/fullscreen.html` is the separate full-screen photo page (`/full/:imageId`).
- **DB:** Drizzle schema in `src/db/schema.ts`, SQL migrations in `drizzle/`. The pooled Neon host is used by the daemon, the direct host by migrations; a non-Neon URL goes through `node-postgres`.

## Conventions

- **Ids are generated, never invented.** Note ids (`A-B32`, `src/notes/ids.ts`) and session node ids (`A0-3G`, `src/sessions/ids.ts`) come from the server; movie ids (`M-23T4`) come from database triggers, never application code. Note lookup is case-insensitive and tolerates a missing dash.
- **Proving a change:** `.claude/skills/verify-notesd` launches a throwaway daemon (own DB, port, data dir) and drives it over HTTP, MCP and Playwright, saving evidence. Its `features/` map lists what proves each feature. Use it before calling a change done; update the map when a user-facing feature changes.
- `.workflows/` holds task/plan/orchestration records from the planning tooling, and `docs/plans/`, `docs/iterations/` hold design briefs. Check them for the intent behind a feature before changing it.

> [!IMPORTANT]

> when user type in "p" : you must commit and push your work in a new subagent. you also need to rebuild and restart daemon. USE haiku model for this task.
