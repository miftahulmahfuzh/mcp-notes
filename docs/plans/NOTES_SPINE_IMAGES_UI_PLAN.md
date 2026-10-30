# Plan: mcp-notes iterations 1–3 — Spine, Images, Web UI

**Slug:** notes-spine-images-ui
**Date:** 2026-10-30 09:20 WIB
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/notes-spine-images-ui`
**Branch:** `feature/notes-spine-images-ui` (base: `origin/main` @ `4bff8fb`, fast-forwarded to `30a58fd`)
**Phases:** 8
**Status:** planned
**Coordinator:** —

---

## Why

Verbatim from `docs/iterations/01-03-spine-images-ui.md` (the full text, with the included
`docs/iterations/01-spine.md`, is in the analysis document under "User Input"):

> Build mcp-notes iterations 1, 2 and 3 from docs/ROADMAP.md as one plan set. The "Fixed
> decisions" table in docs/ROADMAP.md is binding: do not re-decide anything in it.
>
> Out of scope: the real chat brain (iteration 4), connectors to expense-tracking / run-insights /
> seer (iteration 5), embeddings and semantic search (iteration 6), any image sync to the GPD, a
> title field or any typed note structure, a search bar.

From 01-spine.md:

> Later iterations add images, a web UI, a chat bar, connectors to my other systems and semantic
> search; this iteration builds the backbone they hang on, so leave clean seams for them but do
> not build them.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Spine: `notesd` (Hono, 127.0.0.1:7317, MCP streamable HTTP `/mcp`, `/health`), Neon schema via Drizzle, `A-B32` ids, `#hashtag` tags, `note_revisions`, MCP note tools, `/n` skill, systemd + install script + Windows Task Scheduler script, `claude mcp add --scope user`, vitest unit + integration tests | 1, 2, 3 |
| R2 | Images: byte-exact local store + sha256 dedupe + metadata, thumbnail / Claude preview / HEIC display derivatives, ingestion via HTTP upload, inbox folder, MCP tool; MCP image viewing + has_image/date filters; HTTP image serving; "not on this machine" fallback | 4, 5 |
| R3 | Web UI: the Claude Design as a Vite + React + TS SPA served by `notesd`, real API, 3-way note visibility (text only by default / images only / all), gallery, modal, full-screen tab, upload, inline edit, streaming `/api/chat` stub, live updates | 2 (repo `hasImage` option only), 6, 7, 8 |

Phase 1 also installs every dependency and creates every table/index R2 and R3 use; that is
infrastructure mandated by invariants 7 and 8, not R2/R3 behaviour, so it is not listed above.

## Scope

**In scope:** everything in R1–R3. The repo is greenfield.
**Out of scope:** chat brain (iteration 4), connectors (5), embeddings/semantic search (6), image
sync to the GPD, title field / typed note structure, search bar. `support.js` is never shipped.

## Invariants

1. **The ROADMAP "Fixed decisions" table is binding.** No phase re-decides anything in it.
2. Every phase ends with `npm run typecheck`, `npm test` and `npm run test:int` green (phase 1
   onward), and `npm run build` green (once it exists). No phase leaves the tree broken.
3. The daemon binds `127.0.0.1` only. Config refuses any other host.
4. One text field per note. No title, no typed structure. Tags are only `#hashtags` in the body,
   re-parsed on every write.
5. Every body change (update, append, revert, delete) writes the previous body to
   `note_revisions` in the same transaction as the change. Deletes are soft.
6. Image originals are written byte for byte and never modified. Derived files live only under
   `<data>/cache/` and can be deleted at any time and regenerated lazily.
7. **Schema is owned by phase 1 alone.** The single initial migration contains every table,
   column and index the set needs (including the image indexes). No later phase adds a migration.
8. **Dependencies are owned by phase 1 alone.** Phase 1 installs every runtime and dev dependency
   the whole set uses (server, images, web), pinned to exact versions checked with `npm view`.
   Later phases do not add dependencies or touch `package-lock.json`. Phase 7 is the only later
   phase that edits `package.json`, and only its `scripts`.
9. Integration tests run against a real Postgres. `npm run test:int` starts (or reuses) a
   dedicated Docker container `mcp-notes-pg-test` (`postgres:16`, host port 55433) and migrates
   it. Tests never touch the Neon database or the `seer-pg` container.
10. Phase sessions never bind port 7317 for their own runs. The installed daemon may be
    running there. Tests use port 0 / an in-process `app.request()`.
11. No phase writes to the real `~/mcp-notes-data` from tests. Tests use a temp data dir via
    `NOTES_DATA_DIR`.
12. UI controls are icon-only (Phosphor duotone, from `@phosphor-icons/react`) with the custom
    tooltip. No text on buttons.

## Seams (fixed by this index — the contract between phases)

