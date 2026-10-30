# Package: mcp-notes

**Location**: `.` (repo root)
**Last Updated**: 2026-10-30 (after task P1-NOTES-A006)
**Documentation Created**: 2026-10-30T03:03Z (after task P1-NOTES-A000)

## Overview

`mcp-notes` is a local Node/TypeScript daemon (`notesd`) that keeps short notes and images in Postgres on Neon. It exposes them to Claude Code over MCP and to a React web UI on loopback. Phases 1, 2, 3, 4, 6 and 7 of `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` have landed. Phase 1 added config loading, the Drizzle schema and its one migration, the database client factory, note id generation, `#hashtag` parsing, and the unit and Docker-Postgres integration test harness. Phase 2 added the notes service (the only writer), the `notesd` daemon (Hono on 127.0.0.1) with `/health`, and a stateless MCP streamable-HTTP endpoint at `/mcp` exposing 11 note tools. Phase 3 added deployment: a systemd user unit for `notesd`, an idempotent `scripts/install.sh` (and `scripts/uninstall.sh`) that also registers the `notes` MCP server at user scope and links the `/n` Claude Code skill, and a Windows logon task that keeps WSL running. Phase 4 (P1-NOTES-A003) added the image store under `src/images/`: magic-byte probing, byte-exact storage, sha256 dedupe, lazy derivatives and the inbox watcher. Phase 6 (P1-NOTES-A005) added the UI JSON API under `/api` (notes CRUD, tags), a live `/api/events` SSE stream of note changes, a streamed `/api/chat` stub behind the `ChatBackend` interface, and static serving of the built SPA from `web/dist` with a 503 fallback when it is not built. Phase 7 (P1-NOTES-A006) added the web UI core in `web/`: a Vite + React + TypeScript SPA with the note wall, rail, sidebar, header, inline editing, the chat bar and answer panel, tooltips, live updates over SSE plus a 60 s refetch, and a text/images/all visibility mode. Two phases are pending. Phase 5 (P1-NOTES-A004) adds the image HTTP routes and upload, the MCP tools `create_image` and `view_images`, and the `has_image` and taken-date filters. Its work is uncommitted in this worktree, and the sections below that describe `src/http/images.ts`, `src/http/imageAccess.ts`, `src/mcp/imageTools.ts`, the taken-date filter and the phase-5 tests document that pending surface, not landed code. Phase 8 (P1-NOTES-A007) adds images to the web UI (gallery, photo modal, drag/drop/paste upload, `/full/:id`) by rewriting four stub components phase 7 left in place.

