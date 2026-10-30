# Code Analysis: mcp-notes iterations 1–3 (Spine, Images, Web UI)

**Type:** Feature Implementation
**Date:** 2026-10-30 09:20 WIB
**Session ID:** 20261030-092006-K7N3
**Plan:** `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (8 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/notes-spine-images-ui`, branch `feature/notes-spine-images-ui` (base `origin/main` @ `4bff8fb`, fast-forwarded to `30a58fd` for the R3 change)

---

## User Input

### Original User Request

Invocation: `/analyze feature The request is the file docs/iterations/01-03-spine-images-ui.md: read it and take everything below its line, plus everything below the line of docs/iterations/01-spine.md which it includes, as the verbatim user input for Step 0.`

#### Verbatim — `docs/iterations/01-03-spine-images-ui.md`, below the line

```
Build mcp-notes iterations 1, 2 and 3 from docs/ROADMAP.md as one plan set. The "Fixed
decisions" table in docs/ROADMAP.md is binding: do not re-decide anything in it.

R1 — Spine (iteration 1). The full requirement is docs/iterations/01-spine.md, everything below
its line. It is part of this request verbatim: notesd daemon (Hono, 127.0.0.1:7317, MCP over
streamable HTTP at /mcp), Neon schema via Drizzle, note ids like A-B32, tags parsed from
#hashtags, note_revisions, the MCP tools, the /n skill, systemd autostart + Windows Task
Scheduler script, `claude mcp add --scope user`, vitest unit + integration tests.

R2 — Images (iteration 2). An image note is a note whose image file lives on this laptop only.
  - Originals are stored byte for byte, never re-encoded, never resized:
    ~/mcp-notes-data/images/YYYY/MM/<note-id>.<original-ext>. Record sha256 (dedupe: the same
    file twice returns the existing note), width, height, bytes, mime, EXIF taken_at, original
    filename, in notes.image_meta; notes.image_path holds the relative path.
  - Derived files, regenerable, in a separate cache dir: a grid thumbnail and a "preview" capped
    to what Claude's image input accepts. Phone photos may be HEIC: keep the HEIC original, and
    produce a full-resolution browser-displayable derivative for viewing only.
  - Ingestion: (a) HTTP upload from the web UI (drag/drop, paste); (b) an inbox folder,
    ~/mcp-notes-data/inbox, watched by notesd: every image dropped there becomes an image note
    and the file is moved into the store; (c) an MCP tool that creates an image note from a local
    file path (Claude Code often has a screenshot path at hand), with optional body text.
  - MCP: get/list results say whether a note has an image; a tool returns the preview image
    itself (as MCP image content) plus metadata, so Claude can look at pictures ("show me some
    pictures that i saved on 30 oct. give your comments on them"); list can filter by
    has_image and by date (saved date and EXIF taken date).
  - HTTP: serve original, display derivative, thumbnail, by note id.
  - On a machine where the file is missing (the GPD shares the Neon DB but not the files), the
    note still loads and the UI shows a "not on this machine" placeholder. No image sync, ever.

R3 — Web UI (iteration 3). Implement the Claude Design in docs/design/claude-design/:
`Notes Wall.dc.html` (main screen) and `Fullscreen.dc.html` (full-screen tab). `support.js` is
only the design tool's runtime that renders those files; read it to understand the template
syntax (`{{ }}`, sc-for, sc-if, style-hover, data-props screens), do not ship it.
  - Vite + React + TypeScript SPA, built and served statically by notesd on the same port.
    Open from the Windows browser at http://localhost:7317.
  - Match the design exactly: #121211 canvas, #ecebe4 text, Host Grotesk + Geist Mono, Phosphor
    duotone icons (npm package, not the CDN), the grain overlay, the giant right-aligned heading
    ("Notes." / "Everything." / "#seer" / "Photos."), the rotated round "+" sticker, the masonry wall with
    font size by text length, tag chips inside text, ID + copy-id + date on every card, the icon
    rail + collapsible tag sidebar with active-filter chips, the pill chat bar, the answer panel
    with pin/dismiss and "used notes" chips that dim the rest of the wall, the clean gallery
    grid in image mode, the photo modal (prev/next, copy ID, show full screen, close; Esc and
    arrow keys), the drag-over overlay, the custom tooltips. Icon-only controls everywhere.
  - Note visibility is a 3-way mode, not an on/off "show image notes" toggle:
    (a) text notes only, image notes hidden: THE DEFAULT on every page load;
    (b) image notes only: the clean photo gallery grid;
    (c) all notes, text and image mixed on the wall.
    The rail has one button that cycles a -> b -> c -> a and shows the current mode's icon
    (inverted when not the default); the expanded sidebar shows all three as icons, active one
    inverted. Tag filters apply in every mode. Adding an image while in (a) switches to (c) so
    the new note is visible; "+" in (b) switches to (a); jumping to a note the current mode
    hides (from the chat panel) switches to (c). The design file already implements this.
  - Replace the design's fake data with the real API: notes, tags with counts, filters by tag
    (AND, as in the design) and image mode, inline edit saved on blur (an emptied text note is
    soft-deleted, as the design does), the "+" creates a note, drag/drop and paste upload
    images, relative dates, "Last edited <id> <when>" from real data.
  - Where the design is a mock, follow ROADMAP instead: ids are generated by the server in the
    ROADMAP format (the design's newId is a placeholder); picsum URLs become the notesd image
    URLs; the modal shows the display derivative, never a downscaled guess.
  - The film-tone CSS filter applies on the wall, gallery and modal only. The full-screen tab
    shows the true original (or the HEIC display derivative) with no filter: fit by default,
    click toggles 1:1 pixels, drag to pan, tab title is the note id.
  - Chat bar: the chat brain is iteration 4, not this one. Build the bar and the answer panel
    for real, wired to a POST /api/chat endpoint that streams. In this iteration that endpoint
    streams a fixed "chat brain arrives in iteration 4" reply, so iteration 4 only swaps the
    backend. Used-note highlighting works by finding note ids in the answer text.
  - Notes created or edited by Claude through MCP appear on the wall without a manual reload
    (poll or server-sent events, planner's choice).

Out of scope: the real chat brain (iteration 4), connectors to expense-tracking / run-insights /
seer (iteration 5), embeddings and semantic search (iteration 6), any image sync to the GPD, a
title field or any typed note structure, a search bar.
```

