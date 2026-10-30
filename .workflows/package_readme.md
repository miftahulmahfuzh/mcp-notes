# Package: mcp-notes

**Location**: `.` (repo root)
**Last Updated**: 2026-10-30 (after task P1-NOTES-A012)
**Documentation Created**: 2026-10-30T03:03Z (after task P1-NOTES-A000)

## Overview

`mcp-notes` is a local Node/TypeScript daemon (`notesd`) that keeps short notes and images in Postgres on Neon. It exposes them to Claude Code over MCP and to a React web UI on loopback. All 8 phases of `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` have landed. Phase 1 added config loading, the Drizzle schema and its one migration, the database client factory, note id generation, `#hashtag` parsing, and the unit and Docker-Postgres integration test harness. Phase 2 added the notes service (the only writer), the `notesd` daemon (Hono on 127.0.0.1) with `/health`, and a stateless MCP streamable-HTTP endpoint at `/mcp` exposing 11 note tools. Phase 3 added deployment: a systemd user unit for `notesd`, an idempotent `scripts/install.sh` (and `scripts/uninstall.sh`) that also registers the `notes` MCP server at user scope and links the `/n` Claude Code skill, and a Windows logon task that keeps WSL running. Phase 4 (P1-NOTES-A003) added the image store under `src/images/`: magic-byte probing, byte-exact storage, sha256 dedupe, lazy derivatives and the inbox watcher. Phase 5 (P1-NOTES-A004) added the image HTTP routes and upload, the MCP tools `create_image` and `view_images`, and the `has_image` and taken-date filters. Phase 6 (P1-NOTES-A005) added the UI JSON API under `/api` (notes CRUD, tags), a live `/api/events` SSE stream of note changes, a streamed `/api/chat` stub behind the `ChatBackend` interface, and static serving of the built SPA from `web/dist` with a 503 fallback when it is not built. Phase 7 (P1-NOTES-A006) added the web UI core in `web/`: a Vite + React + TypeScript SPA with the note wall, rail, sidebar, header, inline editing, the chat bar and answer panel, tooltips, live updates over SSE plus a 60 s refetch, and a text/images/all visibility mode. Phase 8 (P1-NOTES-A007) added images to the web UI: a justified gallery, a photo modal, a full-screen tab at `/full/<id>` (a second Vite entry, `fullscreen.html`), drag/drop and paste upload, and a "not on this machine" placeholder, by rewriting the four stub components phase 7 left in place. Iteration 4 (`docs/plans/CHAT_BAR_BRAIN_PLAN.md`) gives the chat bar a real brain. Its phase 1 (P1-NOTES-A008) widened the chat seam: backends yield `delta` and `status` events and report which brain answered, `Config` gained a `chat` block, and `startDaemon` takes the backend as an injectable option. Its phase 2 (P1-NOTES-A009) added the real brain under `src/chat/` (`agent.ts`, `env.ts`, `prompt.ts`, `status.ts`): each chat message is one Claude Agent SDK run on the owner's Claude Code login, restricted to the daemon's own `notes` MCP tools plus WebSearch/WebFetch, with threads mapped to SDK sessions, a turn cap, a wall-clock timeout, one run in flight, and a single retry on GLM when Claude fails on auth or a usage limit before any text. `startDaemon` now builds that backend by default. Its phase 3 (P1-NOTES-A010) taught the web answer panel to show the `status` caption while streaming and the brain label from `done.brain`, and made dismissing the panel start a new thread. Its phase 4 (P1-NOTES-A011) fitted the daemon for the brain: the systemd unit now sets `HOME` and `NOTESD_CLAUDE_BIN` (the resolved absolute `claude` path), `scripts/install.sh` warns on a missing Claude login or GLM keys and smoke-tests `/api/chat`, and `npm run test:live` runs an opt-in suite with one real Claude and one real GLM message. Iteration 5 (`docs/plans/CONNECTORS_PLAN.md`) lets the same `/mcp` server read three of the owner's other apps (expense-tracking, run-insights, Seer), strictly read-only. Its phase 1 (P1-NOTES-A012) added the connector core under `src/connectors/`: one stateless connector per system that re-reads the sibling repo's `.env.local` on every call, connects only to the direct (non-pooler) host with `default_transaction_read_only=on` and runs each query in `BEGIN READ ONLY` with a statement timeout and a row cap; Seer's `lab.sqlite` is read in a short-lived, killable child process. It registers six generic tools (`expenses_schema`/`expenses_sql`, `runs_schema`/`runs_sql`, `seer_schema`/`seer_sql`) behind a single-SELECT guard, appends a `Connectors.` paragraph to the MCP instructions, fixes all 15 connector tool names in `src/connectors/names.ts`, leaves no-op curated stubs for phases 2-4, and adds a second Docker container whose databases are built from the sibling repos' own migrations.

**Key Responsibilities:**
- Resolve runtime config (`DATABASE_URL`, port, loopback host, data dir, chat brain settings) from `.env.local` plus the environment
- Own the whole schema for iterations 1-3 (`notes`, `note_revisions`) and its single migration `drizzle/0000_init.sql`
- Build one Drizzle type over two drivers: Neon websocket pool in production, `pg` for the Docker test database
- Generate and normalise short note ids (`A-B32`)
- Parse `#hashtags` from note bodies into the `tags` column (pure module, shareable with the web app)
- Create, read, update, append, soft-delete, restore and revert notes atomically, keeping every prior body as a revision in the same transaction
- List and full-text search notes with tag, date, image and deleted filters plus offset cursors
- Serve the notes to Claude Code as MCP tools over loopback HTTP, and emit in-process change events
- Serve image notes over HTTP (upload, original, display, thumb, preview) and to Claude through `create_image` / `view_images` (phase 5)
- Serve the web UI a JSON API, an SSE change feed, a streamed chat endpoint (a Claude Agent SDK run over the notes MCP tools, GLM fallback) and the built SPA
- Ship the web UI itself (`web/`, built to `web/dist` by Vite): a live note wall with inline editing, tag filters, visibility modes, a chat panel, a photo gallery and modal, a full-screen image tab and image upload
- Run `notesd` as an always-on systemd user service in WSL, registered with Claude Code as the `notes` MCP server and driven by the `/n` skill
- Expose the owner's expense-tracking, run-insights and Seer databases (plus Seer's `lab.sqlite`) over MCP as read-only `<system>_schema` / `<system>_sql` tools, with fail-soft, secret-free errors (iteration 5)

## Layout

```
src/config.ts          loadConfig, ConfigError, REPO_ROOT, defaults
src/db/schema.ts       Drizzle tables notes, note_revisions; ImageMeta, NoteOrigin; row types
src/db/client.ts       createDb / closeDb / isNeonUrl; Db type; re-exports schema
src/notes/ids.ts       generateId, normalizeId, parseId, isValidId, InvalidIdError
src/notes/tags.ts      parseTags, tagSpans, normalizeTag
src/notes/types.ts     wire Note/NoteImage/Revision/TagCount/NotePage, NoteError, rowToNote, cleanOrigin
src/notes/dates.ts     parseDateBound (YYYY-MM-DD local day or ISO datetime)
src/notes/events.ts    NoteEvents in-process bus (created/updated/deleted/restored)
src/notes/repo.ts      Drizzle queries: NoteFilter, list/search/insert/lock/revisions/tags, cursors
src/notes/service.ts   NotesService, the only writer of notes
src/mcp/instructions.ts buildInstructions(timeZone): MCP server instructions text (+ Connectors paragraph)
src/mcp/tools.ts       registerNoteTools (11 tools), noteFilterShape (+ has_image, taken_from/to), toFilter, ToolDeps (+ connectors?), run/jsonResult (compact), IMAGE_FILTER_HINT
src/mcp/imageTools.ts  registerImageTools: create_image, view_images; describeImageNote, VIEW_IMAGES_MAX
src/mcp/server.ts      createMcpServer (notes, image and connector tools), handleMcpRequest (stateless, JSON responses)
src/connectors/names.ts     CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES (all 15), ALL_CONNECTOR_TOOL_NAMES, SYSTEM_META, schemaToolName/sqlToolName
src/connectors/types.ts     QueryResult, QueryOptions, ReadOnlySource, Connector(s), SystemAbout, ConnectorError, row/timeout limits
src/connectors/errors.ts    scrub, reasonOf, unreachable, queryFailed (secret-free ConnectorError messages)
src/connectors/env.ts       per-call settings, repo dir resolution, sibling .env.local parse, direct-URL pick, secretsOf
src/connectors/rows.ts      clampMaxRows, wrapWithLimit, stripTrailingSemicolons, capRows, int8Value, toObjects
src/connectors/pg.ts        runPgQuery: one read-only pg Client per query, CONNECTOR_PG_TYPES, startupOptions
src/connectors/lab.ts       runLabQuery: lab.sqlite via node:sqlite in a SIGKILL-able child process
src/connectors/guard.ts     guardSelect / maskSql / SqlRefused: one SELECT or WITH ... SELECT only
src/connectors/connector.ts createConnector(id, options): stateless Connector (+ lab for Seer)
src/connectors/schema.ts    registerSchemaTool (<id>_schema), describePgSchema, describeLabSchema
src/connectors/sql.ts       registerSqlTool (<id>_sql)
src/connectors/register.ts  defaultConnectors, registerConnectorTools
src/connectors/{expenses,runs,seer}/index.ts    <ID>_ABOUT texts, create<Id>Connector
src/connectors/{expenses,runs,seer}/curated.ts  register<Id>Curated (phase 1: no-op stubs; phases 2-4 fill them; runs filled in phase 3)
src/connectors/runs/curated.ts   registerRunsCurated: runs_list, runs_get, runs_review (+ runsList/runsGet/runsReview)
src/connectors/runs/queries.ts   curated SQL (/* runs:* */), row shapers (runMetrics, periodTotals, splitOut, zonesOut, insightOut), read helpers
src/connectors/runs/periods.ts   WIB days, ISO week / month keys: resolvePeriod, resolveRange, isRealDate, todayInWib
src/connectors/runs/format.ts    unit helpers: metresToKm, formatDuration ("h:mm:ss"), formatPace ("m:ss /km"), hrDrop1Min, percentOf
src/http/app.ts        createApp: /health, /mcp (+ loopbackOnly guard), mounts the routers below
src/http/api.ts        apiRoutes: /api/notes CRUD, /api/tags, /api/events (SSE), /api/chat (SSE)
src/http/static.ts     staticRoutes: web/dist SPA, /assets, /full/:id, 503 when not built
src/http/images.ts     imageRoutes: POST /api/images, GET /api/notes/:id/{original,display,thumb,preview}
src/http/imageAccess.ts shared HTTP/MCP image glue: resolveImageFile, ingestFromUpload/Path, ImageInputError, etagMatches
src/chat/backend.ts    ChatBackend, ChatRequest, ChatTurn, ChatEvent, ChatTurnEnd, ChatBrain (the chat brain seam)
src/chat/stub.ts       createStubChatBackend, STUB_REPLY, splitIntoDeltas
src/chat/agent.ts      createAgentChatBackend (the real brain: Agent SDK run per message, GLM fallback, guardrails)
src/chat/env.ts        claudeEnv, glmEnv, resolveExecutable, STRIPPED_ENV_KEYS/PREFIX, CLIENT_APP
src/chat/prompt.ts     buildChatSystemPrompt (date/time/tz, id quoting, plain prose)
src/chat/status.ts     allowedChatTools, captionForToolUse, NOTES_TOOL_NAMES, WEB_TOOL_NAMES
src/deps.ts            AppDeps { config, db, events, service }
src/daemon.ts          startDaemon (+ StartDaemonOptions.chat), ensureDataDirs, DATA_SUBDIRS, CHAT_SUBDIR
src/background.ts      startBackground: ensures data dirs, starts the inbox watcher
src/images/probe.ts    magic-byte sniff, probeImage (mime, oriented size, EXIF taken_at), sha256Hex, HEIC decode
src/images/store.ts    data-dir paths, images/YYYY/MM/<id>.<ext>, atomic write/copy/move (EXDEV-safe)
src/images/derive.ts   lazy cache/<id>/{thumb.webp,preview.jpg,display.jpg}
src/images/records.ts  ImageRecords: raw read-only image lookups by sha256 / id
src/images/ingest.ts   ingestImage (dedupe by sha256, store, create note), locateImage, imageDeps
src/images/inbox.ts    startInboxWatcher (chokidar on <dataDir>/inbox, failures to inbox/failed/)
src/main.ts            notesd entry: loadConfig, startDaemon, SIGINT/SIGTERM shutdown
drizzle/               0000_init.sql + meta/ (generated by drizzle-kit; do not hand-edit)
drizzle.config.ts      drizzle-kit config, picks the DIRECT (unpooled) Neon URL
scripts/test-int.sh    starts/reuses Docker containers mcp-notes-pg-test (55433) and mcp-notes-pg-connectors (55435), runs integration suite
scripts/install.sh     idempotent WSL install: deps, build, systemd user unit, linger, MCP registration, /n skill link
scripts/uninstall.sh   removes the unit, the MCP registration and the skill link (keeps data dir and linger)
scripts/windows/install-wsl-keepalive.ps1  Task Scheduler logon task keeping the WSL distro up (-Uninstall removes it)
deploy/notesd.service  systemd user unit template (@NODE_BIN@ @NODE_DIR@ @REPO_DIR@ @DATA_DIR@ @CLAUDE_BIN@ @HOME_DIR@), rendered by install.sh
claude/skills/n/SKILL.md  the /n Claude Code skill, symlinked to ~/.claude/skills/n
docs/INSTALL.md        install, WSL keepalive rationale, post-merge re-install, uninstall, troubleshooting
tests/unit/            vitest unit tests (node)
tests/integration/     *.int.test.ts, setup.ts helpers, globalSetup.ts (migrates once)
tests/integration/connectors/  connector harness (harness.ts, siblings.ts), globalSetup.ts (builds connectors_<id> DBs), core/generic/mcp int tests, runs.curated.int.test.ts
tests/live/            chat.live.test.ts (npm run test:live), connectors.live.test.ts (npm run test:live:connectors)
vitest.config.ts       the only vitest config; switches mode on VITEST_INTEGRATION=1, CHAT_LIVE_TEST=1 or CONNECTORS_LIVE_TEST=1
tsconfig.json          typecheck (noEmit); tsconfig.server.json builds src/ to dist/
tsconfig.web.json      web typecheck (noEmit, DOM libs, react-jsx, Bundler resolution), include web/src
web/index.html         SPA entry (#root, dark color-scheme), loads web/src/main.tsx
web/fullscreen.html    full-screen image entry (black body, title 'Image'), loads web/src/fullscreen/main.tsx
web/vite.config.ts     Vite config: root web/, outDir web/dist, inputs index + fullscreen, dev proxy of /api /mcp /health to notesd
web/tsconfig.json      extends ../tsconfig.web.json (for editors inside web/)
web/src/               React app; see "Web UI: web/ (phases 7-8)" below
web/dist/              build output, gitignored, served by staticRoutes
```