**Key Responsibilities:**
- Resolve runtime config (`DATABASE_URL`, port, loopback host, data dir) from `.env.local` plus the environment
- Own the whole schema for iterations 1-3 (`notes`, `note_revisions`) and its single migration `drizzle/0000_init.sql`
- Build one Drizzle type over two drivers: Neon websocket pool in production, `pg` for the Docker test database
- Generate and normalise short note ids (`A-B32`)
- Parse `#hashtags` from note bodies into the `tags` column (pure module, shareable with the web app)
- Create, read, update, append, soft-delete, restore and revert notes atomically, keeping every prior body as a revision in the same transaction
- List and full-text search notes with tag, date, image and deleted filters plus offset cursors
- Serve the notes to Claude Code as MCP tools over loopback HTTP, and emit in-process change events
- Serve image notes over HTTP (upload, original, display, thumb, preview) and to Claude through `create_image` / `view_images` (phase 5, pending)
- Serve the web UI a JSON API, an SSE change feed, a streamed chat endpoint (stub until iteration 4) and the built SPA
- Ship the web UI itself (`web/`, built to `web/dist` by Vite): a live note wall with inline editing, tag filters, visibility modes and a chat panel
- Run `notesd` as an always-on systemd user service in WSL, registered with Claude Code as the `notes` MCP server and driven by the `/n` skill

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
src/mcp/instructions.ts buildInstructions(timeZone): MCP server instructions text
src/mcp/tools.ts       registerNoteTools (11 tools), noteFilterShape (+ has_image, taken_from/to), toFilter, ToolDeps, IMAGE_FILTER_HINT
src/mcp/imageTools.ts  registerImageTools: create_image, view_images; describeImageNote, VIEW_IMAGES_MAX
src/mcp/server.ts      createMcpServer, handleMcpRequest (stateless, JSON responses)
src/http/app.ts        createApp: /health, /mcp (+ loopbackOnly guard), mounts the routers below
src/http/api.ts        apiRoutes: /api/notes CRUD, /api/tags, /api/events (SSE), /api/chat (SSE)
src/http/static.ts     staticRoutes: web/dist SPA, /assets, /full/:id, 503 when not built
src/http/images.ts     imageRoutes: POST /api/images, GET /api/notes/:id/{original,display,thumb,preview}
src/http/imageAccess.ts shared HTTP/MCP image glue: resolveImageFile, ingestFromUpload/Path, ImageInputError, etagMatches
src/chat/backend.ts    ChatBackend, ChatRequest, ChatTurn (the chat brain seam)
src/chat/stub.ts       createStubChatBackend, STUB_REPLY, splitIntoDeltas
src/deps.ts            AppDeps { config, db, events, service }
src/daemon.ts          startDaemon, ensureDataDirs, DATA_SUBDIRS
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
scripts/test-int.sh    starts/reuses Docker container mcp-notes-pg-test, runs integration suite
scripts/install.sh     idempotent WSL install: deps, build, systemd user unit, linger, MCP registration, /n skill link
scripts/uninstall.sh   removes the unit, the MCP registration and the skill link (keeps data dir and linger)
scripts/windows/install-wsl-keepalive.ps1  Task Scheduler logon task keeping the WSL distro up (-Uninstall removes it)
deploy/notesd.service  systemd user unit template (@NODE_BIN@ @NODE_DIR@ @REPO_DIR@ @DATA_DIR@), rendered by install.sh
claude/skills/n/SKILL.md  the /n Claude Code skill, symlinked to ~/.claude/skills/n
docs/INSTALL.md        install, WSL keepalive rationale, post-merge re-install, uninstall, troubleshooting
tests/unit/            vitest unit tests (node)
tests/integration/     *.int.test.ts, setup.ts helpers, globalSetup.ts (migrates once)
vitest.config.ts       the only vitest config; switches mode on VITEST_INTEGRATION=1
tsconfig.json          typecheck (noEmit); tsconfig.server.json builds src/ to dist/
tsconfig.web.json      web typecheck (noEmit, DOM libs, react-jsx, Bundler resolution), include web/src
web/index.html         SPA entry (#root, dark color-scheme), loads web/src/main.tsx
web/vite.config.ts     Vite config: root web/, outDir web/dist, dev proxy of /api /mcp /health to notesd
web/tsconfig.json      extends ../tsconfig.web.json (for editors inside web/)
web/src/               React app; see "Web UI: web/ (phase 7)" below
web/dist/              build output, gitignored, served by staticRoutes
```

## Exported API

### src/config.ts

#### Constants
- `REPO_ROOT: string`: repo root resolved from the module's own location, so `.env.local` is found whatever the cwd. Works from both `src/` (tsx, vitest) and `dist/` (built).
- `DEFAULT_PORT = 7317`
- `LOOPBACK_HOST = '127.0.0.1'`
- `DEFAULT_DATA_DIR = '~/mcp-notes-data'`

#### Config
```ts
interface Config {
  databaseUrl: string          // runtime URL; pooled Neon host in production
  port: number                 // NOTESD_PORT, default 7317; 0 = any free port (tests)
  host: '127.0.0.1'            // always loopback, the daemon has no auth
  dataDir: string              // absolute; NOTES_DATA_DIR, default ~/mcp-notes-data; not created here
}
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

Throws `ConfigError` when no database URL is set, on a non-integer or >65535 port, or when `NOTESD_HOST` is anything but empty or `127.0.0.1`. Unknown keys (`LLM_*`, `OPENROUTER_API_KEY`) are ignored. Synchronous file read; no other side effects.

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
The server-instructions text Claude reads once per session. It covers the note model, id format, writing and revision semantics, reading and search syntax, and date semantics (it names the daemon's timezone). It also says comparisons are Claude's job. Phase 5 added an `Images.` section: the `image` field shape, `available: false` meaning the file is on another host, `view_images` with up to 8 ids, saved-date queries (`has_image` + `from`/`to`) versus taken-date queries (`taken_from`/`taken_to`), and `create_image` copying a local file with dedupe.

### src/mcp/tools.ts

```ts
interface ToolDeps { service: NotesService; dataDir: string; db: Db }   // db is read-only, for phase 5
const MCP_MAX_LIMIT = 200, MCP_DEFAULT_LIMIT = 50
const IMAGE_FILTER_HINT // sentence appended to the list and search descriptions
const noteFilterShape   // zod: tags_any, tags_all, date_field, from, to, has_image, taken_from, taken_to, deleted, limit, cursor
function toFilter(args: FilterArgs): NoteFilter     // snake_case -> NoteFilter, limit defaults to 50
function jsonResult(value): CallToolResult           // pretty JSON text content
function errorResult(err): CallToolResult            // isError, "<code>: <message>" for NoteError
function run(fn): Promise<CallToolResult>
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
The server is stateless. Each POST gets a fresh `McpServer` and a `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` and no session id generator, and both are closed after the response. A daemon restart therefore never strands a client.

### src/http/app.ts

```ts
const loopbackOnly: MiddlewareHandler     // 403 JSON-RPC error unless URL host and any Origin are loopback
function createApp(deps: AppDeps): Hono
```
Mount order is fixed: `GET /health` returns `{ ok: true, service: 'notesd' }`. `POST /mcp` sits behind `loopbackOnly` (a DNS-rebinding guard), and `GET`/`DELETE /mcp` return 405 with `Allow: POST`. After those come `apiRoutes` (P6), `imageRoutes` (P5) and `staticRoutes` (P6, last, because it owns the SPA fallback). Later phases fill the routers in `api.ts`, `images.ts` and `static.ts` and must not edit this file. `createApp` calls `apiRoutes(deps)` with no options, so the app always gets the stub chat backend and the 25 s heartbeat.

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

`/api/chat` validates the body before streaming (bad input is a plain 400 JSON, not SSE). It then calls `chat.reply({ message, threadId, signal })` and sends one `event: delta` with `{ text }` per yielded fragment, then `event: done` with `{ thread_id }`. A backend throw becomes `event: error` with `{ error }`. A client disconnect aborts the `AbortController` passed as `signal`, and nothing more is written.

### src/chat/backend.ts, src/chat/stub.ts

```ts
interface ChatRequest { message: string; threadId: string | null; signal: AbortSignal }
interface ChatTurn { threadId: string; deltas: AsyncIterable<string> }
interface ChatBackend { reply(request: ChatRequest): Promise<ChatTurn> }

const STUB_REPLY = 'The chat brain arrives in iteration 4. Until then this panel only echoes that fact.'
interface StubChatOptions { delayMs?: number }          // per-delta delay, default 40; tests pass 0
function splitIntoDeltas(text: string): string[]        // word pieces keeping trailing whitespace
function createStubChatBackend(options?: StubChatOptions): ChatBackend
```
`ChatBackend` is the seam iteration 4 replaces: only the implementation passed as `ApiOptions.chat` changes, the HTTP layer stays. The stub ignores the message, keeps the client's `threadId` or mints `stub-<uuid>`, and streams `STUB_REPLY` word by word. It stops yielding as soon as `signal` aborts, including mid-delay.

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
const DATA_SUBDIRS = ['images', 'cache', 'inbox', 'inbox/failed']
function ensureDataDirs(dataDir: string): Promise<void>
interface RunningDaemon { deps: AppDeps; port: number; stop: () => Promise<void> }
function startDaemon(config: Config): Promise<RunningDaemon>
function startBackground(deps: AppDeps): Promise<StopBackground>   // StopBackground = () => Promise<void>
```
`startDaemon` runs these steps in order: refuse a non-loopback host, create the data dirs, `createDb`, `NoteEvents`, `NotesService`, `createApp`, `serve` on `config.host:config.port`, then `startBackground`. If listening fails it closes the db and rethrows. `port` is the bound port, which matters when `config.port` is 0. `stop()` is idempotent (it memoises one promise) and stops background jobs, then the server (closing all connections), then the db. `src/main.ts` is the `dev`/`start` entry. It logs the listen URL and handles SIGINT/SIGTERM with a 10 s forced exit.

## Deployment (phase 3)

Full guide: `docs/INSTALL.md`. Nothing in `src/` changed for this phase.

### deploy/notesd.service
systemd **user** unit template. `Type=simple`, `ExecStart="@NODE_BIN@" "@REPO_DIR@/dist/main.js"`, `WorkingDirectory=@REPO_DIR@`, `NODE_ENV=production`, `NOTES_DATA_DIR=@DATA_DIR@`, `PATH=@NODE_DIR@:/usr/local/bin:/usr/bin:/bin`, `Restart=on-failure` (5 s), `StartLimitIntervalSec=0`, `TimeoutStopSec=15`, `WantedBy=default.target`. Edit the template, not the rendered copy in `~/.config/systemd/user/notesd.service`.

### scripts/install.sh
Idempotent; re-run after every pull. Env overrides: `NODE_BIN` (Node >= 22; default `node` on PATH, then `~/tools/node-v22.23.1-linux-x64/bin/node`), `CLAUDE_BIN` (default `claude` on PATH, then next to node), `NOTES_DATA_DIR` (default `~/mcp-notes-data`). Steps, in order:
1. Resolve node (absolute, `readlink -f`) and npm next to it; resolve the `claude` CLI.
2. Preconditions: curl, a reachable `systemctl --user`, the unit template, `SKILL.md`, `package-lock.json`; paths free of `| & \` (sed renderer); refuses if `~/.claude/skills/n` exists and is not a symlink.
3. `npm ci` only when `node_modules` is missing or older than `package-lock.json`; then `npm run build` (must produce `dist/main.js`).
4. `mkdir -p` the data dir.
5. Render the unit with sed (fails on any leftover `@X@`), install it only if changed, `daemon-reload`, `enable`, `restart`.
6. `loginctl enable-linger $USER` (tries plain, then `sudo -n`; otherwise warns with the command to run).
7. Poll `GET http://127.0.0.1:7317/health` for up to 30 s; on timeout dumps `journalctl` and fails.
8. `claude mcp remove --scope user notes` (ignored), then `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
9. `ln -sfn <checkout>/claude/skills/n ~/.claude/skills/n`.
10. Verify: unit `active`, `/health` answers, `claude mcp list` shows `notes:` as Connected. Exits non-zero otherwise. Warns when the checkout is under `~/.worktrees/`.

### scripts/uninstall.sh
Disables and stops the unit, deletes the unit file, `daemon-reload`, `reset-failed`; `claude mcp remove --scope user notes`; removes `~/.claude/skills/n` only if it is a symlink. Keeps the data dir and linger, and prints the Windows `-Uninstall` command.

### scripts/windows/install-wsl-keepalive.ps1
Registers a Task Scheduler task (default name `mcp-notes WSL keepalive`) at logon of the current user, `RunLevel Limited` (runs as the user, no elevation), action `conhost.exe --headless wsl.exe -d <Distro> -- sleep infinity` (no console window). Settings: no execution time limit, runs on battery, `StartWhenAvailable`, `MultipleInstances IgnoreNew`, restarts 3 times at 1 min, hidden. Params: `-Distro` (default `Ubuntu`, validated against `wsl --list --quiet`), `-TaskName`, `-NoStart`, `-Uninstall`. Starts the task immediately unless `-NoStart`. Registration normally needs no admin; on "Access is denied" it tells you to re-run elevated. Why it exists: WSL shuts an idle distro down (`instanceIdleTimeout` 15 s default) once no Windows-side `wsl.exe` is attached, and systemd services and linger do not count as activity. The `.wslconfig` `instanceIdleTimeout=-1` alternative is documented but not chosen because nothing would boot WSL at logon.

### claude/skills/n/SKILL.md
Claude Code skill `n` (`/n <request>`, also triggered by note save/find/edit/compare requests). Tells Claude to use only the `mcp__notes__*` tools, and sets conventions: pass `origin` (`cwd`, `repo` = git top-level basename, `claude_session` only if known) on every `create`/`update`; plain-text bodies with no markdown, hashtags on the last line, reuse existing tags (`tags` first), never secrets; how to route ids to `get`, tags to `list`, topics to `search`; edits via `get` then full-body `update`, `append`, `revisions`/`revert`; comparisons as two filtered calls analysed by Claude, in Asia/Jakarta time with Monday-start weeks, citing ids; image handling only when image tools exist; soft deletes only on request; and a troubleshooting order (`systemctl --user status notesd`, `/health`, `journalctl`, re-run `install.sh`) with no fallback to writing files.

## Data Flow

Startup (`src/main.ts`): `loadConfig()` feeds `startDaemon()`, which creates the data dirs and calls `createDb()`. It then builds `NoteEvents` and `NotesService`, then `createApp()`, and serves Hono on 127.0.0.1.

MCP call: Claude Code POSTs to `/mcp`, `loopbackOnly` checks the host, and `handleMcpRequest` builds a fresh server. The tool handler calls `NotesService`, which calls `repo` (Drizzle), which queries Postgres. The result goes back through `rowToNote` as a `Note` JSON text result.

Write path: `requireId` and `parseTags(body)`, then one transaction: lock the row, insert the previous body into `note_revisions`, update `notes`. After commit, `NoteEvents.emit(op, id)`. Shutdown (signal) runs `stop()`: background jobs, then server close, then `closeDb()`.

Inbox ingest (phase 4): a file lands in `<dataDir>/inbox`. chokidar reports it, and the watcher waits for its size to settle and sniffs the magic bytes. `ingestImage` then hashes it and looks up `ImageRecords.bySha256`. A match is returned, or restored if deleted. Otherwise the file is probed, moved to `images/YYYY/MM/<id>.<ext>`, and `NotesService.create` inserts the note with `origin.source = 'inbox'`, which emits `created`. Any failure moves the file to `inbox/failed/`. Derivatives (`cache/<id>/...`) are not made at ingest. They are generated on first read.

Images over HTTP and MCP (phase 5): `POST /api/images` and `create_image` both end in `ingestImage` (bytes from the multipart file, or a copy of the local path), so they share dedupe and `NotesService.create`, which emits `created`. Image reads go `resolveImageFile`, then `locateImage`, then the derive getter for the variant (generated and cached on first read), then a streamed file for HTTP or a base64 `image` block for `view_images`. If the original is not on this machine the answer is 404 `not_on_this_machine` (HTTP) or a text line (MCP).

Web UI (phase 6): the browser loads the SPA through `staticRoutes`, then calls `/api/notes` and friends. Those handlers call `NotesService` like MCP does and map `NoteError` to a status. The UI holds `/api/events` open: a write from any source (MCP, web, inbox) goes `NotesService`, then `NoteEvents.emit`, then the SSE listener, then `event: note`, and the UI refetches. Chat: `POST /api/chat` goes to `ChatBackend.reply`, whose deltas stream back as SSE.

Migrations come from `src/db/schema.ts`: `npm run db:generate` writes `drizzle/*.sql`. `npm run db:migrate` applies them to Neon over the DIRECT host chosen by `drizzle.config.ts`. That config throws if only pooler URLs exist.

## Dependencies

### External (used so far)
- `drizzle-orm`, `drizzle-kit`: schema, query builder, migrations
- `@neondatabase/serverless` + `ws`: Neon websocket pool (needed for interactive transactions)
- `pg`: node-postgres driver for Docker test DB and non-Neon URLs
- `dotenv`: parse `.env.local` (config and drizzle-kit)
- `vitest`, `tsx`, `typescript`: test, dev runner, build
- `@modelcontextprotocol/sdk`: `McpServer`, `WebStandardStreamableHTTPServerTransport`
- `hono`, `@hono/node-server`: HTTP app and Node listener
- `zod`: MCP tool input schemas and `/api` request validation
- `hono/streaming` (`streamSSE`): `/api/events` and `/api/chat`
- `sharp`: image metadata, orientation, resize, JPEG/WebP encode (prebuilt libvips reads HEIC headers but cannot decode HEVC)
- `heic-convert`: HEVC HEIC to JPEG (WASM libheif), loaded with `createRequire` on first use
- `exifr`: `DateTimeOriginal` / `OffsetTimeOriginal` from the EXIF block
- `file-type`: magic-byte mime detection
- `chokidar`: inbox watcher

Declared for later phases (not yet imported): React/Vite/testing-library, Phosphor icons, fonts.

### Internal
- `src/db/client.ts` imports `src/db/schema.ts`.
- `notes/service` uses `notes/{repo,ids,tags,types,events}`. `notes/repo` uses `db/schema`, `notes/dates` and `notes/types`.
- `mcp/tools` uses `NotesService`, `NoteFilter` and `NoteError`. `mcp/server` uses `tools`, `imageTools` and `instructions`.
- `http/api` uses `chat/{backend,stub}`, `notes/{events,ids,repo,types}` and `AppDeps`. `http/static` uses only the filesystem. `http/imageAccess` uses `images/{derive,ingest,probe,records}`, `notes/ids` and `ToolDeps`; `http/images` uses `imageAccess` and `images/ingest`; `mcp/imageTools` uses `imageAccess`, `notes/ids` and `ToolDeps`.
- `http/app` uses `mcp/server` and the `http/{api,images,static}` routers. `daemon` wires `config`, `db/client`, `notes/{events,service}`, `http/app` and `background`.
- `tests/integration/setup.ts` imports `createDb`, `closeDb`, `isNeonUrl`.
- `images/ingest` uses `images/{probe,store,records}`, `NotesService` (as `ImageNotes`), `NoteError` and `AppDeps`. `images/derive` uses `probe` and `store`. `images/inbox` uses `probe` and `store`. `images/records` uses `db/schema` and `notes/ids`. `background` wires `images/{ingest,inbox,store}`.

### Standard library
`node:crypto` (`randomInt`, `randomUUID`), `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`, `node:events`, `node:net` (type only).

## Reverse Dependencies

`src/main.ts` is the production entry (`npm run dev` / `npm start`), and Claude Code connects to `http://127.0.0.1:7317/mcp`. Phases 4-6 plug in through `startBackground`, `registerImageTools` and `imageRoutes`, plus `NoteFilter`/`noteFilterShape`/`buildInstructions` sections. The web UI reads images from `/api/notes/:id/{thumb,display,original}` and uploads to `/api/images`; the `/n` skill drives `create_image` / `view_images`. The web UI consumes `/api/*`, `/api/events` and `/api/chat`, and iteration 4 swaps in a real `ChatBackend`. Tests: `tests/unit/{ids,tags,config,db-client,notes.helpers,mcp.instructions}.test.ts` and `tests/integration/{schema,notes.service,mcp.tools,daemon}.int.test.ts`, plus phase 6's `tests/unit/{chat-stub,static}.test.ts` and `tests/integration/{api,events}.int.test.ts`, and phase 5's `tests/unit/{takenFilter,imageAccess}.test.ts` and `tests/integration/images.{http,mcp}.int.test.ts`.

## Concurrency

The only global state is `neonConfig.webSocketConstructor`, set in `createDb`. A `Db` wraps a connection pool and is safe for concurrent queries. Concurrent writes to one note serialise on the `SELECT ... FOR UPDATE` row lock inside each service transaction. Inserts do not lock: an id clash returns null and is retried. `NoteEvents` listeners run synchronously on emit, after commit. MCP requests share nothing: each gets its own server and transport. Each `/api/events` connection adds one `NoteEvents` listener and one heartbeat interval, both removed on abort. SSE writes from listeners are fire-and-forget and swallow write errors after the client goes away. Integration test files run one at a time (`fileParallelism: false`) because they share and truncate one database.

Image ingest keeps a per-process promise chain per sha256, so two ingests of the same bytes in one daemon run in sequence. Across hosts, the unique live-sha256 index decides, and the loser gets `duplicate_image` and returns the winner. Derivative generation shares one in-flight promise per output path and writes through a temp file and rename. The inbox watcher handles one file at a time on a single promise queue.

## Error Handling

- `ConfigError` (config), `InvalidIdError` (ids, carries `input`), `RangeError` (generateId with a bad injected RNG).
- `NoteError` with `code` is the service's only deliberate error. Its codes: `invalid_id`, `invalid_input` (bad date, cursor or empty search), `not_found`, `deleted`, `empty_body`, `conflict`, `duplicate_image` (Postgres 23505 on the live-sha256 index) and `invalid_revision`.
- MCP handlers never throw. `run()` turns errors into `isError` results with text `"<code>: <message>"`, or `"error: <message>"` for anything else.
- `/mcp` returns JSON-RPC-shaped errors: 403 for a non-loopback host or Origin, 405 for GET/DELETE.
- `/api` errors are `{ error: string }`. One mapping turns `NoteError` into a status: `not_found` and `deleted` are 404 `not_found`, `conflict` and `duplicate_image` are 409 with the code, `invalid_id` is 400 `invalid_id`, and any other code is 400 `"<code>: <message>"`. Bad JSON is 400 `invalid_json`, and zod failures are 400 with `"<path>: <message>"` joined by `; `. Non-`NoteError` exceptions are rethrown (Hono 500).
- `/api/chat` errors after streaming starts arrive as `event: error`, not as an HTTP status.
- Image routes answer `{ error }` JSON: 404 `not_found` (bad, unknown or deleted id), 404 `no_image` with `id` (text note), 404 `not_on_this_machine` with `host`, 400 `bad_multipart` / `file_required`, 413 `too_large` (from `bodyLimit`, with `max_bytes`, or from the size check), and 415 for any other `ImageInputError` (`not_an_image`). Other exceptions go to Hono (500).
- `ImageInputError` (`src/http/imageAccess.ts`) carries `not_absolute`, `not_found`, `not_a_file`, `not_an_image` or `too_large`. MCP `create_image` returns it as an `isError` result. `view_images` never errors per id; it reports problems as text lines.
- Static: 503 `web UI not built: run npm run build` when `web/dist/index.html` is missing.
- Driver errors are not wrapped, except the unique violation in `insertNote`.
- Images: `UnsupportedImageError` (probe; carries `detectedMime`), `OriginalMissingError` (derive; carries `id`), `DestinationExistsError` (store; never overwrites), and a plain `Error` when a path escapes the data dir, when no free id is found in 5 attempts, or when a preview cannot fit 3.75 MB. The inbox watcher never throws. It logs the failure and moves the file to `inbox/failed/`.
- Only `src/main.ts` calls `process.exit`: on startup failure, and on shutdown (forced after 10 s).

## Testing

- `npm test`: unit tests in `tests/unit/**/*.test.ts` (node) plus `web/src/**/*.test.tsx` (jsdom via a per-file `// @vitest-environment jsdom` pragma).
- `npm run test:int`: `scripts/test-int.sh` creates, starts or reuses the Docker container `mcp-notes-pg-test` (postgres:16, `127.0.0.1:55433`, db `mcp_notes_test`) and waits on `pg_isready`. It then exports `TEST_DATABASE_URL` and `VITEST_INTEGRATION=1` and runs `tests/integration/**/*.int.test.ts`. `globalSetup` applies `drizzle/*.sql` once.
- Integration helpers in `tests/integration/setup.ts`: `testDatabaseUrl()` (refuses a Neon URL), `openTestDb()`, `closeTestDb()`, `migrateTestDb()`, `truncateAll(db)` (call in `beforeEach` of any file that writes).
- There is one `vitest.config.ts`. Do not add a second.
- Phase 6 suites: `chat-stub` (delta splitting, thread id, abort), `static` (503 fallback, reserved prefixes, assets cache, `/full/:id`, SPA fallback, traversal), `api.int` (all `/api` routes, filters, paging, error mapping, chat SSE) and `events.int` (connect comment, note events, heartbeat, unsubscribe on abort). Helpers: `tests/integration/helpers/api-harness.ts` (`createApiHarness` mounts `apiRoutes` with a zero-delay stub over the Docker DB; `uniqueTag()`) and `tests/integration/helpers/sse.ts` (`parseSse`, `readUntil`, `waitFor`).
- Phase 2 suites: `notes.helpers` (dates, cursor, limit, tag input, origin, rowToNote, NoteEvents), `mcp.instructions` (unit), `notes.service.int` (service against Docker Postgres), `mcp.tools.int` (all 11 tools through an MCP client on the real `/mcp` route, plus the 403/405 guards and `/health`) and `daemon.int` (data dirs, loopback listen, `/health`, MCP initialize over real HTTP, non-loopback host refused).
- Phase 5 suites: `tests/unit/takenFilter.test.ts` (taken bounds as UTC ISO text compares, `invalid_input` on garbage), `tests/unit/imageAccess.test.ts` (`expandHome`, `etagMatches`), `images.http.int` (upload and dedupe, byte-exact original with immutable cache and sha256 ETag, id spellings, thumb/preview sizes, display for PNG vs TIFF, 400/413/415 refusals, `not_found`/`no_image`, `not_on_this_machine`, no cached derivative once the original is gone) and `images.mcp.int` (tool and filter listing, `create_image` copies and dedupes, refusals, `view_images` content, text/unknown/missing explanations, the 8-id cap, `has_image` and taken-range filters on list and search). Harness: `tests/integration/imageHarness.ts` (`startHarness` builds real `createApp` over the Docker DB and a temp data dir, with `listen()`, `reset()`, `close()`; `makeImage` makes solid-colour PNG/JPEG/TIFF bytes; `insertTextNote`).
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
- `createApp` passes no `ApiOptions`, so the stub chat backend is hard-wired until iteration 4 changes that call.
- `staticRoutes` must stay last and must 404 reserved prefixes itself, or unknown `/api/*` paths would get `index.html`.
- Ids are canonical upper-case with the dash. Store `normalizeId`/`parseId` output, never raw user input.
- Integration tests truncate tables. Never point `TEST_DATABASE_URL` at Neon (the setup helper also refuses it). The container port 55433 avoids `seer-pg` on 55432.
- The installed unit and the `/n` skill symlink point at the checkout that ran `scripts/install.sh`. Phase 3 ran it from the worktree, so after the set lands on `main` re-run `cd ~/mcp-notes && git pull && scripts/install.sh`, or the unit fails and the skill dangles once the worktree is deleted.
- The unit uses an absolute node path because the systemd user manager's PATH lacks `~/tools/...`.
- Claude Code is registered against `http://localhost:7317/mcp` while the daemon binds `127.0.0.1`; this relies on `localhost` resolving to IPv4.
- A dev `notesd` already on port 7317 makes the installer's health check pass against the wrong process. Stop it first (`ss -ltnp 'sport = :7317'`).
- Linger only starts `notesd` when the distro boots; it does not keep WSL alive. The Windows keepalive task does that.

## Notes

Plan set: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (8 phases, iterations 1-3: spine, images, web UI). Phase 1 (P1-NOTES-A000) landed the scaffold. Phase 2 (P1-NOTES-A001, plan `.workflows/plan/P1-NOTES-A001.md`) landed the notes service, the MCP server and tools, and the `notesd` daemon. Phase 3 (P1-NOTES-A002) landed deployment: `deploy/notesd.service`, `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/windows/install-wsl-keepalive.ps1`, the `/n` skill in `claude/skills/n/` and `docs/INSTALL.md`. Phase 5 (P1-NOTES-A004) landed the image HTTP routes and upload, the `create_image`/`view_images` MCP tools, the `has_image` and taken-date filters, and the images section of the MCP instructions. Phase 6 (P1-NOTES-A005) landed the `/api` JSON routes, `/api/events` SSE, the `/api/chat` stub behind `ChatBackend`, and static SPA serving.