#### Verbatim — `docs/iterations/01-spine.md`, below the line (included by R1)

```
/analyze feature --no-worktree
Build iteration 1 ("Spine") of mcp-notes. Read docs/ROADMAP.md first: its "Fixed decisions"
table is binding, do not re-decide anything in it. This repo is empty apart from docs/ and
.env.local (LLM_*, DATABASE_URL, DATABASE_URL_UNPOOLED for this project's own Neon database).

Context: I keep Claude Code open all working day in WSL. mcp-notes is a local daemon that every
Claude Code session reaches through MCP. I trigger it with `/n <request>` from any repo. Later
iterations add images, a web UI, a chat bar, connectors to my other systems and semantic search;
this iteration builds the backbone they hang on, so leave clean seams for them but do not build
them.

What I want in this iteration:

1. `notesd`: a Node 22 + TypeScript daemon (Hono) in this repo. Binds 127.0.0.1:7317 only.
   Serves MCP over streamable HTTP at /mcp (@modelcontextprotocol/sdk) and GET /health.
   Config from .env.local. Data dir ~/mcp-notes-data (created if missing; images come in iter 2).

2. Neon schema via Drizzle (same style as ~/expense-tracking and ~/run-insights: drizzle-kit
   migrations, @neondatabase/serverless):
   - notes(id, body, tags text[], image_path null, image_meta jsonb null, origin jsonb,
     created_at, updated_at, deleted_at). GIN index on tags, full-text index on body using the
     'simple' config (notes are full of code tokens; english stemming mangles them).
     image_* columns exist now but stay unused until iteration 2.
   - note_revisions(note_id, body, saved_at): every update and every delete stores the previous body.
   - id format: one char [0-9A-Z], a dash, three chars [0-9A-Z]  (e.g. A-B32). Random, collision
     retried, lookup case-insensitive and tolerant of a missing dash ("ab32" finds A-B32).
   - tags: parsed from #hashtags in the body on every write (#v250, #from_phone, #ai_image, #seer).

3. MCP tools (names and descriptions written for Claude, since Claude is the only caller):
   create, get (one or several ids), update (full body replace), append, delete (soft), restore,
   list (filter by tags any/all, date range on created or updated, newest first, limit/cursor),
   search (full-text + tag + date filters, ranked), tags (all tags with counts and last-used date),
   revisions(id) and revert(id, revision).
   Every note returned carries id, body, tags, created_at, updated_at, and origin.
   create/update accept an optional origin {cwd, repo, claude_session} so notes saved from a repo
   remember where they came from. Comparisons like "this week vs last week" or "#seer vs #v250"
   are done by Claude from list/search results; the tools only need good filters, not analytics.
   Also expose MCP server instructions telling Claude what mcp-notes is and how ids look.

4. The `/n` skill at ~/.claude/skills/n/SKILL.md (user level, so it works in every repo):
   tells Claude the text after /n is a request for mcp-notes, to use the `notes` MCP tools,
   to pass the current cwd/repo as origin when saving, to quote note ids in replies, and for
   "save this session's insights" to write a dense plain-text note with hashtags it chooses.
   Keep the skill in this repo (e.g. claude/skills/n/SKILL.md) and install it by symlink, so it
   is versioned.

5. Autostart: a systemd user unit for notesd, an install script that enables it and runs
   `loginctl enable-linger`, registers the MCP server with
   `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`, and symlinks
   the skill. Plus a Windows side: a PowerShell script that creates a Task Scheduler entry at
   logon running `wsl.exe -d <distro> -- sleep infinity` hidden. Verify what you can from WSL
   (unit active, /health, `claude mcp list` shows notes connected) and document the Windows step
   and whether WSL stays up without a terminal attached.

6. Tests: vitest. Unit tests for id generation/normalisation and tag parsing; integration tests
   for the tools against a real Postgres (follow how ~/expense-tracking does test:int).

Acceptance (run these through Claude Code once it is installed):
  /n let's get this session insights up until now and save it as a new note
  /n check notes that has #v250 tags. i wonder what my last note about it was
  /n check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
  /n summarize our notes on #seer this week. compare it to last week
  /n summarize our notes on #seer this week. compare it to #v250

Out of scope: images, web UI, chat bar, connectors to expense-tracking/run-insights/seer,
embeddings. Do not add a title field or any typed note structure: one text field, by design.
```

