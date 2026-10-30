# Todos: mcp-notes

**Package Path**: `.`
**Package Code**: NOTES
**Last Updated**: 2026-10-30 10:25:00
**Total Active Tasks**: 2

## Quick Stats
- P0 Critical: 0
- P1 High: 2
- P2 Medium: 0
- P3 Low: 0
- P4 Backlog: 0
- Blocked: 1
- Completed: 6

---

## Active Tasks

### [P0] Critical

### [P1] High
- [ ] **P1-NOTES-A006** Phase 7: Web UI core: wall, rail, sidebar, header, inline edit, chat bar + answer panel, tooltips, live updates
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `web/**` (Vite config, components, styles, fonts, API client, SSE + 60 s refetch, 3-way visibility mode), `package.json` scripts only (`build`, `dev:web`), `tsconfig.web.json`; every non-image element of `Notes Wall.dc.html`. Exit: `npm run build` produces `web/dist`; served by the daemon on a test port the wall renders real notes; component tests green.
  - **Status**: open
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 7 of 8)
  - **Satisfies**: R3 — Web UI: Claude Design as a Vite + React + TS SPA served by notesd, real API, 3-way visibility, gallery, modal, full-screen tab, upload, inline edit, streaming /api/chat stub, live updates
  - **Depends on**: P1-NOTES-A005
  - **Plan**: `.workflows/plan/P1-NOTES-A006.md`

- [ ] **P1-NOTES-A007** Phase 8: Web UI images: gallery, photo modal, full-screen tab, drag/paste upload, missing-file placeholder
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `web/src/components/{NoteImage,Gallery,PhotoModal,DropOverlay}.tsx` (rewrites of P7 stubs), `PhotoModal.css`, `web/fullscreen.html` + `web/src/fullscreen/**`, drag/drop + paste upload to `POST /api/images`, "not on this machine" placeholder, film-tone filter. Exit: gallery, modal (Esc/arrows), full-screen tab (fit/1:1/pan, title = id), upload all work against a running daemon on a test port; gates green.
  - **Status**: blocked
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 8 of 8)
  - **Satisfies**: R3 — Web UI: Claude Design as a Vite + React + TS SPA served by notesd, real API, 3-way visibility, gallery, modal, full-screen tab, upload, inline edit, streaming /api/chat stub, live updates
  - **Depends on**: P1-NOTES-A004, P1-NOTES-A006
  - **Plan**: `.workflows/plan/P1-NOTES-A007.md`

### [P2] Medium

### [P3] Low

### [P4] Backlog

---

## Completed Tasks