- **Layout:** one root `package.json`. Server code in `src/`, compiled by `tsc -p tsconfig.server.json`
  to `dist/`. Entry `src/main.ts` → `dist/main.js`. Web app in `web/` (Vite root), built to `web/dist/`.
  Tests in `tests/unit/**`, `tests/integration/**`, and `web/src/**/*.test.tsx` (jsdom via the
  per-file `// @vitest-environment jsdom` pragma).
- **DB client** `src/db/client.ts`: `createDb(url): Db` picks `drizzle-orm/neon-serverless` (Pool + `ws`)
  for `*.neon.tech` hosts and `drizzle-orm/node-postgres` otherwise; `closeDb(db)` ends the pool.
  Both drivers support transactions. `drizzle.config.ts` migrates through the **direct** host only:
  of `DATABASE_URL_UNPOOLED` / `DATABASE_URL`, whichever host has no `-pooler` (the owner's
  `.env.local` has the two key names swapped; no phase edits that file).
- **Config** `src/config.ts`: loads `.env.local` from the repo root (resolved from the module's own
  location, not cwd), exposes `{ databaseUrl, port (7317), host ('127.0.0.1'), dataDir (~/mcp-notes-data) }`.
  `databaseUrl`: a real-env `DATABASE_URL` wins outright; otherwise the pooled one of
  `DATABASE_URL` / `DATABASE_URL_UNPOOLED`, else whichever exists. Env overrides: `NOTESD_PORT`,
  `NOTES_DATA_DIR`, `DATABASE_URL`.
- **Test DB helpers** `tests/integration/setup.ts` (P1): `openTestDb()`, `closeTestDb(db)`,
  `testDatabaseUrl()`, `migrateTestDb()`, `truncateAll(db)`. Integration files run serially
  (`fileParallelism: !integration` in `vitest.config.ts`).
- **Shared deps** `src/deps.ts` (P2): `AppDeps { config, db, events, service }`, handed to every router
  factory and to `startBackground`. MCP tools get `ToolDeps { service, dataDir, db }`.
- **Notes service** `src/notes/service.ts` (P2): `class NotesService`, the only writer (`create({ body, origin?, image?, allowEmpty?, id? })`,
  `newId`, `getOne`, `get`, `findBySha256`, `list`, `search`, `tags`, `revisions`, `update`, `append`, `delete`, `restore`, `revert`;
  failures are `NoteError { code }`). Every mutation emits `{ type: 'note', op: 'created'|'updated'|'deleted'|'restored', id }`
  on `NoteEvents` (`src/notes/events.ts`; `on(listener)` returns an unsubscribe). P4 ingestion and P6 SSE use this, never the
  repo's writers. P4's read-only image lookups (`image_path`, sha256) live in `src/images/records.ts`.
- **Wire `Note` shape** (`src/notes/types.ts`, P2), used by MCP, HTTP and UI:
  `{ id, body, tags, created_at, updated_at, deleted_at?, origin, image }` where `image` is `null`
  or `{ mime, width, height, bytes, taken_at, original_name, host, available }`. P2 already
  computes `image` from `image_path`/`image_meta` (`available` = the file exists under `dataDir`),
  so P5 and P6 never change the shape.
- **HTTP app** `src/http/app.ts` (P2) mounts, in order: `/health`, `/mcp`, `apiRoutes(deps)` from
  `src/http/api.ts`, `imageRoutes(deps)` from `src/http/images.ts`, then `staticRoutes(deps)` from
  `src/http/static.ts`. P2 creates the last three as empty router **factories** `(deps: AppDeps) => Hono`,
  so P5 (images.ts) and P6 (api.ts, static.ts) fill their own files and never edit `app.ts`.
- **MCP server** `src/mcp/server.ts` (P2) calls `registerNoteTools(server, deps)` from
  `src/mcp/tools.ts` and `registerImageTools(server, deps: ToolDeps)` from `src/mcp/imageTools.ts`. P2 ships
  `imageTools.ts` as a no-op. P5 fills it.
- **Daemon lifecycle** `src/daemon.ts` / `src/main.ts` (P2) start the HTTP server and then call
  `startBackground(deps: AppDeps)` from `src/background.ts`, which P2 ships as a no-op returning a stop
  function (awaited by `daemon.stop()`). P4 fills it with the inbox watcher.
- **Data dir:** `<dataDir>/images/YYYY/MM/<id>.<ext>`, `<dataDir>/cache/<id>/{thumb.webp,preview.jpg,display.jpg}`,
  `<dataDir>/inbox/` (+ `inbox/failed/`). Created at startup if missing.