### User-Provided Context

- **Requirement change received mid-analysis** (owner commit `30a58fd` on origin/main, relayed by a peer session; merged into this worktree by fast-forward): the 3-way visibility mode above, plus the matching changes to `Notes Wall.dc.html` (`state.mode`, the `modes` table, `cycleMode`, `modeOpts`). The R3 text above is the post-change version of the brief. The API needs a `has_image` filter covering all three modes.

- `docs/ROADMAP.md`. Its "Fixed decisions" table is binding.
- `docs/design/claude-design/Notes Wall.dc.html`, `Fullscreen.dc.html`, `support.js` (runtime only, not shipped).
- `docs/design/claude-design-prompt.md`: the brief the design was made from.
- `.env.local` holds `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY`.

### User-Provided Files
- `docs/iterations/01-03-spine-images-ui.md`
- `docs/iterations/01-spine.md`
- `docs/ROADMAP.md`
- `docs/design/claude-design/Notes Wall.dc.html`
- `docs/design/claude-design/Fullscreen.dc.html`
- `docs/design/claude-design/support.js`

### Requirement IDs

The brief numbers its own requirements R1–R3; those numbers are kept.

| ID | What the user asked for |
|---|---|
| R1 | Spine (iteration 1): `notesd` (Hono, 127.0.0.1:7317, MCP over streamable HTTP at `/mcp`, `/health`), Neon schema via Drizzle, `A-B32` ids, `#hashtag` tags, `note_revisions`, the MCP note tools, the `/n` skill, systemd autostart + install script + Windows Task Scheduler script, `claude mcp add --scope user`, vitest unit + integration tests |
| R2 | Images (iteration 2): byte-exact local image store with sha256 dedupe and metadata, regenerable thumbnail / Claude preview / HEIC display derivatives, ingestion by HTTP upload, inbox folder and MCP tool, MCP image viewing and image/date filters, HTTP image serving, "not on this machine" fallback |
| R3 | Web UI (iteration 3): the Claude Design implemented as a Vite + React + TS SPA served by `notesd`, wired to the real API, with gallery, modal, full-screen tab, upload, inline edit, a streaming `/api/chat` stub, and live updates for MCP-side edits |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** The repo is empty apart from docs. Everything is greenfield: one Node 22 + TypeScript package that builds a single daemon, `notesd`. The daemon has three faces: an MCP server for Claude Code at `/mcp`, a JSON + file HTTP API at `/api/*`, and a static SPA at `/`. All three share one notes service over a Neon Postgres database, and image files live on local disk under `~/mcp-notes-data`. The daemon runs as a systemd user unit inside WSL, and a Windows Task Scheduler entry keeps WSL up.