- [x] **P1-NOTES-A004** Phase 5: Image HTTP routes + upload, MCP image tools, image/date filters
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/http/{images,imageAccess}.ts`, `src/mcp/imageTools.ts` (`create_image`, `view_images`), takenFrom/takenTo filters in P2's NoteFilter, `has_image` + taken range in MCP schemas, images section of server instructions; tests. Exit: upload → note → original bytes identical; `view_images` returns MCP image content; missing file → 404 `not_on_this_machine`; gates green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 5 of 8)
  - **Satisfies**: R2 — Images: byte-exact local store + sha256 dedupe + metadata, derivatives, ingestion (upload, inbox, MCP), viewing + filters, HTTP serving, "not on this machine" fallback
  - **Depends on**: P1-NOTES-A003
  - **Plan**: `.workflows/plan/P1-NOTES-A004.md`
  - **Completed**: 2026-10-30 10:25
  - **Method**: /do
  - **Files**: src/notes/repo.ts, src/mcp/tools.ts, src/mcp/instructions.ts, src/mcp/imageTools.ts, src/http/images.ts, src/http/imageAccess.ts, tests/unit/takenFilter.test.ts, tests/unit/imageAccess.test.ts, tests/integration/imageHarness.ts, tests/integration/images.http.int.test.ts, tests/integration/images.mcp.int.test.ts
  - **Drift**:
    - none in src: P2/P4 exports matched the plan exactly
  - **Decided**:
    - images.mcp.int.test fixture said 'a text note about sunsets' but search uses to_tsvector('simple') with no stemming, so 'sunset' never matched it -> fixture text changed to 'a text note about a sunset' (assertion unchanged) (rung 3: P1/P2 code blocks fix the 'simple' FTS config; the test data was the stale half)
  - **Verification**:
    - npm run typecheck, npm test (152 passed), npm run test:int (86 passed), npm run build: all green; touched tests re-run green after rebasing onto ed3d299
    - Manual check on port 7399: upload -> 201, /original bytes identical (cmp), Cache-Control immutable + CSP + nosniff; after deleting the file -> 404 {error:not_on_this_machine, host:pc}

- [x] **P1-NOTES-A003** Phase 4: Image store, derivatives, ingest service, inbox watcher
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/images/{probe,store,derive,records,ingest,inbox}.ts`, fills `src/background.ts`; sha256 dedupe (soft-deleted duplicate restored), byte-exact write, metadata, lazy thumb/preview/display derivatives (HEIC via heic-convert), inbox watcher; fixture images and test helpers. Exit: ingesting the same bytes twice returns one note; HEIC gets a display derivative; dropping a file in a temp inbox creates a note; gates green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 4 of 8)
  - **Satisfies**: R2 — Images: byte-exact local store + sha256 dedupe + metadata, derivatives, ingestion (upload, inbox, MCP), viewing + filters, HTTP serving, "not on this machine" fallback
  - **Depends on**: P1-NOTES-A001
  - **Plan**: `.workflows/plan/P1-NOTES-A003.md`
  - **Completed**: 2026-10-30 10:17
  - **Method**: /do
  - **Files**: src/background.ts, src/images/probe.ts, src/images/store.ts, src/images/derive.ts, src/images/records.ts, src/images/ingest.ts, src/images/inbox.ts, tests/fixtures/images/exif.jpg, tests/fixtures/images/plain.png, tests/fixtures/images/photo.heic, tests/fixtures/images/make-fixtures.py, tests/helpers/fixtures.ts, tests/helpers/fakeNotes.ts, tests/unit/images/probe.test.ts, tests/unit/images/store.test.ts, tests/unit/images/derive.test.ts, tests/unit/images/ingest.test.ts, tests/unit/images/inbox.test.ts, tests/integration/images.int.test.ts
  - **Decided**:
    - The plan's manual check (daemon on port 7399 with a temp NOTES_DATA_DIR) uses .env.local's DATABASE_URL, so it created note 9-C0C (origin inbox, image only in a temp dir) in the owner's Neon DB -> soft-deleted it through NotesService.delete, so it can be restored (tie-break: take the reversible option; invariant 11 keeps test data out of real stores)
  - **Verification**:
    - npm run typecheck: exit 0
    - npm test: 13 files, 145 tests passed (tests/unit/images: 5 files, 49 tests)
    - npm run build: exit 0
    - npm run test:int: 7 files, 70 tests passed (first run hit a 40P01 TRUNCATE deadlock from a peer phase sharing the Docker DB; re-run green)
    - manual: NOTESD_PORT=7399 daemon, temp data dir: `[inbox] IMG_1.HEIC -> 9-C0C`, stored original cmp-equals photo.heic; a.txt logged `ignored a.txt: not an image` and stayed in the inbox