## Exported API

### src/config.ts

#### Constants
- `REPO_ROOT: string`: repo root resolved from the module's own location, so `.env.local` is found whatever the cwd. Works from both `src/` (tsx, vitest) and `dist/` (built).
- `DEFAULT_PORT = 7317`
- `LOOPBACK_HOST = '127.0.0.1'`
- `DEFAULT_DATA_DIR = '~/mcp-notes-data'`
- `DEFAULT_CHAT_MAX_TURNS = 24`, `DEFAULT_CHAT_TIMEOUT_MS = 180_000`, `DEFAULT_CLAUDE_BIN = 'claude'`
- `DEFAULT_CHAT_CONFIG: ChatConfig`: `{ brain: 'claude', maxTurns: 24, timeoutMs: 180000, claudeBin: 'claude', glm: null }`, what `loadConfig` returns when no chat key is set. Tests that build `Config` literals use it.

#### Config
```ts
interface Config {
  databaseUrl: string          // runtime URL; pooled Neon host in production
  port: number                 // NOTESD_PORT, default 7317; 0 = any free port (tests)
  host: '127.0.0.1'            // always loopback, the daemon has no auth
  dataDir: string              // absolute; NOTES_DATA_DIR, default ~/mcp-notes-data; not created here
  chat: ChatConfig             // the chat bar brain (POST /api/chat)
}
interface ChatConfig {
  brain: ChatBrain             // CHAT_BRAIN: 'claude' (default) | 'glm' (GLM only, no fallback); case-insensitive
  maxTurns: number             // CHAT_MAX_TURNS, default 24, integer >= 1
  timeoutMs: number            // CHAT_TIMEOUT_MS, default 180000, wall clock per message, integer >= 1
  claudeBin: string            // NOTESD_CLAUDE_BIN, default 'claude' (PATH lookup); anything with '/' is ~-expanded and made absolute
  glm: GlmConfig | null        // set only when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all set
}
interface GlmConfig { baseUrl: string; apiKey: string; model: string }   // LLM_* -> child's ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / model; apiKey never logged
interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv      // default process.env; never mutated
  envFile?: string | false     // default <REPO_ROOT>/.env.local; false skips; missing file is fine
}
```

#### loadConfig
```ts
function loadConfig(options?: LoadConfigOptions): Config
```
Merges the dotenv file under the real environment (real env wins). Database URL choice:
1. `DATABASE_URL` in the real env wins outright (how tests point the daemon at Docker Postgres).
2. Otherwise, of `DATABASE_URL` / `DATABASE_URL_UNPOOLED`, the pooled one (`-pooler` in host) if any, else whichever exists. Selection goes by host, not key name, because the owner's `.env.local` has the two names swapped.

Throws `ConfigError` when no database URL is set, on a non-integer or >65535 port, when `NOTESD_HOST` is anything but empty or `127.0.0.1`, when `CHAT_BRAIN` is not `claude`/`glm`, when `CHAT_MAX_TURNS`/`CHAT_TIMEOUT_MS` is not a positive integer, or when `CHAT_BRAIN=glm` and any `LLM_*` key is missing (the message names the missing keys). With `CHAT_BRAIN=claude` and incomplete `LLM_*`, `glm` is null and Claude runs have no fallback. Unknown keys (`OPENROUTER_API_KEY`) are ignored. Synchronous file read; no other side effects.

#### isPooledUrl
```ts
function isPooledUrl(url: string): boolean
```
True when the URL parses and its host contains `-pooler`. Never throws.

#### ConfigError
`class ConfigError extends Error`, `name = 'ConfigError'`.

### src/db/schema.ts

#### notes
| column | type | notes |
|---|---|---|
| `id` | text PK | canonical `A-B32` |
| `body` | text not null | |
| `tags` | text[] not null default `'{}'` | from `parseTags(body)` on every write |
| `image_path` | text | relative to data dir: `images/YYYY/MM/<id>.<ext>` |
| `image_meta` | jsonb `ImageMeta` | written by image ingest (iteration 2) |
| `origin` | jsonb `NoteOrigin` | `cwd`, `repo`, `claude_session`, `source` (`mcp`/`web`/`inbox`/`upload`) |
| `created_at`, `updated_at` | timestamptz not null default now() | |
| `deleted_at` | timestamptz | soft delete; null = live |

Indexes: GIN on `tags`; GIN on `to_tsvector('simple', body)`; btree on `created_at`, `updated_at`; unique on `image_meta->>'sha256'` where image_meta is not null and the note is live; btree on `image_meta->>'taken_at'`.

#### note_revisions
| column | type | notes |
|---|---|---|
| `id` | bigserial PK | revision number used by the `revisions` / `revert` tools |
| `note_id` | text not null, FK `notes.id` on delete cascade | |
| `body` | text not null | body as it was BEFORE the change |
| `saved_at` | timestamptz not null default now() | |

Index: `(note_id, saved_at desc)`.

#### Types
- `ImageMeta`: `{ sha256, mime, width, height, bytes, taken_at: string|null (UTC ISO 'Z'), original_name: string|null, host: string|null }`
- `NoteOrigin`: `{ cwd?, repo?, claude_session?, source? }`
- `NoteRow`, `NewNoteRow`, `NoteRevisionRow`, `NewNoteRevisionRow`: Drizzle `$inferSelect` / `$inferInsert`.

The schema is final for iterations 1-3: later phases must not add a migration.

### src/db/client.ts

```ts
type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }
function isNeonUrl(url: string): boolean            // host is neon.tech or *.neon.tech; throws on unparseable URL
function createDb(url: string): Db
function closeDb(db: Db): Promise<void>             // ends the pool; call once per createDb
export { schema }
```
`createDb` picks the driver by host. For `*.neon.tech` it uses `drizzle-orm/neon-serverless` over the `@neondatabase/serverless` websocket `Pool` (sets `neonConfig.webSocketConstructor = ws`, a global side effect). Interactive `db.transaction` works there, unlike neon-http. Any other host goes through `drizzle-orm/node-postgres` with `pg.Pool`. Both are typed as the node-postgres `Db`, so callers write against one API. No I/O until the first query.

```ts
const db = createDb(loadConfig().databaseUrl)
try { /* queries */ } finally { await closeDb(db) }
```

### src/notes/ids.ts

```ts
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ID_PATTERN = /^[0-9A-Z]-[0-9A-Z]{3}$/          // canonical only
const ID_SPACE = 36 ** 4                              // 1,679,616
function generateId(random?: (max: number) => number): string   // default crypto.randomInt
function isValidId(value: string): boolean            // canonical form only
function normalizeId(input: string): string | null    // 'ab32', 'a-b32', ' A-B32 ' -> 'A-B32'
function parseId(input: string): string               // normalizeId or throw InvalidIdError
class InvalidIdError extends Error { readonly input: string }
```
`generateId` does not check uniqueness. The caller inserts and retries on a primary-key conflict. It throws `RangeError` if an injected `random` returns an out-of-range index.

### src/notes/tags.ts

```ts
interface TagSpan { start: number; end: number; tag: string }   // start = index of '#'
function tagSpans(body: string): TagSpan[]     // every occurrence, in order, with repeats
function parseTags(body: string): string[]     // lower-cased, deduped, first-appearance order
function normalizeTag(input: string): string | null   // '#Seer', ' SEER ' -> 'seer'
```
A tag is `#` followed by `[A-Za-z0-9_-]+`, where the `#` must not come right after a word character, so `C#` and `a#b` are not tags. The module is pure, with no Node imports, so the web app can import it.

### src/notes/types.ts

```ts
interface Origin { cwd?; repo?; claude_session?; source? }          // all optional strings
interface NoteImage { mime; width; height; bytes; taken_at: string|null; original_name: string|null; host: string|null; available: boolean }
interface Note { id; body; tags: string[]; created_at; updated_at; deleted_at?; origin: Origin|null; image: NoteImage|null }
interface Revision { revision: number; note_id; body; saved_at }
interface TagCount { tag; count: number; last_used }
interface NotePage { notes: Note[]; next_cursor: string|null }
type NoteErrorCode = 'invalid_id'|'invalid_input'|'not_found'|'deleted'|'empty_body'|'conflict'|'duplicate_image'|'invalid_revision'
class NoteError extends Error { readonly code: NoteErrorCode }
function cleanOrigin(value: unknown): Origin | null       // keeps known non-blank string keys; null if none left
function imageAvailable(dataDir: string, imagePath: string): boolean   // file exists and stays inside dataDir
function rowToNote(row: NoteRow, dataDir: string): Note
```
`Note` is the wire shape shared by MCP, HTTP and the UI. All timestamps are UTC ISO strings. `deleted_at` is present only on deleted notes. `image` is null unless both `image_path` and `image_meta` are set, and `image.available` is checked against the local data dir on every conversion. `NoteError` is the only error the service throws on purpose. HTTP (phase 6) maps `code` to a status.

### src/notes/dates.ts

```ts
function parseDateBound(value: string, bound: 'from' | 'to'): Date
```
`YYYY-MM-DD` is a whole day in the process's local timezone: `from` gives that day's local midnight and `to` gives the next day's midnight. An ISO datetime (must contain `T`) is exact, and a `to` bound gets +1 ms. Callers compare `col >= from AND col < to`, so both bounds are inclusive. Invalid input throws `NoteError('invalid_input')`.

### src/notes/events.ts

```ts
type NoteOp = 'created' | 'updated' | 'deleted' | 'restored'
interface NoteEvent { type: 'note'; op: NoteOp; id: string }
class NoteEvents {
  emit(op: NoteOp, id: string): void
  on(listener: (e: NoteEvent) => void): () => void   // returns unsubscribe
  listenerCount(): number
}
```
In-process `EventEmitter` wrapper with no listener cap. `NotesService` is the only emitter. SSE (phase 6) subscribes.

### src/notes/repo.ts

```ts
type Tx; type Executor = Db | Tx
const DEFAULT_LIMIT = 50, MAX_LIMIT = 5000
interface NoteFilter {
  tagsAny?: string[]; tagsAll?: string[]
  dateField?: 'created' | 'updated'      // default 'created'; also the list sort column
  from?: string; to?: string             // via parseDateBound
  hasImage?: boolean                     // true = image notes, false = text notes, undefined = both
  takenFrom?: string; takenTo?: string   // EXIF taken_at range, via parseDateBound; image notes with a date only
  deleted?: 'exclude' | 'include' | 'only'   // default 'exclude'
  limit?: number; cursor?: string
}
function normalizeTagInput(tags?): string[]       // strip '#', trim, lower-case, dedupe
function encodeCursor(offset: number): string     // base64url JSON {o}
function decodeCursor(cursor?: string): number    // bad cursor -> NoteError('invalid_input')
function clampLimit(limit?: number): number       // 1..MAX_LIMIT
function filterConditions(filter): SQL[]
listNotes(db, filter): Promise<RowPage>           // order: date col desc, id desc
searchNotes(db, query, filter): Promise<RowPage>  // websearch_to_tsquery('simple'); ts_rank desc, updated_at desc, id desc
findNotesByIds, findNoteById, lockNote (SELECT ... FOR UPDATE), findNoteBySha256(db, sha, includeDeleted)
insertNote(db, values): Promise<NoteRow | null>   // null on id clash; sha256 unique clash -> NoteError('duplicate_image')
idExists, setBody, setOrigin, setDeleted, insertRevision, listRevisions (newest first), getRevision
listTags(db): Promise<TagRow[]>                   // live notes only; count desc, tag asc
```
Paging fetches `limit + 1` rows with an offset cursor. `next_cursor` is non-null only when another page exists. `takenFrom`/`takenTo` compare `image_meta->>'taken_at'` as text against `parseDateBound(...).toISOString()` (`>= from`, `< to`). That works because `taken_at` is always a UTC ISO `Z` string, and it uses the `taken_at` btree index. Notes with no EXIF date never match a taken bound. MCP exposes `hasImage`/`takenFrom`/`takenTo` as `has_image`/`taken_from`/`taken_to`; `/api/notes` exposes only `has_image`. The search vector expression must stay `to_tsvector('simple', body)` to hit the GIN index.

### src/notes/service.ts

```ts
const MAX_ID_ATTEMPTS = 20
class NotesService {
  constructor(deps: { db: Db; dataDir: string; events: NoteEvents })
  requireId(input: string): string                    // normalizeId or NoteError('invalid_id')
  newId(): Promise<string>                            // free id, for callers that must name a file first
  create(input: { body; origin?; image?: { path; meta }; allowEmpty?; id? }): Promise<Note>
  getOne(id, { includeDeleted? }): Promise<Note | null>
  get(ids, { includeDeleted? }): Promise<{ notes; missing; deleted }>   // input order, deduped
  findBySha256(sha256, { includeDeleted? }): Promise<Note | null>
  list(filter?: NoteFilter): Promise<NotePage>
  search(query, filter?): Promise<NotePage>           // blank query -> invalid_input
  tags(): Promise<TagCount[]>
  revisions(id): Promise<Revision[]>                  // not_found if the id has no note
  update(id, body, { origin?, allowEmpty? }): Promise<Note>
  append(id, text, { origin? }): Promise<Note>        // joins with a blank line
  delete(id): Promise<Note>                           // soft; no-op if already deleted
  restore(id): Promise<Note>                          // no-op if live
  revert(id, revision: number): Promise<Note>
}
```
Every mutation runs in one transaction that locks the row (`FOR UPDATE`), writes the previous body to `note_revisions`, then writes the new state. Delete also stores the body as a revision. Exactly one `NoteEvents` event is emitted after commit, and none for a no-op: an unchanged body on update, a revert to an identical body, a repeat delete or restore. `update`, `append` and `revert` on a deleted note throw `deleted`. `create` retries generated ids up to 20 times on a PK clash. With an explicit `id`, a clash throws `conflict` without retry. `allowEmpty` exists for HTTP and image notes. MCP never sets it.

### src/mcp/instructions.ts