**Success criteria.**
- `systemctl --user is-active notesd` reports active, `curl http://127.0.0.1:7317/health` returns ok, and `claude mcp list` shows `notes` connected.
- The five iteration-1 acceptance prompts work through `/n` (manual check; the tools they need exist and are covered by integration tests).
- Saving the same image file twice, through any of the three ingestion paths, returns the same note.
- `view`-style MCP tool returns image content Claude can see. `list` filters by `has_image` and by saved date and EXIF taken date.
- `http://localhost:7317` in the Windows browser renders the design with real data. The UI behaviours listed in R3 all work.
- `npm test` (unit) and `npm run test:int` (real Postgres) pass. `npm run build` produces server + web bundles. `npm run typecheck` is clean.

**Key considerations.**
- **Driver vs tests.** Production must use `@neondatabase/serverless` (brief). Integration tests must hit "a real Postgres" the way expense-tracking does, which is a `TEST_DATABASE_URL` that skips when absent. Unattended phase sessions have no Neon branch and no `neonctl`. Docker is available, so a local `postgres:16` container is a real Postgres. The Neon drivers cannot talk to plain Postgres without a websocket proxy, so the DB client needs a driver switch by URL: Neon host means the `@neondatabase/serverless` Pool, anything else means `pg`.
- **Transactions.** Update/delete/revert must write the revision and the new body atomically. `neon-http` has no interactive transactions. The websocket `Pool` (`drizzle-orm/neon-serverless`) and `node-postgres` both do.
- **`.env.local` is gitignored.** The worktree gets a symlink to the main checkout's file, created at worktree setup. The config loader must read `.env.local` from the repo root and must not crash when keys it does not need (LLM_*, OPENROUTER) are present.
- **HEIC.** sharp's prebuilt libvips decodes HEIF/AVIF but not HEVC-coded HEIC. A pure-JS/WASM decoder (`heic-convert` / `libheif-js`) is needed for the HEIC display derivative. `exifr` reads EXIF from JPEG, PNG, HEIC and WebP.
- **Claude image input.** The preview has to fit Claude's limits: long edge ≤ 1568 px (the size Claude does not downscale further), JPEG, under ~5 MB, base64 in MCP `image` content.
- **Same-port SPA + API.** The SPA is served from `web/dist` with an `index.html` fallback for client routes. `/mcp`, `/api/*` and `/health` are matched first.
- **Live updates.** Every write goes through one notes service inside the daemon, so an in-process event bus pushes SSE to the UI. Writes from the GPD's daemon go to the shared DB and never reach this bus, so the UI also re-fetches on an interval.
- **Systemd unit path.** The unit runs code from the checkout that ran `install.sh`. A run from the phase worktree points the unit at a directory the landing step deletes. After landing, `install.sh` has to be re-run from `~/mcp-notes`. It is idempotent.