- **HTTP contract:**
  - P6: `GET /api/notes` (all non-deleted notes, newest first, `?limit&cursor&has_image=true|false`, default limit 2000; `has_image` maps to the repo's `hasImage` option, which P2 owns),
    `GET /api/notes/:id`, `POST /api/notes {body}` (empty body allowed here), `PATCH /api/notes/:id {body}`,
    `DELETE /api/notes/:id`, `GET /api/tags` → `[{tag,count,last_used}]`, `GET /api/events` (SSE,
    `event: note` with `{op,id}`, 25 s heartbeat comment), `POST /api/chat {message, thread_id?}` →
    `text/event-stream` with `event: delta` `{text}` … `event: done` `{thread_id}`.
  - P5: `POST /api/images` (multipart: `file`, optional `body`) → `{ note, created }`;
    `GET /api/notes/:id/original` (original bytes, its mime, `Cache-Control: private, max-age=31536000, immutable`),
    `/display` (original if browser-displayable, else `display.jpg`), `/thumb`, `/preview`;
    a missing original → 404 `{ error: 'not_on_this_machine', host }`.
  - P6 static: `/` → `web/dist/index.html`, `/full/:id` → `web/dist/fullscreen.html`, `/assets/*`
    from `web/dist`. A missing `web/dist` → a plain 503 text page, not a crash.
- **MCP tool names** (P2): `create, get, update, append, delete, restore, list, search, tags,
  revisions, revert`. P5 adds `create_image` (local path + optional body) and `view_images`
  (ids → MCP `image` content of the preview + metadata text), and adds `has_image`,
  `taken_from`/`taken_to` filters to `list` and `search`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Scaffold, config, schema, ids, tags, test harness | R1 | root, `src/db`, `src/notes` | ~21 | — | NORMAL | `.workflows/plan/notes-spine-images-ui/phase-1.md` | — | — |
| 2 | Notes service, MCP server and tools, notesd daemon | R1, R3 (`hasImage` only) | `src/notes`, `src/mcp`, `src/http`, `src/` | ~22 | 1 | HARD | `.workflows/plan/notes-spine-images-ui/phase-2.md` | — | — |
| 3 | `/n` skill, systemd unit, install + Windows scripts, live verification | R1 | `claude/`, `deploy/`, `scripts/`, `docs/` | ~6 | 2 | NORMAL | `.workflows/plan/notes-spine-images-ui/phase-3.md` | — | — |
| 4 | Image store, derivatives, ingest service, inbox watcher | R2 | `src/images`, `src/background.ts` | ~19 | 2 | HARD | `.workflows/plan/notes-spine-images-ui/phase-4.md` | — | — |
| 5 | Image HTTP routes + upload, MCP image tools, image/date filters | R2 | `src/http/{images,imageAccess}.ts`, `src/mcp`, `src/notes/repo.ts` | ~11 | 4 | NORMAL | `.workflows/plan/notes-spine-images-ui/phase-5.md` | — | — |
| 6 | UI JSON API, SSE events, chat stub, static SPA serving | R3 | `src/http/api.ts`, `src/http/static.ts`, `src/chat` | ~10 | 2 | NORMAL | `.workflows/plan/notes-spine-images-ui/phase-6.md` | — | — |
| 7 | Web UI core: wall, rail, sidebar, header, inline edit, chat bar + answer panel, tooltips, live updates | R3 | `web/` | ~38 | 6 | HARD | `.workflows/plan/notes-spine-images-ui/phase-7.md` | — | — |
| 8 | Web UI images: gallery, photo modal, full-screen tab, drag/paste upload, missing-file placeholder | R3 | `web/` | ~15 | 5, 7 | NORMAL | `.workflows/plan/notes-spine-images-ui/phase-8.md` | — | — |

### Phase 1 — Scaffold, config, schema, ids, tags, test harness
**Satisfies:** R1 (plus, by invariants 7 and 8, the schema and dependencies R2/R3 use)
**Owns:** `package.json` (all deps for the whole set, exact versions; scripts `build:server`, `build`
(= build:server until P7), `typecheck`, `test`, `test:int`, `db:generate`, `db:migrate`, `db:check`,
`dev`, `start`), `tsconfig.json` + `tsconfig.server.json`, `vitest.config.ts`, `drizzle.config.ts`,
`.gitignore` (node_modules, dist, web/dist, .env.local), `src/config.ts` (`loadConfig`, URL choice by
host), `src/db/schema.ts`, `src/db/client.ts` (`createDb`, `closeDb`, `Db`), `drizzle/0000_init.sql` (+ meta),
`src/notes/ids.ts` (`generateId`, `normalizeId` → `string | null`, `parseId`, `isValidId`), `src/notes/tags.ts`
(`#[A-Za-z0-9_-]+` not preceded by a word char, lower-cased, deduped, order of first appearance),
`scripts/test-int.sh` (Docker `mcp-notes-pg-test` on 55433, then vitest), `vitest.config.ts`
(integration files serial), `tests/unit/{ids,tags,config,db-client}.test.ts`,
`tests/integration/{setup,globalSetup}.ts` and one schema smoke int test.
Applies the migration to the project's Neon DB (`npm run db:migrate`) and records that it did.
**Does not touch:** any service, MCP or HTTP code; `.env.local` (the owner's file, read only).
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` green; Neon has both tables
and all indexes.

### Phase 2 — Notes service, MCP server and tools, notesd daemon
**Satisfies:** R1; R3 (the repo-level `hasImage` option only)
**Owns:** `src/notes/{types,dates,repo,service,events}.ts`, `src/mcp/{server,tools,instructions,imageTools}.ts`
(imageTools a no-op; `ToolDeps` carries `db`), `src/http/{app,api,images,static}.ts` (the last three empty router
factories), `src/deps.ts`, `src/background.ts` (no-op), `src/daemon.ts`, `src/main.ts`; the eleven MCP tools with Claude-facing descriptions
and server instructions; collision-retried id generation; revisions in the same transaction;
`list` (tags any/all, created/updated date range, newest first, limit + opaque cursor), `search`
(`websearch_to_tsquery('simple', …)` + tag + date filters, ranked by `ts_rank` then recency); a repo-level
`hasImage?: boolean` option on list/search (not exposed in MCP schemas until P5),
`tags` (count + last_used); `tests/integration/{notes.service,mcp.tools}.int.test.ts` (MCP via
an in-process client over the real HTTP route), `daemon.int.test.ts` and `tests/unit/` for pure helpers.
**Does not touch:** image files, the web app, install scripts.
**Exit criteria:** `node dist/main.js` with `NOTESD_PORT=7399` serves `/health` and a working
`/mcp`; all gates green.

### Phase 3 — `/n` skill, systemd unit, install + Windows scripts, live verification
**Satisfies:** R1
**Owns:** `claude/skills/n/SKILL.md`, `deploy/notesd.service` (template with absolute node path),
`scripts/install.sh` (idempotent: npm ci if needed, build, data dir, unit install + enable +
restart, `loginctl enable-linger`, `claude mcp remove`/`add --scope user --transport http notes
http://localhost:7317/mcp`, skill symlink), `scripts/uninstall.sh`,
`scripts/windows/install-wsl-keepalive.ps1`, `docs/INSTALL.md` (Windows step, whether WSL stays
up without a terminal, post-landing re-run). Runs `install.sh` and verifies unit active,
`/health`, `claude mcp list` shows `notes` connected.
**Does not touch:** `src/**`.
**Exit criteria:** the verification output is recorded in the phase's completion notes.

### Phase 4 — Image store, derivatives, ingest service, inbox watcher
**Satisfies:** R2
**Owns:** `src/images/{probe,store,derive,records,ingest,inbox}.ts`; `src/background.ts` (fills it: starts
the inbox watcher); `imageDeps(app)`, `ingestImage(img, { bytes | path, originalName?, body?, origin?, move? })` →
`{ note, created }`, `locateImage(img, id)` with sha256 dedupe (a soft-deleted duplicate is restored and returned),
byte-exact write, metadata (sha256, mime by magic bytes, width, height, bytes, EXIF taken_at,
original_name, host), lazy derivative getters (`thumb` 480 w WebP, `preview` long edge ≤ 1568 JPEG,
`display` full-res JPEG only for non-browser formats; HEIC via `heic-convert`); inbox watcher
(stable-size wait, images only, moves into the store, failures to `inbox/failed/`). Tests with
fixture images (JPEG with EXIF, PNG, a small HEIC) committed under `tests/fixtures/images/`, plus
`tests/helpers/{fixtures,fakeNotes}.ts`.
**Does not touch:** HTTP routes, MCP tools, anything in `src/notes/` (reads image rows through its own
`records.ts`; writes only through `NotesService`).
**Exit criteria:** ingesting the same bytes twice returns one note; HEIC gets a display derivative;
dropping a file in a temp inbox creates a note; gates green.

### Phase 5 — Image HTTP routes + upload, MCP image tools, image/date filters
**Satisfies:** R2
**Owns:** `src/http/images.ts` (the contract above), `src/http/imageAccess.ts` (the only adapter over
`src/images/*`), `src/mcp/imageTools.ts` (`create_image`, `view_images`), `takenFrom/takenTo` in
P2's `NoteFilter`/`filterConditions` (bounds through P2's `parseDateBound`, text comparison on the indexed
`image_meta->>'taken_at'`), and `has_image` + the taken range in P2's `noteFilterShape`/`toFilter`; the
images section of the server instructions; tests.
**Does not touch:** `src/images/*` internals beyond calling them, `src/http/app.ts`, the web app.
**Exit criteria:** upload → note → original bytes identical; `view_images` returns MCP image
content; missing file → 404 `not_on_this_machine`; gates green.

### Phase 6 — UI JSON API, SSE events, chat stub, static SPA serving
**Satisfies:** R3
**Owns:** `src/http/api.ts` (`apiRoutes(deps, options?)`), `src/http/static.ts` (`staticRoutes(deps?, options?)`),
`src/chat/{backend,stub}.ts` (the fixed "chat brain arrives in iteration 4" reply, streamed in small deltas,
behind a `ChatBackend` interface so iteration 4 swaps only the implementation), tests.
**Does not touch:** `src/http/app.ts`, the web app, image routes.
**Exit criteria:** every endpoint in the P6 contract has an integration test; gates green.

### Phase 7 — Web UI core
**Satisfies:** R3
**Owns:** `web/**` (Vite config, `index.html`, `src/` components, styles, fonts, API client,
SSE + 60 s refetch, relative dates, tooltips, keyboard handling, the 3-way visibility `mode`
(`text` default / `images` / `all`) with the rail cycle button and sidebar mode icons), `package.json` `scripts` only
(`build` = server + web, `dev:web`), `tsconfig.web.json`. Implements every non-image element of
`Notes Wall.dc.html` exactly; image cards on the wall use `/api/notes/:id/thumb` (P5 contract).
**Does not touch:** the gallery, modal, full-screen entry, upload (P8); server code.
**Exit criteria:** `npm run build` produces `web/dist`; served by the daemon on a test port the
wall renders real notes; component tests green.

### Phase 8 — Web UI images
**Satisfies:** R3
**Owns:** `web/src/components/{NoteImage,Gallery,PhotoModal,DropOverlay}.tsx` (rewrites of phase 7's
stubs, with phase 7's props), `PhotoModal.css`, `web/fullscreen.html` + `web/src/fullscreen/**` (second Vite
input under `build.rolldownOptions.input`), upload via drag/drop and paste to `POST /api/images` (results go
to phase 7's `onImageAdded(note)`), "not on this machine" placeholder (wall, gallery, modal, full-screen),
film-tone filter only on wall/gallery/modal; full-screen 1:1 = device pixels.
**Does not touch:** server code, `web/src/App.tsx` and every other phase-7 file except the four stubs and
the Vite `input` map.
**Exit criteria:** gallery, modal (Esc/arrows), full-screen tab (fit/1:1/pan, title = id), upload
all work against a running daemon on a test port; gates green.

## Reconciliation Log

Round 1 (2026-10-30). Phases 1 and 2 were treated as ground truth for names and signatures;
dependent plans were rewritten to match them. Phase 1/2 were edited only where noted.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | P2 assumed `createDb(url) → { db, close }` and inline truncates; P1 prescribes `createDb(url): Db` + `closeDb(db)` and `openTestDb/closeTestDb/truncateAll/testDatabaseUrl` | Unmet assumption | P2 `daemon.ts` and its three int tests rewritten to P1's exports; P2's assumptions table replaced by P1's actual exports |
| 2 | P4 (`testDb()`, `truncateAll()`), P5 (`normaliseId`, `createDb`, raw truncate), P6 (`normaliseId`, `{db, close}`) guessed P1 names | Unmet assumption | All rewritten to `normalizeId`, `openTestDb`/`closeTestDb`/`truncateAll(db)`/`testDatabaseUrl` |
| 3 | P2 verified against drizzle-orm 0.45.4, zod 4.6.7, vitest 5.0.5; P1 pins 0.45.2 / 4.4.3 / 4.1.2 | Contract drift (deps) | P1's pins win (invariant 8). P2's code uses only zod 4.0 basics, drizzle 0.45.x query builders and plain vitest APIs; noted in P2. P4's sharp 0.35.5 / chokidar 6.0.0 notes aligned to P1's 0.35.3 / 6.0.0; P7's react 19.3.1 note aligned to P1's 19.2.8 |
| 4 | P1 Step 1 edited the owner's `.env.local` (swapping the two Neon key names) | Coordinator decision | Step 1 is now a read-only check. `drizzle.config.ts` picks the non-`-pooler` host of the two; `loadConfig` picks the pooled one (a real-env `DATABASE_URL` still wins, which test-port runs in P7/P8 rely on); Step 16's Neon check picks the direct host the same way; two unit tests added; rollback/risk text updated |
| 5 | P4 assumed `createNotesService`, `create({ image_path, image_meta })` raising raw `23505`, `get`, `findByImageSha256`, `getImageRecord`, `startBackground({ config, notes })` | Unmet assumption | P4 rewritten to P2's API: `newId()`, `create({ id, image: { path, meta }, allowEmpty })` with `NoteError('conflict' / 'duplicate_image')`, `getOne`, `restore`, `startBackground(deps: AppDeps)`. Raw image reads moved into a new read-only `src/images/records.ts` (`dbImageRecords(db)`); `isUniqueViolation` deleted; `imageDeps(app)` added; FakeNotes, unit and int tests rewritten. P2 not edited |
| 6 | P5 assumed P4's `ensureDerivative`, `NotAnImageError`, raw `loadImageRecords`, `createNotesService(db)`, `ListFilters`, `SERVER_INSTRUCTIONS`, a conditional service pass-through | Unmet assumption | `imageAccess.ts` rewritten over P4's `locateImage`/`getDisplay`/`getThumb`/`getPreview`/`OriginalMissingError`/`UnsupportedImageError`/`imageDeps`; `view_images` reads notes via `service.get(…, { includeDeleted: true })`; harness and tests rewritten; the conditional service step dropped (P2's service passes the filter through) |
| 7 | P5's `takenRange.ts` (timestamptz cast, own parser) duplicated P2's `parseDateBound` | Duplicate work | `takenRange.ts` and its test deleted; P5 adds two conditions to P2's `filterConditions` using `parseDateBound(...).toISOString()` against the indexed text `image_meta->>'taken_at'` (P1: UTC ISO `Z`); new `tests/unit/takenFilter.test.ts`; MCP fields added directly to P2's `noteFilterShape`/`FilterArgs`/`toFilter` |
| 8 | P5's MCP tools need `db` (image record reads) but P2's `ToolDeps` was `{ service, dataDir }` | Unmet assumption | **P2 edited:** `ToolDeps` gains `db`, `createApp` passes `deps.db`. P5's `toolImageDeps(deps)` builds `ImageDeps` from it |
| 9 | P2's MCP int test asserted the exact eleven tool names; P5 adds two tools to the same server | Broken-build phase (P5) | **P2 edited:** assertion uses `expect.arrayContaining` |
| 10 | P5 test "keeps serving a cached derivative after the original is gone" vs P4 getters that require the original | Contract drift | P4 wins (see Decisions); the test now asserts the 404 `not_on_this_machine` |
| 11 | P6 assumed `apiRoutes({ notes, events })`, `staticRoutes()`, `get(id)`, nullable `update/delete`, `InvalidCursorError`, `createNoteEvents()` with `on/off('note')`, `tags`+`tagMode` | Unmet assumption | Rewritten to `apiRoutes(deps: AppDeps, options?)`, `staticRoutes(deps?, options?)`, `getOne`, `create/update` with `allowEmpty`, one `NoteError` → status map, `list({ tagsAll, hasImage, limit, cursor })`, `events.on(listener)` → unsubscribe, `listenerCount()`. P2's `MAX_LIMIT` is already 5000; P6 imports it |
| 12 | P6 contract: DELETE of a non-live note → 404; P2's `delete` is idempotent | Contract drift | P6 pre-checks `getOne` and returns 404 (see Decisions); P2 unchanged |
| 13 | P7's API client accepted bare arrays or wrappers | Contract drift | P7 reads P6's exact shapes (`{ notes, next_cursor }`, bare `TagCount[]`, bare `Note`); its App test mock returns `{ notes, next_cursor: null }` |
| 14 | P8 assumed Gallery `formatDate`, PhotoModal own copy state, DropOverlay `onJump`/`setMode`, its own `photosOf`/`copyText`/`modeAfterImageAdded`, `rollupOptions`, and a Step 9 that edits App | Unmet assumption / duplicate work | P8 conforms to P7's stub props (`GalleryProps { photos, copiedId, onCopy }`, `PhotoModalProps` with `copiedId/onCopy`, `DropOverlayProps { onImageAdded }`, `NoteImage` widened with optional `variant`); imports P7's `relativeDate`; duplicates removed; `rolldownOptions`; Step 9 is now a no-edit check; tests rewritten |
| 15 | P8 dedupe-hit jump needed a `jump` prop P7 does not pass | Unmet assumption | Resolved without widening P7: every upload result goes to `onImageAdded(note)` (text→all), and P8's `flashNote` scrolls to and flashes `[data-note]` (gallery tiles carry `data-note` too). See Decisions |
| 16 | P2 duplicated `ImageMeta` that P1's schema already exports | Duplicate work | P2's `types.ts` re-exports P1's `ImageMeta` |
| 17 | P2 step-2 note said `taken_at` is zone-less EXIF local time | Contract drift | Corrected to P1's UTC ISO `Z` and the text-compare rule |
| 18 | Integration files share and truncate one DB (P2 verified clobbering in parallel) | Check | P1's `vitest.config.ts` already sets `fileParallelism: !integration`; P2/P6 handoffs updated |
| 19 | P3 risk: `localhost` might resolve to `::1` | Risk text | Downgraded: coordinator verified `localhost` → `127.0.0.1` first (getent, Node `dns.lookup`) |
| 20 | P2 carries `hasImage` (R3) under a Satisfies line of R1 only | Requirement creep | Not moved: the index Decision (owner commit `30a58fd`) put it in P2 so P6 and P5 do not both edit `repo.ts`. P2's Satisfies line and the Requirements table now say R3 (`hasImage` only) |
| 21 | Analysis impact point 2 lists `src/db/migrate.ts` and `scripts/test-db.sh` | Gap check | Covered: migrations run through `drizzle-kit migrate` (Neon) and `migrateTestDb()` in `tests/integration/setup.ts` (Docker); the script is `scripts/test-int.sh`. No runtime migrator is needed. Impact point 7 "static serving in `app.ts`" is `src/http/static.ts` (P6) by the Seams |
| 22 | P4's `ensureDataDirs` (store.ts) and P2's `ensureDataDirs` (daemon.ts) both create the data dirs | Duplicate work | Kept both, deliberately: P2 creates them at daemon start; P4's `startBackground` re-ensures them (idempotent) because its tests call it without `startDaemon`. Different modules, no export clash |

Verification after edits: every `Requires` points at an earlier phase; no symbol is deleted (greenfield)
so no deleted-then-used; P5 and P6 can run in parallel with no shared file (P5: `images.ts`,
`imageAccess.ts`, `imageTools.ts`, `repo.ts`, `tools.ts`, `instructions.ts`; P6: `api.ts`, `static.ts`,
`src/chat/`), likewise P4 with P6; every impact point and R1–R3 has an owner.

Round 2 (2026-10-30, verification). Every consumer of the four contracts changed in round 1 was
checked against the producer's code blocks: P4's `ImageDeps { dataDir, notes, records, hostname?, now? }`,
`imageDeps(app: AppDeps)`, `dbImageRecords(db)` / `ImageRecords.byId|bySha256` (P4 `background.ts`, P4
unit + int tests, `FakeNotes`, P5 `imageAccess.ts`, `images.ts`, `imageTools.ts`, P5 harness); P2's
`ToolDeps { service, dataDir, db }` and `createApp`'s `toolDeps` (P5 `toolImageDeps`); P6's
`apiRoutes(deps: AppDeps, options?)` / `staticRoutes(deps?, options?)` against P2's `app.ts` calls and
P6's harness; P7's four stub props and `onImageAdded(note)` against P8's components and tests. No
`isUniqueViolation` reference remains. Names, signatures, import paths and return shapes match. The
Phase table's file counts equal each plan's Files table; Satisfies/Depends lines equal the index.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 23 | P8's `NoteImage` dropped P7's default `className = 'card-img'`; P7's NoteCard renders `<NoteImage note={note} />` with no class, and P7's handoff says the wall keeps `.card-img` | Contract drift | P8 default is now `className = variant === 'thumb' ? 'card-img' : undefined` (the inline `FILM_FILTER` stays; same values as `--film`/`--img-bg`). P8 tests unaffected |
| 24 | P4 Files table still described `fakeNotes.ts` as raising "code 23505" after round 1 moved it to `NoteError` | Contract drift (text) | Row rewritten: `ImageNotes` + `ImageRecords`, raises P2's `NoteError('conflict' / 'duplicate_image')` |
| 25 | Index `**Status:**` still read `planned` | Index | Set to `reconciled` |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| `01-spine.md` contains `/analyze feature --no-worktree`, the outer invocation does not | worktree cut (`feature/notes-spine-images-ui`); the inner line is part of R1's quoted text, not this run's flags | 5: user raw input (the actual invocation) |
| Prod driver (`@neondatabase/serverless`) vs "real Postgres" integration tests with no Neon branch available | `createDb` picks the Neon websocket Pool for `*.neon.tech`, `node-postgres` otherwise; `test:int` uses a dedicated Docker `postgres:16` | 1: invariant 9 / 5: raw input ("real Postgres", "@neondatabase/serverless") |
| `neon-http` (expense-tracking style) has no transactions; revisions must be atomic | `drizzle-orm/neon-serverless` Pool | 1: invariant 5 |
| Tag syntax: design `#[a-z0-9-]+` vs brief examples `#from_phone`, `#ai_image` | `#[A-Za-z0-9_-]+`, lower-cased | 5: raw input |
| `.env.local` is gitignored and absent from worktrees | worktree carries a symlink to `~/mcp-notes/.env.local`; config resolves it from the repo root | 6: convention |
| Who adds deps / migrations when phases run in parallel | phase 1 owns all deps and the single migration | 1: invariants 7, 8 |
| `app.ts` / MCP server / main edited by parallel phases | P2 ships empty `api.ts`, `images.ts`, `static.ts`, `imageTools.ts`, `background.ts`; later phases fill their own files | 1: invariant 2 (parallel phases must merge green) |
| "+" with server-generated ids | "+" POSTs an empty note immediately (HTTP allows empty body; MCP `create` does not), the card shows the real id at once; emptied on blur → soft delete | 5: raw input ("the '+' creates a note", ids by server, emptied note soft-deleted) |
| Live updates: poll or SSE | SSE from the in-process event bus + a 60 s refetch for writes made by the GPD's daemon | 5: raw input ("planner's choice") |
| Fonts: design loads Google Fonts CDN | bundled from npm (`@fontsource*`), same families | 6: convention (Phosphor also from npm per raw input; offline daemon) |
| systemd unit runs code from the checkout that ran `install.sh`; the phase worktree is deleted on landing | P3 verifies from the worktree; after landing, re-run `scripts/install.sh` from `~/mcp-notes` (idempotent) — listed under Next | 6: convention |
| Missing-file placeholder wording: ROADMAP "on Lenovo" vs brief "not on this machine" | "not on this machine", plus the host name recorded at ingest (`image_meta.host`) | 5: raw input (more specific, later) |
| Dedupe hit on a soft-deleted note | restore it and return it | 5: raw input ("the same file twice returns the existing note") |
| Mid-analysis R3 change (3-way visibility, commit `30a58fd`, relayed by a peer session) | merged by fast-forward and treated as raw input; `hasImage` moves to P2's repo so P6 can serve `has_image` without waiting on P5; the UI still loads all notes and filters client-side (the count line needs both kinds) | 5: raw input (owner's commit) |
| `.env.local` has `DATABASE_URL`/`DATABASE_URL_UNPOOLED` swapped (coordinator-verified): edit the owner's file, or choose by host | never edit `.env.local`; `drizzle.config.ts` uses whichever has no `-pooler`, the daemon the pooled one (else whichever exists); a real-env `DATABASE_URL` overrides | coordinator decision; 1: invariant 9 (tests never touch Neon: the real-env override keeps test-port runs on Docker) |
| Full-screen "1:1": CSS pixels or device pixels | device pixels (`naturalWidth / devicePixelRatio`), recorded in P8 as a deliberate design departure | coordinator decision; 5: raw input ("click toggles 1:1 pixels", "this tab is where the original is seen") |
| Original missing but a cached derivative exists: serve the cache (P5 draft) or 404 (P4 getters) | every variant 404s `{ error: 'not_on_this_machine', host }` | 3: plan code blocks (P4's `assertOriginal`, the earlier phase) and the index HTTP contract ("a missing original → 404") |
| Taken-date filter: P5's own parser + `::timestamptz` cast, or P2's `parseDateBound` + text compare | P2's `parseDateBound`, bounds as `toISOString()`, text compare on `image_meta->>'taken_at'` (index usable; same day semantics as `from`/`to`) | 3: plan code blocks (P1 schema: `taken_at` is UTC ISO `Z`, indexed as text; P1 handoff to P5) |
| HTTP `DELETE` of an already-deleted note: 200 (P2 idempotent) or 404 (P6 contract) | 404, via a `getOne` pre-check in P6; P2's service stays idempotent for MCP | 3: plan code blocks (P6's HTTP contract table, consumed by P7's `deleteNote`, which tolerates 404) |
| Dedupe-hit "jump" in P8: widen P7's `DropOverlayProps` with a jump callback, or reuse `onImageAdded` | reuse `onImageAdded(note)` (switches text→all) and let P8 scroll + flash `[data-note]`; gallery tiles carry `data-note`. P7 unchanged | 3: plan code blocks (P7's stub props, the earlier phase) |
| P5's image tools need the db; P2's `ToolDeps` lacked it | add `db` to P2's `ToolDeps` (one field, one line in `createApp`) | 1: invariant 2 (the phase must build green) |
| Where P4 reads `image_path`/`sha256` (P2's service exposes wire notes only) | read-only `src/images/records.ts` over P1's schema; writes stay in `NotesService` | 4: index Seams ("the service is the only writer"); coordinator instruction |
| `view_images` metadata source: raw SQL (P5 draft) or the service | `service.get(ids, { includeDeleted: true })` wire notes + `resolveImageFile` for the preview | 6: convention (one reader path for notes; P2's shape already carries `image`) |

## Open Questions

_(none)_

## Rollback

Per phase: `git revert` the phase's commit(s). Phase 1's migration on Neon: the database is this
project's own and holds no other data; `DROP TABLE note_revisions, notes; DROP TABLE drizzle.__drizzle_migrations`
returns it to empty. Phase 3: `scripts/uninstall.sh` (disables the unit, `claude mcp remove notes
--scope user`, removes the skill symlink). Whole set: delete the branch; nothing lands on main
until the set is integrated.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows,
resumable on any machine:

    /analyze-orchestrator -f docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md

After the set lands on main, point the daemon at the main checkout:

    cd ~/mcp-notes && git pull && scripts/install.sh