```ts
function localTimeZone(): string                    // Intl resolved IANA zone
function buildInstructions(timeZone?: string): string
```
The server-instructions text Claude reads once per session. It covers the note model, id format, writing and revision semantics, reading and search syntax, and date semantics (it names the daemon's timezone). It also says comparisons are Claude's job. Phase 5 added an `Images.` section: the `image` field shape, `available: false` meaning the file is on another host, `view_images` with up to 8 ids, saved-date queries (`has_image` + `from`/`to`) versus taken-date queries (`taken_from`/`taken_to`), and `create_image` copying a local file with dedupe. Iteration 5 phase 1 appended a `Connectors.` section: the three systems and their `expenses_*` / `runs_*` / `seer_*` prefixes, strictly read-only, prefer the curated tools (the list is generated from `CONNECTOR_TOOL_NAMES`, skipping each system's first two), fall back to `<system>_sql` only after `<system>_schema`, units and timezone (Asia/Jakarta days, whole rupiah, Seer in USD), and "if a system is not reachable, say so and answer from the rest".

### src/mcp/tools.ts

```ts
interface ToolDeps { service: NotesService; dataDir: string; db: Db; connectors?: Connectors }   // db is read-only, for phase 5; connectors omitted = defaultConnectors()
const MCP_MAX_LIMIT = 200, MCP_DEFAULT_LIMIT = 50
const IMAGE_FILTER_HINT // sentence appended to the list and search descriptions
const noteFilterShape   // zod: tags_any, tags_all, date_field, from, to, has_image, taken_from, taken_to, deleted, limit, cursor
function toFilter(args: FilterArgs): NoteFilter     // snake_case -> NoteFilter, limit defaults to 50
function jsonResult(value, compact = false): CallToolResult   // pretty JSON text content; compact = no indentation (connector tools)
function errorResult(err): CallToolResult            // isError, "<code>: <message>" for NoteError, bare message for ConnectorError
interface RunOptions { compact?: boolean }
function run(fn, options?: RunOptions): Promise<CallToolResult>
function registerNoteTools(server: McpServer, deps: ToolDeps): void
```
| tool | input | returns |
|---|---|---|
| `create` | `body`, `origin?{cwd,repo,claude_session}` | `{ note }` (origin gets `source: 'mcp'`) |
| `get` | `ids[1..100]`, `include_deleted?` | `{ notes, missing, deleted }` |
| `update` | `id`, `body`, `origin?` | `{ note }` |
| `append` | `id`, `text` | `{ note }` |
| `delete` / `restore` | `id` | `{ note }` |
| `list` | `noteFilterShape` | `{ notes, next_cursor }` |
| `search` | `query` + `noteFilterShape` | `{ notes, next_cursor }` |
| `tags` | none | `{ tags }` |
| `revisions` | `id` | `{ revisions }` |
| `revert` | `id`, `revision` | `{ note }` |

Errors never throw out of a handler. They come back as `isError` results.

### src/mcp/imageTools.ts

```ts
const VIEW_IMAGES_MAX = 8
function describeImageNote(note: Note): string     // id, saved, taken (or 'unknown (no EXIF date)'), WxH mime size, original name, tags, body
function registerImageTools(server: McpServer, deps: ToolDeps): void
```
| tool | input | returns |
|---|---|---|
| `create_image` | `path` (absolute or `~/`), `body?`, `origin?` | `{ note, created }`; origin gets `source: 'mcp'` |
| `view_images` | `ids[1..8]` | per id: a metadata text block, then an MCP `image` block (the preview JPEG, base64) |

`create_image` goes through `ingestFromPath`, which copies the file (never moves it) and dedupes by sha256 (`created: false`). An `ImageInputError` comes back as `isError` text `create_image refused (<code>): <message>`. `view_images` loads the notes with `includeDeleted`, keeps input order, and answers with a text line instead of an image for an unknown id, a deleted note, a text note, a file on another host (`image not on this machine: the file lives on <host>`) or a preview that failed to generate. It always serves the `preview` variant (long edge <= 1568, <= 3.75 MB), so the payload stays under Claude's image limit.

### src/http/imageAccess.ts

```ts
const MAX_IMAGE_BYTES = 200 * 1024 * 1024
type ImageVariant = 'original' | 'display' | 'thumb' | 'preview'
interface ServedFile { absPath; mime; etag; size; immutable }
type ResolveResult =
  | { status: 'ok'; loc: LocatedImage; file: ServedFile; servedOriginal: boolean }
  | { status: 'not_found' } | { status: 'no_image'; id } | { status: 'not_on_this_machine'; id; host: string | null }
type ImageInputErrorCode = 'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large'
class ImageInputError extends Error { readonly code: ImageInputErrorCode }
function toolImageDeps(deps: ToolDeps): ImageDeps      // ImageDeps from ToolDeps (MCP gets ToolDeps, not AppDeps)
function expandHome(p, home?): string                   // '~' and '~/...' only
function etagMatches(header, etag): boolean             // If-None-Match lists, W/ weak tags, '*'
function resolveImageFile(img, rawId, variant): Promise<ResolveResult>
function ingestFromUpload(img, file: File, body?, maxBytes?): Promise<{ note; created }>   // origin.source = 'web'
function ingestFromPath(img, rawPath, body?, origin): Promise<{ note; created }>           // move: false
```
The one place HTTP and MCP share image logic. `resolveImageFile` normalises the id and calls `locateImage`. A deleted note or a bad id is `not_found`, a live text note is `no_image`, and an original that is missing locally (checked up front via `available`, and again when a derive getter throws `OriginalMissingError`) is `not_on_this_machine` with `image_meta.host`. Cached derivatives are never served once the original is gone. ETags are `"<sha256>"` for the original (and for `display` when it is the original) and `"<sha256>-<variant>"` for derivatives. Only originals are `immutable`. Both ingest helpers reject empty and oversized input, blank bodies become no body, and they map `UnsupportedImageError` to `ImageInputError('not_an_image')`.

### src/http/images.ts

```ts
interface ImageRouteOptions { maxUploadBytes?: number }   // default MAX_IMAGE_BYTES; tests lower it
function imageRoutes(deps: AppDeps, opts?: ImageRouteOptions): Hono
```
| route | input | success |
|---|---|---|
| `POST /api/images` | multipart: `file` (required), `body?` | 201 `{ note, created: true }`, or 200 with `created: false` on a dedupe hit |
| `GET /api/notes/:id/original` | any id spelling | the stored bytes, `Content-Disposition: inline` with the original name |
| `GET /api/notes/:id/display` | | the original if browser-displayable, else `display.jpg` |
| `GET /api/notes/:id/thumb` | | `thumb.webp` (480 px wide) |
| `GET /api/notes/:id/preview` | | `preview.jpg` (long edge <= 1568) |

The upload is capped by `bodyLimit` at `maxUploadBytes + 1 MB` (multipart overhead), then again on the file size. Image GETs stream the file and set `ETag`, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy`, and `Cache-Control: private, max-age=31536000, immutable` for originals or `private, max-age=86400` for derivatives. A matching `If-None-Match` returns 304. `createApp` calls `imageRoutes(deps)` with no options.

### src/mcp/server.ts

```ts
const SERVER_NAME = 'mcp-notes', SERVER_VERSION = '0.1.0'
function createMcpServer(deps: ToolDeps): McpServer
function handleMcpRequest(req: Request, deps: ToolDeps): Promise<Response>
```
The server is stateless. Each POST gets a fresh `McpServer` and a `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` and no session id generator, and both are closed after the response. A daemon restart therefore never strands a client. `createMcpServer` registers the note tools, the image tools, then `registerConnectorTools(server, deps.connectors ?? defaultConnectors())`. That is lazy: nothing is read or connected until a connector tool is called.

### Connectors: src/connectors/ (iteration 5 phase 1)

Read-only access to the owner's three sibling apps. One `Connector` per system; no state is held between calls.

```ts
// names.ts
const CONNECTOR_SYSTEMS = ['expenses', 'runs', 'seer'] as const; type SystemId
const CONNECTOR_TOOL_NAMES   // per system: <id>_schema, <id>_sql, then 3 curated names (expenses_spending/get/months, runs_list/get/review, seer_leaderboard/positions/sera_best)
const ALL_CONNECTOR_TOOL_NAMES: readonly ConnectorToolName[]   // all 15, for the chat bar allow list (phase 5)
interface SystemMeta { id; label; repoDirEnv; defaultRepoDir; caption; hasLab }
const SYSTEM_META            // expenses: 'expense-tracking', EXPENSE_TRACKING_DIR, ~/expense-tracking
                             // runs: 'run-insights', RUN_INSIGHTS_DIR, ~/run-insights
                             // seer: 'seer', SEER_DIR, ~/seer, hasLab
function schemaToolName(id), sqlToolName(id)

// types.ts
const CONNECTOR_DEFAULT_ROWS = 200, CONNECTOR_MAX_ROWS = 1000, CONNECTOR_DEFAULT_TIMEOUT_MS = 10_000
interface QueryResult { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean }
interface QueryOptions { maxRows? }   // clamped to 1..1000, default 200
interface ReadOnlySource { query(sql, params?, options?): Promise<QueryResult> }   // trusted, parameterised; no guard
interface Connector extends ReadOnlySource { id; label; lab?: ReadOnlySource }   // lab: Seer only, positional `?` params
type Connectors = Record<SystemId, Connector>
interface SystemAbout { summary; db; lab? }
class ConnectorError extends Error   // message is user-facing and secret-free

// errors.ts
function scrub(text, secrets): string             // longest first, secrets < 3 chars ignored
function reasonOf(err): string                     // one line, unwraps AggregateError, max 300 chars
function unreachable(label, reason, secrets?)      // "<label> is not reachable: <reason>"
function queryFailed(label, reason, secrets?)      // "<label> query failed: <reason>"

// env.ts
const CONNECTOR_SETTINGS_FILE                      // mcp-notes' own .env.local
function connectorSettings(source?: SettingsSource) // EXPENSE_TRACKING_DIR, RUN_INSIGHTS_DIR, SEER_DIR, CONNECTOR_TIMEOUT_MS; env over file, read per call
function expandHome, displayPath, resolveRepoDir(id, settings), connectorTimeoutMs(settings)   // timeout 100..300000 else default
function pickDirectUrl(vars), prepareUrl(url), secretsOf(url)
function loadDatabaseTarget(id, repoDir): DatabaseTarget   // { url, secrets }; reads <repo>/.env.local every call

// rows.ts
function clampMaxRows, wrapWithLimit(sql, cap), stripTrailingSemicolons, capRows, int8Value
function toObjects(result): Record<string, unknown>[]      // keyed rows for curated tools

// pg.ts
const CONNECTOR_PG_TYPES       // int8 -> number when safe; numeric -> number; date/time/timestamp(tz)/interval -> text; json/bool pg default
function startupOptions(timeoutMs)   // -c default_transaction_read_only=on -c statement_timeout=<ms> -c TimeZone=Asia/Jakarta
function runPgQuery(label, target, sql, params, { cap, timeoutMs, wrap? }): Promise<QueryResult>

// lab.ts
const LAB_CHILD_SOURCE         // CommonJS run by `node --no-warnings -e`, node:sqlite DatabaseSync readOnly
function runLabQuery(label, labPath, sql, params, { cap, timeoutMs, wrap? }): Promise<QueryResult>

// guard.ts
type SqlDialect = 'postgres' | 'sqlite'; class SqlRefused extends Error
function maskSql(sql, dialect): string   // blanks comments, literals, quoted identifiers, dollar quotes
function guardSelect(sql, dialect): string

// connector.ts
interface ConnectorOptions { repoDir?; labPath?; timeoutMs?; settings?: SettingsSource }   // fixed values for tests
function createConnector(id, options?): Connector

// schema.ts / sql.ts / register.ts
function describePgSchema(source, only?): Promise<TableInfo[]>   // public tables/views, columns, comments, approx_rows, PK/UK/FK
function describeLabSchema(lab, only?): Promise<TableInfo[]>
function registerSchemaTool(server, connector, about), registerSqlTool(server, connector, about)
function defaultConnectors(): Connectors
function registerConnectorTools(server, connectors): void   // _schema + _sql for every system, then each curated stub
// per system: EXPENSES_ABOUT/RUNS_ABOUT/SEER_ABOUT, create{Expenses,Runs,Seer}Connector, register{Expenses,Runs,Seer}Curated
```

| tool | input | returns |
|---|---|---|
| `<id>_schema` | `tables?` (exact names, up to 100) | `{ system, source: 'db', about, tables }` |
| `seer_schema` | `tables?`, `source?` `db` / `lab` / `both` (default) | one part, or `{ system, db, lab }` with a failed side as `{ error }` (throws only when both fail) |
| `<id>_sql` | `sql` (one SELECT / WITH ... SELECT), `max_rows?` 1..1000 (default 200) | `{ columns, rows, row_count, truncated }` |
| `seer_sql` | as above, plus `source?` `db` (default, Postgres) or `lab` (SQLite) | same |

All connector tools carry `readOnlyHint` and `openWorldHint` and answer compact JSON through `run(..., { compact: true })`. Every query goes: `connectorSettings` (per call), `resolveRepoDir`, `loadDatabaseTarget` (direct URL chosen by host, `options` param dropped, `sslmode=require|prefer` rewritten to `verify-full`), a fresh `pg.Client` with the read-only startup options, `BEGIN READ ONLY`, the SQL wrapped as `SELECT * FROM (<sql>) AS q LIMIT cap+1` in array row mode, `ROLLBACK`, `end()`. The extra row sets `truncated`. The lab path is `<repo>/lab/lab.sqlite`, read in a child with an empty env that is SIGKILLed at the timeout; bigints come back as numbers when safe, blobs as `<blob N bytes>`. `<id>_sql` runs `guardSelect` first: it refuses an empty query, more than one statement, anything not starting with SELECT or WITH, write/DDL/transaction words (INSERT, UPDATE, DELETE, INTO, CREATE, PRAGMA, ATTACH, BEGIN, ...), calls to effectful functions (`pg_terminate_backend`, `set_config`, `pg_read_file`, `dblink*`, `pg_advisory_*`, `load_extension`, ...) and row locks (`FOR UPDATE` / `FOR SHARE`). Refusals read `<label> query failed: refused before reaching the database: <why>`. The guard is a convenience; the read-only session and transaction are the real barrier. Curated stubs in `src/connectors/{expenses,runs,seer}/curated.ts` register nothing in phase 1; phases 2-4 replace them and must use `run(..., { compact: true })` and `toObjects`.

Run-insights curated tools (phase 3, P1-NOTES-A014), all compact and `readOnlyHint`, dates as WIB calendar days, raw app units each with a readable companion (km, `h:mm:ss`, `m:ss /km`):

| tool | input | returns |
|---|---|---|
| `runs_list` | `from` YYYY-MM-DD, `to?` (default today) | `{ from, to, totals, runs, truncated }`: reviewed runs only, newest first, with headline/verdict of the app's analysis; totals use distance-weighted pace and time-weighted HR |
| `runs_get` | exactly one of `id` or `date` | `{ id \| date, ... }` full metrics, per-km splits (last flagged partial), HR zones 1-5, note, `reviewed`, latest analysis, `profile`; unreviewed runs included; unknown id or unreal date throws |
| `runs_review` | `scope` `week` (ISO) / `month`, `key?` (`2026-W34`, `2026-08` or a day inside; default current) | `{ scope, key, from, to, review, review_missing, totals, runs }` (brief runs); `review` null when the app stored none |

### src/http/app.ts

```ts
const loopbackOnly: MiddlewareHandler     // 403 JSON-RPC error unless URL host and any Origin are loopback
interface CreateAppOptions { chat?: ChatBackend }   // omitted: apiRoutes' default (the stub)
function createApp(deps: AppDeps, options?: CreateAppOptions): Hono
```
Mount order is fixed: `GET /health` returns `{ ok: true, service: 'notesd' }`. `POST /mcp` sits behind `loopbackOnly` (a DNS-rebinding guard), and `GET`/`DELETE /mcp` return 405 with `Allow: POST`. After those come `apiRoutes` (P6), `imageRoutes` (P5) and `staticRoutes` (P6, last, because it owns the SPA fallback). Later phases fill the routers in `api.ts`, `images.ts` and `static.ts` and must not edit this file. `createApp` passes `options.chat` through to `apiRoutes` (stub when omitted) and always uses the 25 s heartbeat.

### src/http/api.ts

```ts
const DEFAULT_LIST_LIMIT = 2000
const MAX_LIST_LIMIT = MAX_LIMIT            // 5000, the repo cap
const SSE_HEARTBEAT_MS = 25_000
interface ApiOptions { chat?: ChatBackend; sseHeartbeatMs?: number }   // chat defaults to createStubChatBackend()
function apiRoutes(deps: AppDeps, options?: ApiOptions): Hono
```
| route | input | success |
|---|---|---|
| `GET /api/notes` | `limit` (1..5000, default 2000), `cursor`, `has_image=true\|false`, repeated `tag` (all must match; `#` stripped, lower-cased, deduped) | `{ notes, next_cursor }`, live notes only |
| `GET /api/notes/:id` | id in any form `normalizeId` accepts | `Note` (404 if missing or deleted) |
| `POST /api/notes` | `{ body: string }` | 201 `Note`; `origin.source = 'web'`, empty body allowed |
| `PATCH /api/notes/:id` | `{ body: string }` | `Note`; empty body allowed |
| `DELETE /api/notes/:id` | | `Note` (soft delete); 404 if the note is not live, so a repeat delete is 404 |
| `GET /api/tags` | | `TagCount[]` (bare array) |
| `GET /api/events` | | SSE, see below |
| `POST /api/chat` | `{ message: string (trimmed, non-empty), thread_id?: string (1..200) }` | SSE, see below |

`/api/events` opens with a `: connected` comment, then sends `event: note` with data `{ op, id }` for every `NoteEvents` emit (`created`/`updated`/`deleted`/`restored`), plus a `: heartbeat` comment every `sseHeartbeatMs`. On client abort it clears the timer and unsubscribes from `NoteEvents`.

`/api/chat` validates the body before streaming (bad input is a plain 400 JSON, not SSE). It then calls `chat.reply({ message, threadId, signal })` and writes each `ChatEvent` from `turn.events` as an SSE event of the same name: `event: delta` with `{ text }` (reply text; the deltas concatenate to the full reply) or `event: status` with `{ text }` (a progress caption such as `searching notes`; `""` clears it). When the events end it calls `turn.end()` and sends `event: done` with `{ thread_id, brain? }`; `brain` (`claude` | `glm`) is omitted when the backend reports none, as the stub does. A throw from `reply()` or from `events` becomes `event: error` with `{ error }`. A client disconnect aborts the `AbortController` passed as `signal`, and nothing more is written.

### src/chat/backend.ts, src/chat/stub.ts

```ts
type ChatBrain = 'claude' | 'glm'
type ChatEvent = { type: 'delta'; text: string } | { type: 'status'; text: string }
interface ChatTurnEnd { threadId: string; brain?: ChatBrain }   // -> done.thread_id, done.brain
interface ChatRequest { message: string; threadId: string | null; signal: AbortSignal }
interface ChatTurn { events: AsyncIterable<ChatEvent>; end(): ChatTurnEnd }   // end() valid only after events finished without throwing
interface ChatBackend { reply(request: ChatRequest): Promise<ChatTurn> }

const STUB_REPLY = 'The chat brain arrives in iteration 4. Until then this panel only echoes that fact.'
interface StubChatOptions { delayMs?: number }          // per-delta delay, default 40; tests pass 0
function splitIntoDeltas(text: string): string[]        // word pieces keeping trailing whitespace
function createStubChatBackend(options?: StubChatOptions): ChatBackend
```
`ChatBackend` is the seam iteration 4 fills: `api.ts` is its only consumer, and the implementation arrives via `startDaemon(config, { chat })` -> `createApp` -> `ApiOptions.chat`. Implementations are the stub (tests) and the Agent SDK backend (`src/chat/agent.ts`, the default since iteration 4 phase 2). The stub ignores the message, keeps the client's `threadId` or mints `stub-<uuid>`, and streams `STUB_REPLY` word by word as `delta` events. It emits no `status` events and `end()` returns only `{ threadId }` (no brain). It stops yielding as soon as `signal` aborts, including mid-delay.

### src/chat/agent.ts, src/chat/env.ts, src/chat/prompt.ts, src/chat/status.ts (iteration 4 phase 2)

```ts
// agent.ts
type AgentChatConfig = Config['chat']
type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>   // slice of the SDK's query
interface AgentChatOptions {
  chat: AgentChatConfig; cwd: string; mcpUrl: () => string;
  query?: QueryFn; now?: () => Date; baseEnv?: NodeJS.ProcessEnv; log?: (line: string) => void
}
interface AgentChatBackend extends ChatBackend { close(): void }
const FALLBACK_ERRORS: ReadonlySet<SDKAssistantMessageError>   // authentication_failed, oauth_org_not_allowed, billing_error, rate_limit
const FALLBACK_TEXT: RegExp                                     // usage limit, rate limit, billing, not logged in, oauth, 401/403/429, ...
function createAgentChatBackend(options: AgentChatOptions): AgentChatBackend

// env.ts
type ChildEnv = Record<string, string | undefined>
interface GlmTarget { baseUrl: string; apiKey: string; model: string }
const STRIPPED_ENV_KEYS: readonly string[]   // ANTHROPIC_{API_KEY,BASE_URL,AUTH_TOKEN,MODEL,DEFAULT_*_MODEL}, LLM_API_KEY, CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT
const STRIPPED_ENV_PREFIX = 'CLAUDE_CODE_'
const CLIENT_APP = 'mcp-notes-chat/0.1.0'   // set as CLAUDE_AGENT_SDK_CLIENT_APP
function claudeEnv(base: NodeJS.ProcessEnv): ChildEnv
function glmEnv(base: NodeJS.ProcessEnv, glm: GlmTarget): ChildEnv
function resolveExecutable(bin: string, pathEnv: string | undefined): string

// prompt.ts
function buildChatSystemPrompt(now?: Date, timeZone?: string): string   // timeZone defaults to localTimeZone()

// status.ts
const NOTES_MCP_SERVER = 'notes'
const NOTES_TOOL_NAMES: readonly [13 names from mcp/tools + mcp/imageTools]
type NotesToolName
const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch']
function allowedChatTools(): string[]                                  // mcp__notes__<name> x13 + WebSearch, WebFetch
function captionForToolUse(name: string, input: unknown): string | null
```
`createAgentChatBackend` runs one SDK `query` per `reply()`. Every run gets: `cwd` (`<dataDir>/chat`), `settingSources: []`, `strictMcpConfig: true`, one MCP server `notes` of type `http` at `mcpUrl()` (read at run start, with `alwaysLoad`), built-in `tools` limited to WebSearch/WebFetch, `allowedTools` from `allowedChatTools()`, `permissionMode: 'dontAsk'`, `includePartialMessages`, `maxTurns: chat.maxTurns`, a fresh `buildChatSystemPrompt(now())` as the whole system prompt, `resume: threadId` when the client sent one, and `pathToClaudeCodeExecutable` from `resolveExecutable(chat.claudeBin, PATH)` (resolved once at construction). A Claude run uses `claudeEnv` (the daemon env minus every key, base URL, model override and parent-Claude-Code marker, so it runs on the owner's OAuth login; `CLAUDE_CONFIG_DIR` is kept). A GLM run uses `glmEnv` (same base plus `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL`/`DEFAULT_*_MODEL` from `chat.glm`) and `model: glm.model`.

Streaming: only top-level messages count (`parent_tool_use_id === null`). `stream_event` `text_delta`s become `delta` events. A top-level assistant `tool_use` block becomes a `status` caption from `captionForToolUse` (`searching notes`, `reading 3 notes`, `looking at a photo`, `searching the web`, `saving a note`, ...; repeats are not re-sent), and the next text clears it with `status ""`. Text that follows a tool use after earlier text is prefixed with a blank line (leading whitespace trimmed). A `result` of subtype `success` without `is_error` sets `end()` to `{ threadId: session_id, brain }`; the SDK session id is the thread id.

Guardrails: one run in flight per backend (a new `reply()` stops the previous one, `superseded`); the request `signal` (`client`), a `chat.timeoutMs` wall-clock timer (`timeout`, unref'd) and `close()` (`closed`, called by daemon `stop()`) all abort the SDK child. A stopped run throws `Chat stopped: ...` from `events`. `error_max_turns` throws `Chat stopped: the agent hit its N-turn cap ...` and never falls back.

Fallback: with `chat.brain = 'claude'` and `chat.glm` set, a Claude attempt that fails before any `delta` went out, was not stopped, and whose failure is fallbackable (an assistant `error` in `FALLBACK_ERRORS`, or result/exception text matching `FALLBACK_TEXT`) is retried once on GLM with the same `resume` id; a shown caption is cleared first and one line is logged (`notesd chat: claude failed before answering (...); retrying once on glm`). Once text has streamed a failure is final. `chat.brain = 'glm'` runs GLM only and never falls back; with `glm` null it fails with `CHAT_BRAIN=glm needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.` A CLI that exits non-zero after a successful result is treated as success.

The system prompt states today's weekday, ISO and long date, time and timezone; says the owner is the only user; requires every used note id quoted as `A-B32` (the panel highlights by id); allows edits only when asked (get before update, never save the answer as a note); explains `view_images`; and asks for plain prose (no headings, tables, bold or code blocks unless asked).

### src/http/static.ts

```ts
const DEFAULT_WEB_DIST: string          // <repo>/web/dist/, resolved from the module (works from src/ and dist/)
const WEB_NOT_BUILT_TEXT = 'web UI not built: run npm run build'
interface StaticOptions { webDist?: string }
function staticRoutes(deps?: AppDeps, options?: StaticOptions): Hono   // deps unused
```
One `GET *` handler, checked in this order:
1. Paths under `/api`, `/mcp` or `/health` get a plain 404, so an unknown API route never returns the SPA.
2. No `web/dist/index.html`: 503 text `WEB_NOT_BUILT_TEXT` with `Cache-Control: no-store`, for every path.
3. `/assets/*`: the file with `Cache-Control: public, max-age=31536000, immutable`, or 404 text.
4. `/full/:id`: `fullscreen.html` if present, else `index.html`.
5. Any other existing file in `web/dist`: served with a 1-hour cache (`.html` files get `no-cache`).
6. Everything else, including `/`: `index.html` with `no-cache` (SPA fallback).

Files are read only when they resolve to a regular file inside the dist root. Bad URI encoding, NUL bytes and `..` traversal all fall through to the not-found or fallback path. Content type comes from a fixed extension map, defaulting to `application/octet-stream`.

### Images: src/images/ (phase 4)

Image notes are ordinary notes whose `image_path` and `image_meta` are set. All note writes still go through `NotesService`. The image modules only place files and read raw image fields. Phase 5 reaches them through `src/http/imageAccess.ts` (`imageDeps`/`toolImageDeps`, `ingestImage`, `locateImage` and the derive getters).

`startBackground` (in `src/background.ts`) builds `imageDeps(deps)` and runs `images/store.ensureDataDirs`, which is idempotent (tests call it without `startDaemon`). It then starts the inbox watcher with `ingest = ingestImage(img, { path, move: true, origin: { source: 'inbox' } })`. The stop function it returns closes the watcher and waits for the queue to drain.

#### src/images/probe.ts
```ts
const SUPPORTED_IMAGE_MIMES      // jpeg png gif webp avif heic heif heic-sequence heif-sequence tiff
const BROWSER_DISPLAYABLE_MIMES  // jpeg png gif webp avif
function isBrowserDisplayable(mime): boolean; function isHeifMime(mime): boolean
class UnsupportedImageError extends Error { readonly detectedMime: string | null }
type SniffResult = { mime; ext }
type ImageProbe = { mime; mimeExt; width; height; taken_at: string | null }
function sha256Hex(bytes): string
function sniffImageBytes(bytes): Promise<SniffResult | null>   // magic bytes via file-type, never the extension
function sniffImageFile(path): Promise<SniffResult | null>     // reads the header only
function decodeHeicToJpeg(bytes, quality = 0.92): Promise<Buffer>   // heic-convert (WASM libheif), lazy-required
function exifDateToIso(value, offset?): string | null           // 'YYYY:MM:DD HH:MM:SS' (+offset) -> UTC ISO; no offset = local time
function probeImage(bytes): Promise<ImageProbe>                 // throws UnsupportedImageError
```
Width and height are display-oriented (sharp `autoOrient`). exifr reads `DateTimeOriginal` and `OffsetTimeOriginal` from the EXIF block that sharp extracts, not from the whole file, because exifr 7.1.3 rejects HEIC written by libheif. When sharp cannot size a HEIF (HEVC pixels), the probe decodes it with heic-convert.

#### src/images/store.ts
```ts
type DataDirs = { root; images; cache; inbox; failed }
function dataDirs(dataDir): DataDirs
function ensureDataDirs(dataDir): Promise<DataDirs>        // images/, cache/, inbox/failed/ (mkdir -p)
function chooseExt(originalName, mimeExt): string           // original's lower-cased ext if /^[a-z0-9]{1,8}$/, else the mime's
function originalRelPath(id, ext, savedAt: Date): string    // 'images/YYYY/MM/<id>.<ext>', local time of savedAt
function resolveInDataDir(dataDir, rel): string             // throws if the path escapes the data dir
function cacheDirFor(dataDir, id): string                   // <dataDir>/cache/<id>
function fileExists(p): Promise<boolean>; function removeQuietly(p): Promise<void>
class DestinationExistsError extends Error
function writeNewFile(dest, bytes): Promise<void>           // temp sibling + rename; never overwrites
function copyIntoNewFile(src, dest): Promise<void>
function moveIntoNewFile(src, dest, fs?: MoveFs): Promise<void>   // rename; on EXDEV copy, rename, unlink the source
```
This `ensureDataDirs` returns `DataDirs` and is separate from the one in `src/daemon.ts`.

#### src/images/derive.ts
```ts
const THUMB_WIDTH = 480, PREVIEW_LONG_EDGE = 1568, PREVIEW_MAX_BYTES = 3_750_000
type ImageSource = { id; mime; originalPath }               // originalPath is absolute
function derivativePaths(dataDir, id): { dir; thumb; preview; display }
class OriginalMissingError extends Error { readonly id }
function getDisplay(dataDir, src): Promise<{ path; mime }>  // the original if browser-displayable, else display.jpg (q92)
function getThumb(dataDir, src): Promise<string>            // thumb.webp, 480 px wide, never enlarged
function getPreview(dataDir, src): Promise<string>          // preview.jpg, long edge <= 1568, <= 3.75 MB
```
Derivatives are made on first request and cached under `cache/<id>/`. Each is written to a temp file and renamed into place, and concurrent callers for one output path share one in-flight promise. HEVC HEIC is decoded by `decodeHeicToJpeg`. Other types a browser cannot show (TIFF, non-HEVC HEIF) go through sharp. The preview steps JPEG quality down (85, 75, 65, 50, 35) until it fits `PREVIEW_MAX_BYTES`, so the base64 MCP payload stays under Claude's 5 MB image limit. It throws if no quality fits. Every getter throws `OriginalMissingError` when the original is not on this machine.

#### src/images/records.ts
```ts
type ImageRecord = { id; image_path; image_meta: ImageMeta; deleted_at: string | null }
interface ImageRecords {
  bySha256(sha256): Promise<ImageRecord | null>   // live note first, else the most recently deleted
  byId(id): Promise<ImageRecord | null>           // normalizeId; deleted included; null if not an image note
}
function dbImageRecords(db: Db): ImageRecords
```
Read-only raw lookups that `NotesService` does not offer, since it hides deleted rows and returns the wire shape.

#### src/images/ingest.ts
```ts
type ImageNotes = Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>
type ImageDeps = { dataDir; notes: ImageNotes; records: ImageRecords; hostname?: () => string; now?: () => Date }
function imageDeps(app: AppDeps): ImageDeps
type IngestInput = { originalName?; body?; origin? } & ({ bytes } | { path; move? })
type IngestResult = { note: Note; created: boolean }
type LocatedImage = ImageSource & { relPath; available; host; deleted; meta: ImageMeta }
function ingestImage(deps, input): Promise<IngestResult>
function locateImage(deps, id): Promise<LocatedImage | null>
```
`ingestImage` hashes the bytes and serialises on that sha256 within the process. A live match is returned unchanged and a soft-deleted match is restored, both with `created: false`. If the match's original is missing on this machine (it was ingested on another host), the same bytes are placed at its `image_path`. Otherwise it probes the bytes, picks the extension, writes the original byte for byte to `images/YYYY/MM/<id>.<ext>` and calls `notes.create({ id, image, allowEmpty: true })`. When the insert fails, the file is removed, or moved back to its source when `move` was set. `duplicate_image` (a concurrent ingest) returns the winner, and `conflict` retries with a new id, up to 5 attempts. With `move: true` the source is consumed on success, dedupe hits included. `image_meta.host` is `os.hostname()`, and `original_name` is the basename of `originalName` or of the source path.

#### src/images/inbox.ts
```ts
type InboxWatcherOptions = { inboxDir; failedDir; ingest: (absPath) => Promise<IngestResult>; log?; stabilityThresholdMs? /*2000*/; pollIntervalMs? /*200*/ }
type InboxWatcher = { idle(): Promise<void>; close(): Promise<void> }
function isIgnoredInboxName(name): boolean    // dotfiles, '~$', .crdownload .part .partial .tmp .download .opdownload .!ut
function startInboxWatcher(opts): Promise<InboxWatcher>   // resolves after chokidar 'ready'
```
It watches the top level of the inbox only (depth 0, subdirectories ignored), including files already there at startup. A file is taken once its size and mtime hold still for the stability threshold. Files are handled one at a time in arrival order. Non-images are logged and left in place. A failed ingest moves the file to `inbox/failed/<name>`, or `<stem>-<epoch ms>[-n]<ext>` if that name is taken, and logs one `[inbox]` line. `idle()` resolves once every file seen so far is handled, and `close()` stops the watcher and drains the queue.

### src/deps.ts, src/daemon.ts, src/background.ts, src/main.ts

```ts
interface AppDeps { config: Config; db: Db; events: NoteEvents; service: NotesService }
const CHAT_SUBDIR = 'chat'   // <dataDir>/chat: fixed cwd of every chat brain run, so SDK sessions resume across restarts
const DATA_SUBDIRS = ['images', 'cache', 'inbox', 'inbox/failed', CHAT_SUBDIR]
function ensureDataDirs(dataDir: string): Promise<void>
interface RunningDaemon { deps: AppDeps; port: number; stop: () => Promise<void> }
interface StartDaemonOptions { chat?: ChatBackend }   // omitted: createAgentChatBackend from config.chat; tests inject the stub or a scripted fake
function startDaemon(config: Config, options?: StartDaemonOptions): Promise<RunningDaemon>
function startBackground(deps: AppDeps): Promise<StopBackground>   // StopBackground = () => Promise<void>
```
`startDaemon` runs these steps in order: refuse a non-loopback host, create the data dirs, `createDb`, `NoteEvents`, `NotesService`, the chat backend (`options.chat`, or `createAgentChatBackend({ chat: config.chat, cwd: <dataDir>/chat, mcpUrl })`), `createApp(deps, { chat })`, `serve` on `config.host:config.port`, then `startBackground`. `mcpUrl` returns `http://<host>:<bound port>/mcp` and throws until `serve` has bound, so the agent always reaches this daemon's own `/mcp` even when `config.port` is 0. If listening fails it closes the db and rethrows. `port` is the bound port, which matters when `config.port` is 0. `stop()` is idempotent (it memoises one promise) and first calls `close()` on the default agent backend (stopping any in-flight run), then stops background jobs, then the server (closing all connections), then the db. `src/main.ts` is the `dev`/`start` entry. It logs the listen URL and handles SIGINT/SIGTERM with a 10 s forced exit.

## Web UI: web/ (phases 7-8)

A Vite + React 19 + TypeScript single-page app, dark only, Phosphor duotone icons (set once through `IconContext`), Host Grotesk and Geist Mono via fontsource. `npm run build:web` writes `web/dist/` (gitignored) and `notesd` serves it through `staticRoutes`. `npm run dev:web` runs the Vite dev server on 127.0.0.1 and proxies `/api`, `/mcp` and `/health` to `http://127.0.0.1:${NOTESD_PORT || 7317}`, so a running daemon is needed. The build has two Rolldown inputs: `index.html` (the SPA) and `fullscreen.html` (the `/full/:id` tab, which `staticRoutes` serves).

### npm scripts and tsconfigs
| script | does |
|---|---|
| `build` | `build:server && build:web` (install.sh runs this, so installs ship the UI) |
| `build:server` | `tsc -p tsconfig.server.json` |
| `build:web` | `vite build --config web/vite.config.ts` |
| `dev:web` | `vite --config web/vite.config.ts` |
| `typecheck` | `tsc -p tsconfig.json && tsc -p tsconfig.web.json` |

`tsconfig.web.json` (root) covers `web/src` with DOM libs, `jsx: react-jsx`, `moduleResolution: Bundler`, `verbatimModuleSyntax`, `noUnusedLocals` and `types: ["vite/client"]`. `web/tsconfig.json` only extends it. Web tests run under the root `vitest.config.ts` (no separate web config).

### Modules
```
web/src/main.tsx      fonts + styles.css, createRoot(<StrictMode><App/>)
web/src/App.tsx       all UI state: side, mode, active tags, editing id, chat input; wires every component
web/src/types.ts      Note, NoteImageMeta, TagCount (mirror of src/notes/types.ts), Mode = 'text'|'images'|'all'
web/src/api.ts        fetch wrappers, ApiError, image URL builders
web/src/styles.css    design tokens on :root, grain overlay, masonry wall (CSS columns, 240px)
web/src/lib/text.ts   tagsOf, segmentBody, fontSizeFor, letterSpacingFor, rowsFor
web/src/lib/filter.ts MODE_TIP, MODE_ORDER, nextMode, matchesTags, visibleOnWall, photosOf, headingFor, countLineFor, lastEdited, isHiddenByMode
web/src/lib/usedIds.ts extractUsedIds(text, knownIds)
web/src/lib/dates.ts  relativeDate(iso, now, lower?)
web/src/lib/sse.ts    createSSEParser, readSSE (fetch-body SSE for POST /api/chat)
web/src/hooks/useNotes.ts  notes + tags store: initial load, SSE, 60 s poll, debounced refetch, optimistic upsert/remove
web/src/hooks/useChat.ts   chat state machine over POST /api/chat (text, status caption, brain, thread id)
web/src/hooks/useNow.ts    Date re-rendered every 60 s
web/src/hooks/useCopied.ts copyText (clipboard + execCommand fallback), useCopied(ms = 1400)
web/src/components/   Rail, Sidebar, Header, Wall, NoteCard, AnswerPanel, ChatBar, Tooltip, NoteImage, Gallery, PhotoModal (+ .css), DropOverlay
web/src/fullscreen/   main.tsx (entry), FullscreenApp.tsx, view.ts (fit/1:1/pan reducer)
```

### api.ts
```ts
class ApiError extends Error { readonly status: number }   // message = server's { error } when JSON
fetchNotes(): Promise<Note[]>              // GET /api/notes?limit=2000, returns .notes (one page)
fetchTags(): Promise<TagCount[]>           // GET /api/tags
createNote(body): Promise<Note>            // POST /api/notes
updateNote(id, body): Promise<Note>        // PATCH /api/notes/:id
deleteNote(id): Promise<void>              // DELETE; a 404 counts as success
postChat(message, threadId?, signal): Promise<Response>   // POST /api/chat, raw SSE response
thumbUrl(id), displayUrl(id), originalUrl(id)              // /api/notes/:id/{thumb,display,original}
```
The image URL builders point at the phase 5 image routes.

### Behaviour
- **Data**: `useNotes` loads notes and tags together on mount, then refetches on every `event: note` from an `EventSource('/api/events')`, on SSE `open` (catches up after a daemon restart), and every 60 s. Refetches are debounced 250 ms and never overlap. A generation counter bumped by every local mutation discards a fetch that started before the mutation and schedules another, so optimistic edits are not overwritten by stale data.
- **Modes**: `text` (default; hides image notes), `images` (renders `Gallery`), `all`. The rail button cycles text, images, all; the sidebar shows all three plus a photo count. Jumping to a note the current mode hides switches to `all` first.
- **Tag filter**: AND semantics over `tagsOf(body)`. Clicking a tag chip on a card or a sidebar row toggles it; active tags show as rail chips with a clear button. The heading becomes the active tags (`#a #b`), otherwise `Notes.` / `Everything.` / `Photos.`.
- **Header**: count line per mode, "Last edited <id> <when>" linking to the note (scrolls with a 140 px offset), the drop/paste hint, and a new-note sticker (hidden in images mode).
- **Cards**: font size by body length (26 / 17 / 13.5 px; 13 for image cards), tag chips, id with a copy button and a 1.4 s "copied" mark, relative created date (`just now`, `N min ago`, `Today`, `Yesterday`, `Oct 28`, `Oct 28, 2025`). Image cards show `NoteImage` (the thumb, sized by the image's aspect ratio). `NoteCard` is memoised.
- **Inline edit**: clicking the text opens a textarea (caret at end); blur commits. An empty draft on a text note deletes it (optimistic remove, then `DELETE`); an unchanged draft does nothing; otherwise an optimistic update (re-parsed tags, new `updated_at`) then `PATCH`. "New note" creates an empty note via `POST`, puts it on top in edit mode, and leaves images mode. The note being edited stays visible whatever the filters.
- **Chat**: `ChatBar` is fixed at the bottom; submit calls `useChat.ask`, which aborts any previous request, clears `status` and `brain`, opens `AnswerPanel` and appends `delta` text as it streams. `event: status` sets `ChatState.status` to its `text` (`""` clears it). `done` stores `thread_id` for the next question, clears `status` and sets `ChatState.brain` from `done.brain` (null when absent, as with the stub); `error` (or a non-OK response) appends `Chat failed: ...` and also clears `status` with no brain. The panel header shows a dim mono caption after the query (`.answer-status`, prefixed with `·`): the status caption while streaming, the brain label (`claude` / `glm`) once done, nothing when either is empty. A follow-up while the panel is open continues the thread. Dismissing the panel (`close`, via the dismiss button or Escape) aborts the stream and clears the thread id, so the next message starts a new thread; a late `done` from the aborted stream cannot restore it. A pinned panel is never dismissed by Escape, so it keeps its thread. The panel shows a cursor while streaming, pin and dismiss buttons, and, once done, chips for every loaded note id the answer mentions (`extractUsedIds`: case-insensitive, first-mention order, not inside longer tokens). While an answer with used ids is open, the wall dims other cards to .22 and rings the used ones. Escape closes an unpinned panel.
- **Tooltips**: one document-level `mouseover` listener renders `[data-tip]` text above the element, or to its right with `data-tip-side="right"`. Buttons are icon-only with `data-tip` and `aria-label`.
- **Layout**: a 56 px rail, an optional 240 px sidebar (main margin 296 px when open), the chat bar and answer panel offset to match.

### Images (phase 8)
The four phase-7 stubs are now real; their props are unchanged except where widened. `Gallery` and `PhotoModal` take the structural `ImageNote` (phase 7's `Note` is assignable).

```ts
// components/NoteImage.tsx
const FILM_FILTER = 'sepia(.14) saturate(1.12) contrast(1.05) brightness(.97)'
type ImageInfo = { width; height; available; host? }; type ImageNote = { id; body; tags; created_at; image: ImageInfo | null }
type ImageVariant = 'thumb' | 'display'
function imageUrl(id, variant | 'original'): string        // /api/notes/:id/<variant>
function aspectOf(image): { w; h; ratio; css }             // 3:2 fallback for missing or zero dims
function ImagePlaceholder({ aspect, caption, host?, width?, onClick? })   // role=img, ImageBroken icon, Geist Mono caption
function NoteImage({ note, variant = 'thumb', className?, style?, onClick? })
// components/Gallery.tsx
const GALLERY_ROW_HEIGHT = 230
function galleryTile(image): { grow; basis; ar }           // flex grow = w/h, basis = round(w/h * 230)
// components/PhotoModal.tsx
function stepIndex(i, d, len): number                      // wraps both ways; -1 when empty
function stripTags(body): string                           // hashtags removed, whitespace collapsed
// components/DropOverlay.tsx
type UploadResult = { note; created }
imageFiles(files), firstImageFile(files), hasFiles(dataTransfer)
uploadImage(file, fetchImpl?): Promise<UploadResult>       // POST /api/images multipart `file`; throws on non-2xx
flashNote(id, delayMs = 450)                               // scrolls [data-note=id] into view, pulses an outline
// fullscreen/view.ts
const DRAG_THRESHOLD = 4; viewReducer(View, down|move|up|leave); imgStyleFor(view, natural, dpr); cursorFor(view)
// fullscreen/FullscreenApp.tsx
idFromLocation(loc): string | null                         // /full/<id>, else ?id=
describeMissing(id, fetchImpl?): Promise<{ caption; host; w; h }>
function FullscreenApp({ id })
```

- **NoteImage**: `thumb` (wall card, gallery tile; lazy, full width, aspect-ratio height) or `display` (modal; capped at `100vh - 48px`). Both carry `FILM_FILTER`. `!image.available` renders the placeholder "not on this machine" with `image.host` on a second line; an `<img>` error renders "unavailable". A text note renders nothing.
- **Gallery**: a flex-wrap justified layout (gap 4, trailing `flex: 999` spacer), tiles carry `data-note` so `flashNote` and jump-to-note find them. It owns the open photo by id (so the modal closes if that photo leaves the filtered list) and portals `PhotoModal` into `document.body`.
- **PhotoModal**: backdrop click closes; image and side panel clicks do not. A capture-phase `keydown` on `window` handles Escape (close), ArrowLeft/ArrowRight (wrap) with `preventDefault` + `stopPropagation`, so App's Escape never closes the chat panel behind it. The side panel shows the body without tags, tag chips, id with "copied" (App's `copiedId`), `i / n` plus relative date, and icon buttons Copy ID, Show full screen (`window.open('/full/<id>', '_blank', 'noopener')`) and Close. `PhotoModal.css` only adds the `.pm-btn:hover` background.
- **DropOverlay**: document-level `dragover`/`dragleave`/`drop`/`paste`. The dashed overlay shows only for drags that carry `Files`. A drop uploads every image file; a paste uploads only the first and is otherwise left alone (text paste keeps working). Uploads run one at a time on a promise queue; each result goes to `onImageAdded(note)`, and a dedupe hit (`created: false`) also gets `flashNote`. Failures are `console.error`ed only.
- **Full-screen tab** (`/full/<id>`, `fullscreen.html`): sets `document.title` to the id, shows the `display` variant on black with no film filter. It starts in fit mode; a click (movement within 4 px) toggles fit and 1:1, where 1:1 is natural size divided by `devicePixelRatio` and a drag pans. On image error `describeMissing` re-fetches the display URL (404 `not_on_this_machine` gives the caption plus host, other 404s give "not found", anything else "unavailable") and `/api/notes/:id` for the aspect ratio.

## Deployment (phase 3)

Full guide: `docs/INSTALL.md`. Nothing in `src/` changed for this phase.

### deploy/notesd.service
systemd **user** unit template. `Type=simple`, `ExecStart="@NODE_BIN@" "@REPO_DIR@/dist/main.js"`, `WorkingDirectory=@REPO_DIR@`, `NODE_ENV=production`, `NOTES_DATA_DIR=@DATA_DIR@`, `PATH=@NODE_DIR@:/usr/local/bin:/usr/bin:/bin`, `HOME=@HOME_DIR@` (where the Agent SDK child finds `~/.claude/.credentials.json` and keeps sessions), `NOTESD_CLAUDE_BIN=@CLAUDE_BIN@` (absolute real path of `claude`), `Restart=on-failure` (5 s), `StartLimitIntervalSec=0`, `TimeoutStopSec=15`, `WantedBy=default.target`. Edit the template, not the rendered copy in `~/.config/systemd/user/notesd.service`.

### scripts/install.sh
Idempotent; re-run after every pull. Env overrides: `NODE_BIN` (Node >= 22; default `node` on PATH, then `~/tools/node-v22.23.1-linux-x64/bin/node`), `CLAUDE_BIN` (default `claude` on PATH, then next to node), `NOTES_DATA_DIR` (default `~/mcp-notes-data`), `SKIP_CHAT_CHECK=1` (skips the chat smoke check, for offline runs). Steps, in order:
1. Resolve node (absolute, `readlink -f`) and npm next to it; resolve the `claude` CLI and its real path (`readlink -f`, must be an executable file), which the unit gets as `NOTESD_CLAUDE_BIN`.
2. Preconditions: curl, a reachable `systemctl --user`, the unit template, `SKILL.md`, `package-lock.json`; paths (including the real claude path and `$HOME`) free of `| & \` (sed renderer); refuses if `~/.claude/skills/n` exists and is not a symlink. Then warn-only checks: `~/.claude/.credentials.json` missing (Claude login), `.env.local` missing or lacking a complete `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (GLM fallback off).
3. `npm ci` only when `node_modules` is missing or older than `package-lock.json`; then `npm run build` (must produce `dist/main.js`).
4. `mkdir -p` the data dir.
5. Render the unit with sed (fails on any leftover `@X@`), install it only if changed, `daemon-reload`, `enable`, `restart`.
6. `loginctl enable-linger $USER` (tries plain, then `sudo -n`; otherwise warns with the command to run).
7. Poll `GET http://127.0.0.1:7317/health` for up to 30 s; on timeout dumps `journalctl` and fails.
8. `claude mcp remove --scope user notes` (ignored), then `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
9. `ln -sfn <checkout>/claude/skills/n ~/.claude/skills/n`.
10. Verify: unit `active`, `/health` answers, `claude mcp list` shows `notes:` as Connected, prints the chat claude path and version, and a chat smoke check: one read-only message (`POST /api/chat`, 200 s curl limit) whose SSE stream must end in `event: done`; it prints the answering brain and warns if it is not `claude`. Exits non-zero otherwise. Warns when the checkout is under `~/.worktrees/`.

### scripts/uninstall.sh
Disables and stops the unit, deletes the unit file, `daemon-reload`, `reset-failed`; `claude mcp remove --scope user notes`; removes `~/.claude/skills/n` only if it is a symlink. Keeps the data dir and linger, and prints the Windows `-Uninstall` command.

### scripts/windows/install-wsl-keepalive.ps1
Registers a Task Scheduler task (default name `mcp-notes WSL keepalive`) at logon of the current user, `RunLevel Limited` (runs as the user, no elevation), action `conhost.exe --headless wsl.exe -d <Distro> -- sleep infinity` (no console window). Settings: no execution time limit, runs on battery, `StartWhenAvailable`, `MultipleInstances IgnoreNew`, restarts 3 times at 1 min, hidden. Params: `-Distro` (default `Ubuntu`, validated against `wsl --list --quiet`), `-TaskName`, `-NoStart`, `-Uninstall`. Starts the task immediately unless `-NoStart`. Registration normally needs no admin; on "Access is denied" it tells you to re-run elevated. Why it exists: WSL shuts an idle distro down (`instanceIdleTimeout` 15 s default) once no Windows-side `wsl.exe` is attached, and systemd services and linger do not count as activity. The `.wslconfig` `instanceIdleTimeout=-1` alternative is documented but not chosen because nothing would boot WSL at logon.

### claude/skills/n/SKILL.md
Claude Code skill `n` (`/n <request>`, also triggered by note save/find/edit/compare requests). Tells Claude to use only the `mcp__notes__*` tools, and sets conventions: pass `origin` (`cwd`, `repo` = git top-level basename, `claude_session` only if known) on every `create`/`update`; plain-text bodies with no markdown, hashtags on the last line, reuse existing tags (`tags` first), never secrets; how to route ids to `get`, tags to `list`, topics to `search`; edits via `get` then full-body `update`, `append`, `revisions`/`revert`; comparisons as two filtered calls analysed by Claude, in Asia/Jakarta time with Monday-start weeks, citing ids; image handling only when image tools exist; soft deletes only on request; and a troubleshooting order (`systemctl --user status notesd`, `/health`, `journalctl`, re-run `install.sh`) with no fallback to writing files.

## Data Flow

Startup (`src/main.ts`): `loadConfig()` feeds `startDaemon()`, which creates the data dirs and calls `createDb()`. It then builds `NoteEvents` and `NotesService`, picks the chat backend (injected, or the Agent SDK backend), then `createApp()`, and serves Hono on 127.0.0.1.

MCP call: Claude Code POSTs to `/mcp`, `loopbackOnly` checks the host, and `handleMcpRequest` builds a fresh server. The tool handler calls `NotesService`, which calls `repo` (Drizzle), which queries Postgres. The result goes back through `rowToNote` as a `Note` JSON text result.

Write path: `requireId` and `parseTags(body)`, then one transaction: lock the row, insert the previous body into `note_revisions`, update `notes`. After commit, `NoteEvents.emit(op, id)`. Shutdown (signal) runs `stop()`: background jobs, then server close, then `closeDb()`.

Inbox ingest (phase 4): a file lands in `<dataDir>/inbox`. chokidar reports it, and the watcher waits for its size to settle and sniffs the magic bytes. `ingestImage` then hashes it and looks up `ImageRecords.bySha256`. A match is returned, or restored if deleted. Otherwise the file is probed, moved to `images/YYYY/MM/<id>.<ext>`, and `NotesService.create` inserts the note with `origin.source = 'inbox'`, which emits `created`. Any failure moves the file to `inbox/failed/`. Derivatives (`cache/<id>/...`) are not made at ingest. They are generated on first read.

Images over HTTP and MCP (phase 5): `POST /api/images` and `create_image` both end in `ingestImage` (bytes from the multipart file, or a copy of the local path), so they share dedupe and `NotesService.create`, which emits `created`. Image reads go `resolveImageFile`, then `locateImage`, then the derive getter for the variant (generated and cached on first read), then a streamed file for HTTP or a base64 `image` block for `view_images`. If the original is not on this machine the answer is 404 `not_on_this_machine` (HTTP) or a text line (MCP).

Web UI (phase 6): the browser loads the SPA through `staticRoutes`, then calls `/api/notes` and friends. Those handlers call `NotesService` like MCP does and map `NoteError` to a status. The UI holds `/api/events` open: a write from any source (MCP, web, inbox) goes `NotesService`, then `NoteEvents.emit`, then the SSE listener, then `event: note`, and the UI refetches. Chat: `POST /api/chat` goes to `ChatBackend.reply`, whose `delta`/`status` events stream back as SSE, ending with `done { thread_id, brain? }`. With the default backend (iteration 4 phase 2), `reply` spawns a Claude Code child through the Agent SDK in `<dataDir>/chat`; the child calls the notes tools over this daemon's own `POST /mcp` (so its reads and writes go through `NotesService` and emit `NoteEvents` like any MCP client), streams text and tool use back, and its SDK `session_id` returns as `thread_id`, which the next message passes as `resume`.

Web UI client (phase 7): `useNotes` fetches `/api/notes?limit=2000` and `/api/tags`, keeps `EventSource('/api/events')` open and refetches (debounced 250 ms) on each `note` event, on reconnect and every 60 s. `App` derives the wall from `notes`, `mode` and active tags with the pure `lib/filter` helpers. An edit is applied locally first (`upsertLocal`/`removeLocal`), then sent with `PATCH`/`DELETE`/`POST`, then followed by a refetch; the server's resulting `NoteEvents` emit triggers another refetch through SSE. Chat reads the `POST /api/chat` response body with `readSSE`, since `EventSource` cannot POST.

Web UI images (phase 8): a drop or paste in the SPA goes `DropOverlay`, then `POST /api/images` (one file at a time), then `onImageAdded` inserts the note locally; the server's `created` event refetches through SSE as usual. Tiles and cards load `/api/notes/:id/thumb`, the modal loads `display`, and the full-screen tab (served `fullscreen.html` for `/full/:id`) loads `display` and, on error, reads the 404 body to tell "not on this machine" from "not found".

Connector call (iteration 5 phase 1): Claude calls e.g. `runs_sql` on `/mcp`. The handler runs `guardSelect` (`<id>_sql` only), then `connector.query`: settings and the sibling repo's `.env.local` are read now, a new read-only `pg.Client` connects to the direct host, runs the wrapped SELECT inside `BEGIN READ ONLY`, rolls back and closes. The capped rows return as compact JSON. Seer `source: "lab"` instead spawns a `node -e` child that opens `<seer>/lab/lab.sqlite` read-only and replies on stdout. Any failure becomes a `ConnectorError` whose bare message is the tool's `isError` text; nothing touches `NotesService` or emits `NoteEvents`.

Migrations come from `src/db/schema.ts`: `npm run db:generate` writes `drizzle/*.sql`. `npm run db:migrate` applies them to Neon over the DIRECT host chosen by `drizzle.config.ts`. That config throws if only pooler URLs exist.

## Dependencies

### External (used so far)
- `drizzle-orm`, `drizzle-kit`: schema, query builder, migrations
- `@neondatabase/serverless` + `ws`: Neon websocket pool (needed for interactive transactions)
- `pg`: node-postgres driver for Docker test DB and non-Neon URLs; also the connectors' per-query read-only `Client` (custom type parsers, array row mode)
- `dotenv`: parse `.env.local` (config and drizzle-kit)
- `vitest`, `tsx`, `typescript`: test, dev runner, build
- `@modelcontextprotocol/sdk`: `McpServer`, `WebStandardStreamableHTTPServerTransport`
- `hono`, `@hono/node-server`: HTTP app and Node listener
- `zod`: MCP tool input schemas and `/api` request validation
- `hono/streaming` (`streamSSE`): `/api/events` and `/api/chat`
- `@anthropic-ai/claude-agent-sdk` (0.3.311): `query`, `Options`, `SDKMessage` types for the chat brain; it spawns the `claude` CLI (`NOTESD_CLAUDE_BIN`, default `claude` on PATH)
- `@anthropic-ai/sdk` (0.135.0): the Agent SDK's peer for message/stream event types
- `sharp`: image metadata, orientation, resize, JPEG/WebP encode (prebuilt libvips reads HEIC headers but cannot decode HEVC)
- `heic-convert`: HEVC HEIC to JPEG (WASM libheif), loaded with `createRequire` on first use
- `exifr`: `DateTimeOriginal` / `OffsetTimeOriginal` from the EXIF block
- `file-type`: magic-byte mime detection
- `chokidar`: inbox watcher

- Web UI (phase 7): `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@phosphor-icons/react`, `@fontsource-variable/host-grotesk`, `@fontsource/geist-mono`; tests use `@testing-library/react` and `jsdom`.

### Internal
- `src/db/client.ts` imports `src/db/schema.ts`.
- `notes/service` uses `notes/{repo,ids,tags,types,events}`. `notes/repo` uses `db/schema`, `notes/dates` and `notes/types`.
- `mcp/tools` uses `NotesService`, `NoteFilter` and `NoteError`. `mcp/server` uses `tools`, `imageTools` and `instructions`.
- `http/api` uses `chat/{backend,stub}`, `notes/{events,ids,repo,types}` and `AppDeps`. `http/static` uses only the filesystem. `http/imageAccess` uses `images/{derive,ingest,probe,records}`, `notes/ids` and `ToolDeps`; `http/images` uses `imageAccess` and `images/ingest`; `mcp/imageTools` uses `imageAccess`, `notes/ids` and `ToolDeps`.
- `http/app` uses `mcp/server` and the `http/{api,images,static}` routers. `daemon` wires `config`, `db/client`, `notes/{events,service}`, `chat/agent`, `http/app` and `background`.
- `chat/agent` uses `chat/{backend,env,prompt,status}` and the `Config` type. `chat/prompt` uses `localTimeZone` from `mcp/instructions`. `chat/status` and `chat/env` depend on nothing internal (status mirrors the tool names in `mcp/tools` and `mcp/imageTools`).
- `tests/integration/setup.ts` imports `createDb`, `closeDb`, `isNeonUrl`.
- `connectors/*` depend only on each other plus `config` (`REPO_ROOT`, `isPooledUrl`) and `mcp/tools` (`run`, in `schema` and `sql`). `mcp/server` uses `connectors/register`; `mcp/tools` imports `ConnectorError`/`Connectors` from `connectors/types`; `mcp/instructions` imports `connectors/names`.
- `images/ingest` uses `images/{probe,store,records}`, `NotesService` (as `ImageNotes`), `NoteError` and `AppDeps`. `images/derive` uses `probe` and `store`. `images/inbox` uses `probe` and `store`. `images/records` uses `db/schema` and `notes/ids`. `background` wires `images/{ingest,inbox,store}`.

### Standard library
`node:crypto` (`randomInt`, `randomUUID`), `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`, `node:events`, `node:net` (type only), `node:child_process` (the lab reader), `node:sqlite` (inside the lab child only; needs Node 22.5+).

## Reverse Dependencies

`src/main.ts` is the production entry (`npm run dev` / `npm start`), and Claude Code connects to `http://127.0.0.1:7317/mcp`. Phases 4-6 plug in through `startBackground`, `registerImageTools` and `imageRoutes`, plus `NoteFilter`/`noteFilterShape`/`buildInstructions` sections. The web UI reads images from `/api/notes/:id/{thumb,display,original}` and uploads to `/api/images`; the `/n` skill drives `create_image` / `view_images`. The web UI consumes `/api/*`, `/api/events` and `/api/chat`; since iteration 4 phase 2 the chat brain is itself an MCP client of `/mcp`, so any change to the notes tool names must also update `NOTES_TOOL_NAMES` in `src/chat/status.ts`. Connector phases 2-4 replace the `curated.ts` stubs and rely on the phase 1 harness (`tests/integration/connectors/harness.ts`); phase 5 adds `ALL_CONNECTOR_TOOL_NAMES` to the chat bar's allow list. Tests: `tests/unit/{ids,tags,config,db-client,notes.helpers,mcp.instructions}.test.ts` and `tests/integration/{schema,notes.service,mcp.tools,daemon}.int.test.ts`, plus phase 6's `tests/unit/{chat-stub,static}.test.ts` and `tests/integration/{api,events}.int.test.ts`, and phase 5's `tests/unit/{takenFilter,imageAccess}.test.ts` and `tests/integration/images.{http,mcp}.int.test.ts`.

## Concurrency

The only global state is `neonConfig.webSocketConstructor`, set in `createDb`. A `Db` wraps a connection pool and is safe for concurrent queries. Concurrent writes to one note serialise on the `SELECT ... FOR UPDATE` row lock inside each service transaction. Inserts do not lock: an id clash returns null and is retried. `NoteEvents` listeners run synchronously on emit, after commit. MCP requests share nothing: each gets its own server and transport. Each `/api/events` connection adds one `NoteEvents` listener and one heartbeat interval, both removed on abort. SSE writes from listeners are fire-and-forget and swallow write errors after the client goes away. Integration test files run one at a time (`fileParallelism: false`) because they share and truncate one database.

Image ingest keeps a per-process promise chain per sha256, so two ingests of the same bytes in one daemon run in sequence. Across hosts, the unique live-sha256 index decides, and the loser gets `duplicate_image` and returns the winner. Derivative generation shares one in-flight promise per output path and writes through a temp file and rename. The inbox watcher handles one file at a time on a single promise queue.

The agent chat backend allows one run in flight per daemon: a new `reply()` aborts the previous run (`superseded`) before starting. Each run owns an `AbortController` that the client signal, the timeout timer and `close()` all trigger; each SDK attempt gets its own child controller relayed from it and aborted when the attempt is not drained.

## Error Handling

- `ConfigError` (config), `InvalidIdError` (ids, carries `input`), `RangeError` (generateId with a bad injected RNG).
- `NoteError` with `code` is the service's only deliberate error. Its codes: `invalid_id`, `invalid_input` (bad date, cursor or empty search), `not_found`, `deleted`, `empty_body`, `conflict`, `duplicate_image` (Postgres 23505 on the live-sha256 index) and `invalid_revision`.
- MCP handlers never throw. `run()` turns errors into `isError` results with text `"<code>: <message>"`, the bare message for a `ConnectorError`, or `"error: <message>"` for anything else.
- `ConnectorError` (connectors) has exactly two message shapes: `"<label> is not reachable: <reason>"` (no repo dir, no `.env.local`, no `DATABASE_URL`/`DATABASE_URL_UNPOOLED`, connect/auth/network failure, missing lab file) and `"<label> query failed: <reason>"` (SQL error, statement timeout, read-only violation, guard refusal, lab timeout). The URL, user, password and host are scrubbed to `***`. A failure in one system never affects another system or the notes tools. `SqlRefused` (guard) is always rewrapped as `query failed`.
- `/mcp` returns JSON-RPC-shaped errors: 403 for a non-loopback host or Origin, 405 for GET/DELETE.
- `/api` errors are `{ error: string }`. One mapping turns `NoteError` into a status: `not_found` and `deleted` are 404 `not_found`, `conflict` and `duplicate_image` are 409 with the code, `invalid_id` is 400 `invalid_id`, and any other code is 400 `"<code>: <message>"`. Bad JSON is 400 `invalid_json`, and zod failures are 400 with `"<path>: <message>"` joined by `; `. Non-`NoteError` exceptions are rethrown (Hono 500).
- `/api/chat` errors after streaming starts arrive as `event: error`, not as an HTTP status.
- Agent chat backend errors (thrown from `events`, so they reach the UI as `event: error`): `Chat stopped: the request was closed.` / `a newer message replaced this one.` / `no answer within N s.` / `notesd is shutting down.`, the turn-cap message, the agent's own result or error text, `The agent ended without an answer.`, and the `CHAT_BRAIN=glm needs ...` message. `end()` throws if called before `events` finished cleanly.
- Image routes answer `{ error }` JSON: 404 `not_found` (bad, unknown or deleted id), 404 `no_image` with `id` (text note), 404 `not_on_this_machine` with `host`, 400 `bad_multipart` / `file_required`, 413 `too_large` (from `bodyLimit`, with `max_bytes`, or from the size check), and 415 for any other `ImageInputError` (`not_an_image`). Other exceptions go to Hono (500).
- `ImageInputError` (`src/http/imageAccess.ts`) carries `not_absolute`, `not_found`, `not_a_file`, `not_an_image` or `too_large`. MCP `create_image` returns it as an `isError` result. `view_images` never errors per id; it reports problems as text lines.
- Static: 503 `web UI not built: run npm run build` when `web/dist/index.html` is missing.
- Driver errors are not wrapped, except the unique violation in `insertNote`.
- Images: `UnsupportedImageError` (probe; carries `detectedMime`), `OriginalMissingError` (derive; carries `id`), `DestinationExistsError` (store; never overwrites), and a plain `Error` when a path escapes the data dir, when no free id is found in 5 attempts, or when a preview cannot fit 3.75 MB. The inbox watcher never throws. It logs the failure and moves the file to `inbox/failed/`.
- Only `src/main.ts` calls `process.exit`: on startup failure, and on shutdown (forced after 10 s).

## Testing

- `npm test`: unit tests in `tests/unit/**/*.test.ts` (node) plus `web/src/**/*.test.tsx` (jsdom via a per-file `// @vitest-environment jsdom` pragma).
- `npm run test:int`: `scripts/test-int.sh` creates, starts or reuses the Docker container `mcp-notes-pg-test` (postgres:16, `127.0.0.1:55433`, db `mcp_notes_test`) and, unless `CHAT_LIVE_TEST=1`, `mcp-notes-pg-connectors` (`pgvector/pgvector:pg16`, `127.0.0.1:55435`, db `postgres`), waiting on `pg_isready` for each. It then exports `TEST_DATABASE_URL`, `TEST_CONNECTORS_URL` and `VITEST_INTEGRATION=1` and runs `tests/integration/**/*.int.test.ts`. `globalSetup` applies `drizzle/*.sql` once, and `tests/integration/connectors/globalSetup.ts` rebuilds `connectors_expenses`, `connectors_runs` and `connectors_seer` from the sibling repos' own migrations.
- Connector harness (`tests/integration/connectors/harness.ts`, non-vitest half in `siblings.ts`), used by phases 2-4: `connectorsAdminUrl()` (refuses Neon), `siblingRepo(id)` and `describeWithRepo(id, name, fn)` (skips with a reason when the sibling repo's migrations are absent), `systemDbName`/`systemDbUrl` (writable admin URL), `truncateSystem`, `seedSystem`, `withAdmin`, `connectorFor(id, overrides?)` (a real read-only connector over a temp repo with a generated `.env.local`), `makeLab(rows?)` (temp `lab.sqlite` with `meta`, `methods`, `trials`, `trial_funding`, `insights`), `connectorClient(connectors)` (in-memory MCP client over `registerConnectorTools`) and `cleanupHarness()`. Only `truncateSystem`, `seedSystem`, `withAdmin` and `connectorClient` are async.
- Connector suites (P1-NOTES-A012): unit `tests/unit/connectors/{names,rows,guard,env,failsoft}.test.ts` (15 names, row cap, guard accepts/refuses per dialect and masking, direct-URL pick, `prepareUrl`, `loadDatabaseTarget`, per-call settings, scrubbing, fail-soft messages and the lab runner) and `mcp.instructions` (the Connectors paragraph); integration `core.int` (read-only at the database even outside `BEGIN READ ONLY`, Jakarta session, guard vs database refusals, row caps, type parsing, statement timeout, fail-soft per system, lab reads and write refusals), `generic.int` (`_schema`/`_sql` per system on the migrated schemas) and `mcp.int` (six generic tools listed on the real `/mcp` next to the notes tools; an unreachable system leaves the notes tools working).
- `npm run test:live:connectors`: `CONNECTORS_LIVE_TEST=1 vitest run`, no Docker, only `tests/live/connectors.live.test.ts` (60 s timeout). It calls each `<system>_schema` against the owner's real databases and Seer's real `lab.sqlite`, prints table counts only and asserts no password reaches a result. Opt-in.
- Integration helpers in `tests/integration/setup.ts`: `testDatabaseUrl()` (refuses a Neon URL), `openTestDb()`, `closeTestDb()`, `migrateTestDb()`, `truncateAll(db)` (call in `beforeEach` of any file that writes).
- `npm run test:live`: `CHAT_LIVE_TEST=1` on top of `scripts/test-int.sh`, so only `tests/live/chat.live.test.ts` runs (300 s test timeout), against the notes Docker Postgres (the connectors container is not started). `chat.live.test.ts` starts an in-process daemon on port 0 with the stub chat backend (only its `/mcp` is used), builds the Agent backend itself, and sends one real Claude and one real GLM message. Needs a logged-in `claude` and `LLM_*` in `.env.local`. Opt-in, slow and billed; never part of `npm test` or `test:int`.
- There is one `vitest.config.ts`. Do not add a second.
- Phase 6 suites: `chat-stub` (delta splitting, thread id, abort), `static` (503 fallback, reserved prefixes, assets cache, `/full/:id`, SPA fallback, traversal), `api.int` (all `/api` routes, filters, paging, error mapping, chat SSE) and `events.int` (connect comment, note events, heartbeat, unsubscribe on abort). Helpers: `tests/integration/helpers/api-harness.ts` (`createApiHarness` mounts `apiRoutes` over the Docker DB with a zero-delay stub, or `options.chat`; `uniqueTag()`), `tests/integration/helpers/scripted-chat.ts` (iteration 4: `createScriptedChatBackend()`, a fake `ChatBackend` that replays queued `ChatScript`s of `delta`/`status`/`throw`/`hang` steps, an optional `end` and `rejectWith`, and records every `ChatRequest`) and `tests/integration/helpers/sse.ts` (`parseSse`, `readUntil`, `waitFor`).
- Iteration 4 phase 2 (P1-NOTES-A009) suites: `chat-agent` (a fake `QueryFn` replaying `SDKMessage`s: delta streaming and session-as-thread, captions and paragraph breaks, run options isolation, resume, run-time MCP url, client abort, supersede, timeout, `close()`, the turn cap, GLM fallback on limit/auth errors before text and none after text, on other errors, without GLM or after a stop, and `CHAT_BRAIN=glm`), `chat-env` (key/marker stripping, `CLAUDE_CONFIG_DIR` kept, GLM env, `resolveExecutable`), `chat-prompt` (date/time/tz, id rule, plain prose, no self-saving) and `chat-status` (exact tool surface, captions). `daemon.int` now injects the zero-delay stub (tests must never spawn `claude`) and adds a start/stop check with the default Agent SDK backend that posts nothing.
- Phase 2 suites: `notes.helpers` (dates, cursor, limit, tag input, origin, rowToNote, NoteEvents), `mcp.instructions` (unit), `notes.service.int` (service against Docker Postgres), `mcp.tools.int` (all 11 tools through an MCP client on the real `/mcp` route, plus the 403/405 guards and `/health`) and `daemon.int` (data dirs, loopback listen, `/health`, MCP initialize over real HTTP, non-loopback host refused).
- Phase 5 suites: `tests/unit/takenFilter.test.ts` (taken bounds as UTC ISO text compares, `invalid_input` on garbage), `tests/unit/imageAccess.test.ts` (`expandHome`, `etagMatches`), `images.http.int` (upload and dedupe, byte-exact original with immutable cache and sha256 ETag, id spellings, thumb/preview sizes, display for PNG vs TIFF, 400/413/415 refusals, `not_found`/`no_image`, `not_on_this_machine`, no cached derivative once the original is gone) and `images.mcp.int` (tool and filter listing, `create_image` copies and dedupes, refusals, `view_images` content, text/unknown/missing explanations, the 8-id cap, `has_image` and taken-range filters on list and search). Harness: `tests/integration/imageHarness.ts` (`startHarness` builds real `createApp` over the Docker DB and a temp data dir, with `listen()`, `reset()`, `close()`; `makeImage` makes solid-colour PNG/JPEG/TIFF bytes; `insertTextNote`).
- Phase 7 suites (jsdom, colocated in `web/src`): `lib/{text,filter,usedIds,dates,sse}.test.tsx` (font sizing, tag parsing and segmenting, AND filter, mode cycle, heading and count line, used-id extraction, relative dates, SSE parsing across chunks and CRLF), `components/NoteCard.test.tsx` (font size, tag chip vs edit click, copy, blur commit, thumb aspect ratio) and `App.test.tsx` (text mode hides image notes, mode cycle, tag filter rail chip, streamed chat with used-note chips and dimming, status caption while streaming then the brain label). Iteration 4 phase 3 (P1-NOTES-A010) added `hooks/useChat.test.tsx` (status captions and `""` clearing, brain from `done` or null, error clears status, follow-up continues the thread, pinned keeps it, dismiss starts a new thread, a late `done` after dismiss does not restore it, a new ask resets brain and status). `npm run typecheck` checks both the server and web tsconfigs.
- Phase 8 suites (jsdom): `components/NoteImage.test.tsx` (film filter, display variant, placeholder with and without host, error fallback), `Gallery.test.tsx` (tile flex math, modal open, close when the photo leaves the list), `PhotoModal.test.tsx` (wraparound, Escape not reaching document listeners, backdrop vs inner clicks, copy, `/full/<id>` open), `DropOverlay.test.tsx` (first-image paste, text paste ignored, dedupe hit, Files-only overlay, serial drop uploads) and `fullscreen/FullscreenApp.test.tsx` (view reducer click vs drag threshold, `idFromLocation`, title and unfiltered image, `not_on_this_machine` placeholder).
- Phase 4 suites: `tests/unit/images/{probe,store,derive,ingest,inbox}.test.ts` and `tests/integration/images.int.test.ts` (byte-exact storage, dedupe, restore of a deleted duplicate, the sha256 unique index, HEIC display/thumb/preview, missing original, and an inbox drop through `startBackground`).
- Image fixtures in `tests/fixtures/images/`: `exif.jpg` (64x48, EXIF 2024:10:30 14:05:09), `plain.png` (40x30, no EXIF), `photo.heic` (64x48 HEVC with EXIF). They are committed because Node cannot encode HEVC. `make-fixtures.py` (Pillow + pillow-heif) regenerates them, possibly with different bytes. Helpers: `tests/helpers/fixtures.ts` (`FIXTURES_DIR`, `JPEG_EXIF`, `PNG_PLAIN`, `HEIC_PHOTO`, `fixtureBytes`, `tempDir`) and `tests/helpers/fakeNotes.ts` (`FakeNotes`, an in-memory `ImageNotes` + `ImageRecords` with the schema's id and live-sha256 uniqueness rules, plus `beforeInsert` / `failNextCreate` hooks for race and failure tests).

## Gotchas

- In `.env.local`, `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are swapped. Runtime and drizzle-kit both choose by host (`-pooler`), never by key name.
- Runtime uses the pooled host. Migrations must use the direct host.
- The daemon binds 127.0.0.1 only. A different `NOTESD_HOST` is a hard error, not a warning.
- `dataDir` is resolved but not created by `loadConfig`. `startDaemon` creates it, along with `images`, `cache`, `inbox` and `inbox/failed`.
- `YYYY-MM-DD` date filters use the daemon process's local timezone, which the MCP instructions name. Tests that depend on day boundaries must account for TZ.
- The cursor is an offset, so inserts between pages can shift results. It is opaque to clients, who must pass `next_cursor` back unchanged.
- MCP caps `limit` at 200. The repo allows up to 5000 (for the HTTP/UI).
- `from`/`to` filter on the saved date (`created_at`); `taken_from`/`taken_to` filter on the EXIF date and silently drop image notes without one.
- An image note whose original is on another host gives 404 `not_on_this_machine` on every variant, even when a derivative is cached locally.
- `create_image` copies; only the inbox moves files. `view_images` always sends the preview, never the original.
- Image mime comes from magic bytes only. The stored extension comes from the original filename when it is safe, so a `.jpeg` keeps `.jpeg`. Do not infer mime from `image_path`.
- `images/YYYY/MM` is the ingest time in local time, not the EXIF `taken_at`.
- An image note on another host has `image.available = false` here until the same bytes are ingested locally, which puts them back at the stored `image_path`.
- Inbox files that are not images stay in `inbox/` and are logged, not moved to `failed/`. Subdirectories, dotfiles and partial downloads are ignored.
- `/mcp` is stateless POST-only. There is no SSE stream and no `Mcp-Session-Id`.
- Do not edit `src/http/app.ts` mount order in later phases. Fill the routers instead, and keep `staticRoutes` last.
- `isNeonUrl` throws on an unparseable URL, while `isPooledUrl` returns false.
- `/api/notes` defaults to 2000 rows (the UI loads everything), MCP to 50.
- `DELETE /api/notes/:id` checks liveness first and returns 404 for an already-deleted note, unlike the idempotent service and MCP `delete`.
- `/api/tags` returns a bare array, while MCP `tags` returns `{ tags }`.
- `startDaemon` without `options.chat` builds the real Agent SDK backend: any test that posts to `/api/chat` through `startDaemon` must inject a stub or scripted backend, or it spawns `claude` on the owner's login.
- The chat brain needs the `claude` CLI logged in for the user running `notesd` (the systemd unit's PATH lacks `~/tools/...`, so `install.sh` renders the absolute real path into the unit as `NOTESD_CLAUDE_BIN`, and sets `HOME` so the login is found). The child env never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, model overrides or any `CLAUDE_CODE_*` / `CLAUDECODE` marker, so a daemon started from inside a Claude Code terminal does not leak its session into the child.
- Chat threads are SDK sessions stored by Claude Code under its projects dir for the cwd `<dataDir>/chat`; changing `NOTESD_DATA_DIR` orphans existing thread ids, and a resume of an unknown id fails the turn.
- The agent's allowed tools are hard-coded in `src/chat/status.ts`; a new notes MCP tool is invisible to the chat brain until it is added to `NOTES_TOOL_NAMES` (and given a caption).
- `staticRoutes` must stay last and must 404 reserved prefixes itself, or unknown `/api/*` paths would get `index.html`.
- Ids are canonical upper-case with the dash. Store `normalizeId`/`parseId` output, never raw user input.
- Integration tests truncate tables. Never point `TEST_DATABASE_URL` at Neon (the setup helper also refuses it). The container port 55433 avoids `seer-pg` on 55432.
- The installed unit and the `/n` skill symlink point at the checkout that ran `scripts/install.sh`. Phase 3 ran it from the worktree, so after the set lands on `main` re-run `cd ~/mcp-notes && git pull && scripts/install.sh`, or the unit fails and the skill dangles once the worktree is deleted.
- The unit uses an absolute node path because the systemd user manager's PATH lacks `~/tools/...`.
- Claude Code is registered against `http://localhost:7317/mcp` while the daemon binds `127.0.0.1`; this relies on `localhost` resolving to IPv4.
- A dev `notesd` already on port 7317 makes the installer's health check pass against the wrong process. Stop it first (`ss -ltnp 'sport = :7317'`).
- Linger only starts `notesd` when the distro boots; it does not keep WSL alive. The Windows keepalive task does that.
- The UI must be rebuilt (`npm run build`, or `npm run build:web`) for `notesd` to serve changes in `web/src`; until `web/dist` exists every non-API path is 503. `dev:web` needs a daemon on `NOTESD_PORT` (default 7317) to proxy to.
- `web/src/lib/text.ts` duplicates the server's tag regex instead of importing `src/notes/tags.ts`, so the two must change together.
- The UI loads at most 2000 notes in one page and filters client-side; it ignores `next_cursor`.
- `PhotoModal.stripTags` is a third copy of the tag regex (with `web/src/lib/text.ts` and `src/notes/tags.ts`).
- The film filter is applied on the wall, gallery and modal only; the full-screen tab shows the unfiltered display image.
- `fullscreen.html` must stay a Vite input, or `/full/:id` falls back to `index.html` and opens the SPA instead of the image.
- Connectors must use the direct (non-pooler) Neon host: poolers reject the `options` startup parameter that sets `default_transaction_read_only`. `pickDirectUrl` chooses by host, like the notes config, and `prepareUrl` drops any `options` query param from the URL because it would override the client's own.
- Connectors cache nothing. Repo dirs, `CONNECTOR_TIMEOUT_MS` and each sibling `.env.local` are read on every call, so rotated credentials work without restarting `notesd`, and every call pays one fresh connection (and a lab call one process start, about 40-60 ms).
- Connector dates, times and timestamps come back as Postgres text in `Asia/Jakarta`, not ISO UTC; `int8` above 2^53 comes back as a string. Curated SQL must stay valid inside `SELECT * FROM (<sql>) AS q LIMIT n`; trailing `;` is stripped.
- `guardSelect` is a keyword guard, not a parser: any query containing a forbidden word outside literals, comments and quoted identifiers (even an unquoted column named `update`) is refused. The database's read-only session is what actually prevents writes, which `core.int` proves by bypassing the guard.
- The lab child runs with an empty env and `process.execPath`, so `node:sqlite` must exist in the daemon's Node.
- `truncateSystem('seer')` wipes the roster rows Seer's migrations insert into `strategies`; connector tests must seed their own. The connectors container (55435) avoids `seer-pg` (55432), `mcp-notes-pg-test` (55433) and `mcp-notes-pg-demo` (55434).
- `CONNECTOR_TOOL_NAMES` is the single source of the 15 names (instructions, chat allow list, curated phases). Add a system by adding entries there and a directory under `src/connectors/`.

## Notes

Plan set: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (8 phases, iterations 1-3: spine, images, web UI). Phase 1 (P1-NOTES-A000) landed the scaffold. Phase 2 (P1-NOTES-A001, plan `.workflows/plan/P1-NOTES-A001.md`) landed the notes service, the MCP server and tools, and the `notesd` daemon. Phase 3 (P1-NOTES-A002) landed deployment: `deploy/notesd.service`, `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/windows/install-wsl-keepalive.ps1`, the `/n` skill in `claude/skills/n/` and `docs/INSTALL.md`. Phase 4 (P1-NOTES-A003) landed the image store, derivatives, ingest service and inbox watcher. Phase 6 (P1-NOTES-A005) landed the `/api` JSON routes, `/api/events` SSE, the `/api/chat` stub behind `ChatBackend`, and static SPA serving. Phase 7 (P1-NOTES-A006) landed the web UI core in `web/` and the `build:web`/`dev:web` scripts. Phase 5 (P1-NOTES-A004) landed the image HTTP routes and upload, `create_image`/`view_images`, the `has_image` and taken-date filters, and the images section of the MCP instructions. Phase 8 (P1-NOTES-A007) landed the web UI images: `NoteImage`, `Gallery`, `PhotoModal`, `DropOverlay` and the `/full/<id>` tab (`web/fullscreen.html`, `web/src/fullscreen/`).

Iteration 4 plan: `docs/plans/CHAT_BAR_BRAIN_PLAN.md` (4 phases, the chat bar brain). Phase 1 (P1-NOTES-A008) landed the chat seam v2 (status events, brain label, `Config.chat`, daemon injection). Phase 2 (P1-NOTES-A009) landed the Agent SDK backend in `src/chat/{agent,env,prompt,status}.ts`, the two `@anthropic-ai/*` dependencies, and made it the daemon default. Phase 3 (P1-NOTES-A010) landed the web panel status caption, brain label and thread reset on dismiss. Phase 4 (P1-NOTES-A011) landed the daemon fit: `HOME`/`NOTESD_CLAUDE_BIN` in the unit, install.sh login/env warnings and chat smoke check, `npm run test:live` with `tests/live/chat.live.test.ts`, and the `docs/INSTALL.md` updates.

Iteration 5 plan: `docs/plans/CONNECTORS_PLAN.md` (6 phases, read-only connectors to expense-tracking, run-insights and Seer). Phase 1 (P1-NOTES-A012, plan `.workflows/plan/P1-NOTES-A012.md`) landed the connector core in `src/connectors/`, the six generic `<system>_schema`/`<system>_sql` tools, the single-SELECT guard, the instructions paragraph, the compact/`ConnectorError` changes in `src/mcp/tools.ts`, the `mcp-notes-pg-connectors` Docker harness and `npm run test:live:connectors`. Phases 2-4 fill the curated tools per system, phase 5 the chat bar allow list and `/n`, phase 6 the web UI.