- [x] **P1-NOTES-A002** Phase 3: `/n` skill, systemd unit, install + Windows scripts, live verification
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `claude/skills/n/SKILL.md`, `deploy/notesd.service`, `scripts/{install,uninstall}.sh`, `scripts/windows/install-wsl-keepalive.ps1`, `docs/INSTALL.md`; runs install.sh and verifies unit active, `/health`, `claude mcp list` shows `notes` connected. Exit: the verification output is recorded in the phase's completion notes.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 3 of 8)
  - **Satisfies**: R1 — Spine: /n skill, systemd + install script + Windows Task Scheduler script, `claude mcp add --scope user`
  - **Depends on**: P1-NOTES-A001
  - **Plan**: `.workflows/plan/P1-NOTES-A002.md`
  - **Completed**: 2026-10-30 10:17
  - **Method**: /do
  - **Files**: claude/skills/n/SKILL.md, deploy/notesd.service, scripts/install.sh, scripts/uninstall.sh, scripts/windows/install-wsl-keepalive.ps1, docs/INSTALL.md
  - **Drift**:
    - Plan Step 7's PowerShell parse one-liner passes [ref]$e for an undefined $e and errors before parsing; re-ran with $e/$t initialised -> 'ps1 parses'. No file changed.
  - **Decided**:
    - Run test:int during a wave where P4/P6 share the Docker DB? -> no; ran typecheck + vitest tests/unit (13 files, 145 passed). Phase 3 changes no TS/test-reachable file, and truncating the shared DB would clobber peers (tie-break: narrower blast radius; coordinator rule).
    - Installer built dist/ from the shared worktree, including peers' uncommitted src edits -> accepted; exit criteria (rung 2) require install from the worktree, and the post-landing re-run from ~/mcp-notes replaces this build.
  - **Verification**:
    - scripts/install.sh run 1 from the worktree: exit 0; installed the unit, enabled linger (no password needed), registered MCP, linked the skill, printed OK.
    - Run 2: "node_modules up to date, skipping npm ci", "unit unchanged", "linger already enabled for miftah", "replacing skill symlink", OK (exit 0).
    - systemctl --user is-active notesd.service: active
    - GET http://127.0.0.1:7317/health: HTTP 200 {"ok":true,"service":"notesd"}
    - claude mcp list: notes: http://localhost:7317/mcp (HTTP) - Connected (claude mcp get notes: Scope User config, Connected)
    - ~/.claude/skills/n -> /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui/claude/skills/n
    - Linger=yes
    - Unit ExecStart="/home/miftah/tools/node-v22.23.1-linux-x64/bin/node" ".../notes-spine-images-ui/dist/main.js", WorkingDirectory = the worktree
    - Windows: task 'mcp-notes WSL keepalive' registered for PC\mahfu without elevation, State Running; action: C:\Windows\System32\conhost.exe --headless "C:\Windows\System32\wsl.exe" -d "Ubuntu" -- sleep infinity; `sleep infinity` running in WSL.
    - Static: bash -n on both scripts OK, both executable, ps1 is ASCII, ps1 parses.
    - The unit and the /n symlink point at the worktree until the post-landing re-run: cd ~/mcp-notes && git pull && scripts/install.sh