**Assumptions.**
- Timezone for date filters is the process's local timezone (WIB, Asia/Jakarta on this machine). Tools accept ISO dates or datetimes.
- The design's tag regex `#[a-z0-9-]+` loses to the brief's examples (`#from_phone`, `#ai_image`), so tags are `#[A-Za-z0-9_-]+`, lower-cased. A `#` inside a word (`C#`, `a#b`) is not a tag.
- The note-id alphabet is the full `[0-9A-Z]` per ROADMAP. The design's `newId` alphabet is a mock.

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/ROADMAP.md`: fixed decisions, iteration table, acceptance set.
- `docs/iterations/01-spine.md`, `docs/iterations/01-03-spine-images-ui.md`: the request.
- `docs/design/claude-design/Notes Wall.dc.html`: the main-screen design (360 lines; markup lines 24–164, logic 167–357).
- `docs/design/claude-design/Fullscreen.dc.html`: the full-screen tab (fit / 1:1 toggle / pan).
- `docs/design/claude-design/support.js`: design runtime (`DCLogic`, `{{ }}`, `sc-for`, `sc-if`, `style-hover`, `data-props`). Reference only.
- `docs/design/claude-design-prompt.md`: design brief.

### Discovered Related Files (sister repos, style reference only)
- `~/expense-tracking/drizzle.config.ts`: loads `.env.local` with dotenv and refuses a pooled host for migrations (`DATABASE_URL_UNPOOLED`). `strict: true`, `out: ./drizzle`.
- `~/expense-tracking/lib/db/index.ts`: `drizzle(neon(url), { schema })` over `neon-http`, a globalThis-cached instance, and a loud error on a missing `DATABASE_URL`.
- `~/expense-tracking/vitest.config.ts`: one config. `tests/integration/**` is excluded unless `VITEST_INTEGRATION=1`.
- `~/expense-tracking/package.json`: `"test:int": "VITEST_INTEGRATION=1 vitest run tests/integration"`, plus `db:generate`, `db:migrate`, `db:check` scripts. Versions in use: drizzle-orm 0.45.2, drizzle-kit 0.31.10, @neondatabase/serverless 1.1.0, vitest 4.1.2, typescript 5.9.3, tsx 4.23.12, sharp 0.35.3, zod 4.4.3.
- `~/expense-tracking/tests/integration/queries.int.test.ts`: `describe.skipIf(!process.env.TEST_DATABASE_URL)`, a real DB, random fixture ids, cleanup in teardown.
- `~/run-insights/vitest.config.ts`: same pattern.

### Environment facts (measured)
- Node v22.23.1 at `~/tools/node-v22.23.1-linux-x64/bin`. `claude` is in the same bin dir. The systemd unit must use an absolute node path because the user unit's PATH does not include it.
- WSL distro `Ubuntu`, `/etc/wsl.conf` has `[boot] systemd=true`, `systemctl --user is-system-running` → `running`.
- Docker is available. `postgres:16` runs as `seer-pg` on 55432 (another project's, not to be touched). No `neonctl`, `exiftool`, ImageMagick or `heif-convert`.
- `~/mcp-notes-data` does not exist yet. Port 7317 is free.
- `~/.claude/skills/` has no `n` skill.

---

## Current Dataflow

There is no code. These are the flows the design and brief imply, as the target behaviour.

### Entry Point: MCP (`POST /mcp`, streamable HTTP)
**Trigger:** Claude Code with `notes` registered at user scope. Claude's `/n` skill turns user prose into tool calls.
**Flow:** Hono route → `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` (stateless: a new server+transport per request, `sessionIdGenerator: undefined`) → tool handler → notes service → Drizzle → Neon. Writes emit `note.changed` on the event bus.
**Exit:** MCP `content` (text JSON of notes; `image` content for the view tool).

### Entry Point: web UI (`/`, `/api/*`)
**Trigger:** browser at `http://localhost:7317` (Windows reaches WSL's 127.0.0.1 through WSL localhost forwarding).
**Flow:** SPA → `GET /api/notes`, `GET /api/tags`, `POST/PATCH/DELETE /api/notes/:id`, `POST /api/images` (multipart) → the same notes/image services. `GET /api/events` (SSE) pushes changes. `POST /api/chat` streams a fixed reply.
**Exit:** JSON, image bytes, an SSE stream, a chat text stream.

### Entry Point: inbox watcher
**Trigger:** a file appears in `~/mcp-notes-data/inbox`.
**Flow:** wait for the size to stop changing → sniff the image type → the image service ingests it (hash → dedupe → move into the store → derivatives → insert note) → the event bus fires. Non-images stay where they are. A failure leaves the file in `inbox/failed/`.

### Processing chain (image ingest)
1. sha256 of the bytes → lookup on `image_meta->>'sha256'` among non-deleted notes → an existing note is returned unchanged.
2. Probe: mime by magic bytes, width/height (sharp metadata; HEIC through the decoder), EXIF `DateTimeOriginal` (exifr).
3. Generate the id, write the original byte for byte to `images/YYYY/MM/<id>.<ext>` (`YYYY/MM` from the save time, `ext` from the original filename lower-cased, else from the mime).
4. Insert the note with `image_path` (relative to the data dir) and `image_meta`.
5. Derivatives go to `~/mcp-notes-data/cache/<id>/`: `thumb.webp` (480 px wide), `preview.jpg` (long edge ≤ 1568), and `display.jpg` (full resolution, only when the original is not browser-displayable, i.e. HEIC/HEIF/TIFF). They are generated lazily on first request if missing, so the cache can be wiped.

### Data Persistence
**Database (Neon, `DATABASE_URL` pooled for runtime; `DATABASE_URL_UNPOOLED` for drizzle-kit):**
- `notes`: `id text pk`, `body text not null`, `tags text[] not null default '{}'`, `image_path text null`, `image_meta jsonb null`, `origin jsonb null`, `created_at timestamptz`, `updated_at timestamptz`, `deleted_at timestamptz null`. Indexes: GIN(tags); GIN(`to_tsvector('simple', body)`); btree(created_at), btree(updated_at); a unique partial index on `(image_meta->>'sha256') where image_meta is not null and deleted_at is null`; an expression index on `((image_meta->>'taken_at'))`.
- `note_revisions`: `id bigserial pk`, `note_id text fk → notes.id`, `body text`, `saved_at timestamptz default now()`, index `(note_id, saved_at desc)`.
**Disk:** `~/mcp-notes-data/{images,cache,inbox}`.

### Exit Points
MCP responses, HTTP JSON, image bytes (`Cache-Control: immutable` on originals, which never change), SSE.

---

## Key Data Structures (to be created)

### `Note` (wire shape, shared by MCP, HTTP and UI)
```ts
{ id: string; body: string; tags: string[]; created_at: string; updated_at: string;
  origin: { cwd?: string; repo?: string; claude_session?: string; source?: string } | null;
  image: null | { mime: string; width: number; height: number; bytes: number; taken_at: string | null;
                  original_name: string | null; available: boolean; host: string | null } }
```
`deleted_at` appears only on results of `restore`/`get` that include deleted notes. `image.available` is computed per request: the file exists on this machine.

### `ImageMeta` (`notes.image_meta`)
`{ sha256, mime, width, height, bytes, taken_at, original_name, host }`. `host` is `os.hostname()` at ingest. It lets the placeholder say where the file lives without contradicting ROADMAP's "on Lenovo" wording.

---

## Dependencies

### Configuration
`.env.local`: `DATABASE_URL` (pooled; runtime), `DATABASE_URL_UNPOOLED` (migrations). Optional, with defaults: `NOTESD_PORT=7317`, `NOTESD_HOST=127.0.0.1` (the bind is pinned to loopback, and the code refuses any other host), `NOTES_DATA_DIR=~/mcp-notes-data`. Tests: `TEST_DATABASE_URL`.

### External services
Neon Postgres (shared with the GPD). Google Fonts are not used: Host Grotesk and Geist Mono are bundled from npm (`@fontsource-variable/host-grotesk`, `@fontsource/geist-mono`) so the UI works offline and loads no third-party CSS. Phosphor comes from `@phosphor-icons/react` (npm, duotone).

### Libraries (chosen)
hono + @hono/node-server, @modelcontextprotocol/sdk, drizzle-orm + drizzle-kit, @neondatabase/serverless + ws, pg (tests and non-Neon URLs), zod, sharp, heic-convert, exifr, file-type, chokidar, vitest, tsx, typescript; web: vite, react, react-dom, @vitejs/plugin-react, @phosphor-icons/react, the two font packages.

---

## Reference List

Greenfield: there are no existing call sites. Design → implementation map for R3 (line numbers in `Notes Wall.dc.html`):

| Design element | Lines | Becomes |
|---|---|---|
| global styles, grain overlay, fonts | 11–22 | `web/src/styles.css` + font imports |
| icon rail (toggle sidebar, new note, 3-way mode cycle, active chips, clear) | 26–37 | `Rail` component |
| tag sidebar with counts | 39–55 | `Sidebar` (data: `GET /api/tags`) |
| header: count line, "Last edited", giant heading, "+" sticker | 58–64 | `Header` |
| masonry wall, cards, inline edit, tag chips, id/copy/date | 67–91, 292–311 | `Wall`, `NoteCard` |
| gallery grid | 93–102, 313 | `Gallery` |
| answer panel (pin, dismiss, used chips) | 105–124, 322–324 | `AnswerPanel` |
| pill chat bar | 126–129 | `ChatBar` → `POST /api/chat` |
| photo modal | 131–155, 315–321 | `PhotoModal` |
| drag overlay | 157–159, 350–352 | `DropOverlay` + upload |
| tooltips | 161–163, 207–212 | `Tooltip` (document-level `mouseover` on `[data-tip]`) |
| keyboard (Esc, arrows), paste | 213–224 | global handlers |
| `newId`, picsum `picUrl`, fake `answerText`, fixed `usedIds`, fake dates | 247, 262, 200–201 | replaced by server ids, `/api/notes/:id/{thumb,display,original}`, streamed reply, ids parsed from the answer, relative dates |
| `Fullscreen.dc.html` | whole file | `web/fullscreen.html` second Vite entry (`/full/:id` served by notesd) |

---

## Impact Points (files that WILL be created)

1. `package.json`, `tsconfig*.json`, `vitest.config.ts`, `drizzle.config.ts`, `.gitignore`: P1
2. `src/config.ts`, `src/db/{schema,client,migrate}.ts`, `drizzle/0000_*.sql`, `src/notes/{ids,tags}.ts`, `scripts/test-db.sh`, `tests/unit/*`, `tests/integration/setup.ts`: P1
3. `src/notes/{service,repo,events,types}.ts`, `src/mcp/{server,tools,instructions}.ts`, `src/http/app.ts`, `src/main.ts`, `tests/integration/notes*.int.test.ts`: P2
4. `claude/skills/n/SKILL.md`, `deploy/notesd.service`, `scripts/install.sh`, `scripts/windows/install-wsl-keepalive.ps1`, `docs/INSTALL.md`: P3
5. `src/images/{store,probe,derive,ingest,inbox}.ts`, tests: P4
6. `src/http/images.ts`, `src/mcp/imageTools.ts`, list filters in `src/notes/repo.ts`, tests: P5
7. `src/http/api.ts` (notes JSON, tags, SSE, chat stub), static serving in `src/http/app.ts`, tests: P6
8. `web/**` (Vite app, wall, rail, sidebar, header, chat bar, answer panel, tooltips): P7
9. `web/src/{Gallery,PhotoModal,DropOverlay}`, `web/fullscreen.html` + entry, upload wiring: P8

**This document describes. The plan files prescribe.**