- [x] **P1-NOTES-A000** Phase 1: Scaffold, config, schema, ids, tags, test harness
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns package.json (all deps for the whole set, exact versions, all scripts), tsconfig + tsconfig.server, vitest/drizzle config, .gitignore, `src/config.ts`, `src/db/{schema,client}.ts`, `drizzle/0000_init.sql`, `src/notes/{ids,tags}.ts`, `scripts/test-int.sh`, unit tests and integration harness; applies the migration to Neon. Exit: `npm run typecheck`, `npm test`, `npm run test:int` green; Neon has both tables and all indexes.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 1 of 8)
  - **Satisfies**: R1 — Spine: notesd (Hono, 127.0.0.1:7317, MCP `/mcp`, `/health`), Neon schema via Drizzle, A-B32 ids, #hashtag tags, note_revisions, MCP note tools, /n skill, systemd + install + Windows scripts, vitest tests
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P1-NOTES-A000.md`
  - **Completed**: 2026-10-30 10:03
  - **Method**: /do
  - **Files**: .gitignore, package.json, package-lock.json, tsconfig.json, tsconfig.server.json, vitest.config.ts, drizzle.config.ts, src/config.ts, src/db/schema.ts, src/db/client.ts, src/notes/ids.ts, src/notes/tags.ts, drizzle/0000_init.sql, drizzle/meta/_journal.json, drizzle/meta/0000_snapshot.json, scripts/test-int.sh, tests/unit/ids.test.ts, tests/unit/tags.test.ts, tests/unit/config.test.ts, tests/unit/db-client.test.ts, tests/integration/setup.ts, tests/integration/globalSetup.ts, tests/integration/schema.int.test.ts, .workflows/todos.md, .workflows/plan/P1-NOTES-A000.md, .workflows/plan/P1-NOTES-A001.md, .workflows/plan/P1-NOTES-A002.md, .workflows/plan/P1-NOTES-A003.md, .workflows/plan/P1-NOTES-A004.md, .workflows/plan/P1-NOTES-A005.md, .workflows/plan/P1-NOTES-A006.md, .workflows/plan/P1-NOTES-A007.md, docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md
  - **Drift**:
    - Generated drizzle/0000_init.sql equals the plan's expected SQL byte for byte except the plan's copy has a trailing newline (drizzle-kit omits it). No change.
    - npm 12 printed install-scripts warnings for esbuild postinstall (expected per plan; harmless).
  - **Decided**:
    - Package for all 8 tasks → repo root `.` with code NOTES (one root package.json per index Seams) (rung 4: index Seams)

- [x] **P1-NOTES-A001** Phase 2: Notes service, MCP server and tools, notesd daemon
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/notes/{types,dates,repo,service,events}.ts`, `src/mcp/{server,tools,instructions,imageTools}.ts`, `src/http/{app,api,images,static}.ts` (last three empty factories), `src/{deps,background,daemon,main}.ts`; the eleven MCP tools, revisions in-transaction, list/search with tag/date filters and cursor, repo-level `hasImage` option, tags; integration + unit tests. Exit: `node dist/main.js` with `NOTESD_PORT=7399` serves `/health` and a working `/mcp`; all gates green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 2 of 8)
  - **Satisfies**: R1, R3 (`hasImage` only) — Spine (notesd, MCP note tools, schema, tests); Web UI's repo-level `hasImage` option
  - **Depends on**: P1-NOTES-A000
  - **Plan**: `.workflows/plan/P1-NOTES-A001.md`
  - **Completed**: 2026-10-30 10:09
  - **Method**: /do
  - **Files**: src/notes/types.ts, src/notes/dates.ts, src/notes/events.ts, src/notes/repo.ts, src/notes/service.ts, src/mcp/instructions.ts, src/mcp/tools.ts, src/mcp/imageTools.ts, src/mcp/server.ts, src/deps.ts, src/http/app.ts, src/http/api.ts, src/http/images.ts, src/http/static.ts, src/background.ts, src/daemon.ts, src/main.ts, tests/unit/notes.helpers.test.ts, tests/unit/mcp.instructions.test.ts, tests/integration/notes.service.int.test.ts, tests/integration/mcp.tools.int.test.ts, tests/integration/daemon.int.test.ts
  - **Drift**:
    - Phase 1 types Config.host as the literal '127.0.0.1', so daemon.int.test.ts's non-loopback refusal test casts its input (as unknown as Config); the assertion is unchanged.
  - **Decided**:
    - daemon test's 0.0.0.0 host vs literal Config.host type → cast test input only, keep assertion (rung 1: invariant 2 typecheck green + invariant 3 refusal still tested)

- [x] **P1-NOTES-A005** Phase 6: UI JSON API, SSE events, chat stub, static SPA serving
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/http/api.ts`, `src/http/static.ts`, `src/chat/{backend,stub}.ts` (streamed "iteration 4" stub behind a `ChatBackend` interface); tests. Exit: every endpoint in the P6 contract has an integration test; gates green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 6 of 8)
  - **Satisfies**: R3 — Web UI: Claude Design as a Vite + React + TS SPA served by notesd, real API, 3-way visibility, gallery, modal, full-screen tab, upload, inline edit, streaming /api/chat stub, live updates
  - **Depends on**: P1-NOTES-A001
  - **Plan**: `.workflows/plan/P1-NOTES-A005.md`
  - **Completed**: 2026-10-30 10:17
  - **Method**: /do
  - **Files**: src/chat/backend.ts, src/chat/stub.ts, src/http/api.ts, src/http/static.ts, tests/unit/chat-stub.test.ts, tests/unit/static.test.ts, tests/integration/helpers/api-harness.ts, tests/integration/helpers/sse.ts, tests/integration/api.int.test.ts, tests/integration/events.int.test.ts
  - **Drift**:
    - tsconfig has noUncheckedIndexedAccess: three indexed reads in tests/integration/api.int.test.ts (imageNote, last) use `?.`; otherwise every plan code block applied verbatim.

---

## Archive
