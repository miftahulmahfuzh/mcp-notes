# Code Analysis: chat history, note files, image similarity search

**Type:** Feature Implementation
**Date:** 2026-10-31 08:15 (WIB)
**Session ID:** 20261031-081555-Q4TD
**Plan:** `docs/plans/CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md` (11 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search` on `feature/chat-history-files-image-search` (base `main` @ `d3ef659`)

---

## User Input

### Original User Request

```
feature
Read docs/plans/2026-10-31-chat-history-files-image-search-design.md (agreed design, do not re-litigate decisions). Produce the full phased implementation plan for it. Robustness over speed.
```

The agreed design is `docs/plans/2026-10-31-chat-history-files-image-search-design.md` (committed on `main`; copied verbatim into the worktree). Its text is the specification; its six Scope items are the requirement IDs.

### User-Provided Files
- `docs/plans/2026-10-31-chat-history-files-image-search-design.md`

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Paste an image into the chat query bar (wall chat, and `/n` in Claude Code); global paste handler yields to the focused ChatBar |
| R2 | Note files: attach any file to a note from the bigger-note-view modal (picker, ctrl-v, drop), sha256 store, `extracted_text`/`status` columns, agent tools see name/size/type, per-file and note-level reveal |
| R3 | Chat history: persisted in our own DB, own page, reply_to, edit/delete, note-id links, image thumbnails, Claude Code capture hook, sidebar icon, full-screen button |
| R4 | One shared image lightbox (chat thumbnails + note modal gallery strip, arrows by click and key) |
| R5 | Real image similarity search: Gemini Embedding 2 via OpenRouter, `note_image_embeddings`, worker, backfill, `similar_images` tool, text-to-image |
| R6 | UI fix: "Show in explorer" in the note card footer is centered; move it left |

---

## Detailed Requirements Understanding

**Problem statement.** Today the chat bar is a stateless single-exchange panel that relies on Agent SDK `resume` for continuity, accepts only text, and keeps no history; notes hold text plus images only; image notes are findable only by their text; one image can only be opened through the Gallery's `PhotoModal`. The design adds a persistent, our-own-DB chat history with its own page, images and files as first-class attachments, a real image-embedding search, and a shared lightbox.

**Success criteria.**
- Every wall chat turn and every `/n` Claude Code exchange (from either laptop) is a row in our DB, visible on a history page in UTC+7.
- Wall chat context is rebuilt from our rows (+ `reply_to` targets), `resume` no longer used; `claude` and `glm` brains behave identically.
- A note can hold non-image files, deduped by sha256, visible to agents by name/size/type.
- `similar_images` returns nearest images for an existing image id, a pasted image (wall chat upload or Claude Code paste) or a text query.
- Tree builds, `npm test`, `npm run typecheck` and `npm run test:int` pass at the end of every phase.

**Key considerations / assumptions.**
- The daemon is single-user, loopback-only, no auth (`src/config.ts`: `host` fixed to 127.0.0.1); two laptops each run their own daemon against one shared Neon DB, each with its own local data dir (images carry `host`; `available` says whether the bytes are here).
- drizzle migrations are a strict chain (`drizzle/meta/_journal.json`, `NNNN_snapshot.json`); parallel `db:generate` runs would collide, so phases that add a migration are chained by `Depends on`.
- Verified facts (2026-10-31): OpenRouter `google/gemini-embedding-2` takes `input: [{content:[{type:'text'},{type:'image_url',image_url:{url:'data:image/png;base64,...'}}]}]`, default 3072 dims, `dimensions` parameter confirmed for text (not shown for images), text $0.20 / image $0.45 per M tokens, 8192-token input cap, PNG is the verified image type. pgvector HNSW on `vector` caps at 2000 dims, so 3072 cannot be indexed directly.
- Verified facts (Claude Code 2.1.314): a transcript user entry for `/n args` is the string `<command-message>n</command-message><command-name>/n</command-name><command-args>…</command-args>`; a pasted image is a `{type:'image',source:{type:'base64',media_type,data}}` block in the user entry's content array, entry carries `imagePasteIds:[1]`; there is no `~/.claude/image-cache` file for it. Hooks: `Stop` input has `transcript_path`, `session_id`, `last_assistant_message` (transcript may lag); `PreToolUse` input has `tool_name`, `tool_input`, `transcript_path` and may return `hookSpecificOutput.updatedInput`; user-scope `~/.claude/settings.json` hooks apply to every repo; `async: true` hooks do not block.
- The `/n` agent never receives a file path for a pasted image, so `similar_images` cannot take a path. It takes `pasted_image: N` and a `PreToolUse` hook rewrites it to an `upload_id` (design open item "hook auth/location" and the transport open item are decided in the plan's Decisions).

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/plans/2026-10-31-chat-history-files-image-search-design.md`

### Discovered Related Files
Server: `src/db/schema.ts`, `src/db/client.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/config.ts`, `src/http/{app,api,images,imageAccess,reveal,static,sameOrigin}.ts`, `src/images/{ingest,store,derive,probe,records,inbox,legacy}.ts`, `src/notes/{service,repo,imageRepo,binRepo,types,ids,events,tags}.ts`, `src/embeddings/{constants,embedder,openrouter,repo,state,worker,backfill}.ts`, `src/cli/embedBackfill.ts`, `src/chat/{agent,backend,prompt,status,env,stub}.ts`, `src/mcp/{server,tools,imageTools,instructions}.ts`, `src/search/*`.
Web: `web/src/App.tsx`, `api.ts`, `types.ts`, `main.tsx`, `styles.css`, `components/{ChatBar,AnswerPanel,DropOverlay,NoteCard,NoteEditor,RevealButton,PhotoModal,Gallery,NoteImage,Rail,Sidebar,Bin,UndoBar}.tsx`, `hooks/{useChat,useNotes,useDeepLink,useCapabilities,useUndo}.ts`, `lib/{links,flash,deepLink,usedIds,filter,reveal,sse}.ts`, `fullscreen/*`, `vite.config.ts`.
Claude Code side: `claude/skills/n/SKILL.md`, `claude/mods/note-links/*`, `scripts/{install,uninstall}.sh`, `~/.claude/settings.json` (user settings; carries `CLAUDE_CODE_PLUGIN_DIRS`).
Tests: `tests/{unit,integration,live}`, `tests/integration/{setup,imageHarness}.ts`, `tests/helpers/*`, `vitest.config.ts`, `scripts/test-int.sh`.

---

## Current Dataflow

### Chat (the part R1/R3 rebuild)

**Entry:** `POST /api/chat` (`src/http/api.ts:246`), body `{message, thread_id?}` (`chatSchema`, `api.ts:34`).
**Processing:** `chat.reply({message, threadId, signal})` (`src/chat/backend.ts` `ChatBackend`) → `ChatRun.attempt` (`src/chat/agent.ts:199`) calls the Agent SDK `query({prompt: request.message, options})` with `resume: threadId` (`agent.ts:304`); `cwd = <dataDir>/chat`, tools = notes MCP + WebSearch/WebFetch, `settingSources: []`, system prompt from `buildChatSystemPrompt` (`src/chat/prompt.ts`). Claude is tried first, one fallback to GLM when the failure is `FALLBACK_ERRORS`/`FALLBACK_TEXT` and no text was emitted (`agent.ts:172-197`).
**Exit:** SSE events `delta {text}`, `status {text}`, then `done {thread_id, brain}` or `error {error}` (`api.ts:262-275`). `thread_id` is the SDK session id (`agent.ts:244`).
**State:** none of our own. History lives only in `~/.claude/projects/-…-mcp-notes-data-chat/*.jsonl` (SDK sessions). The browser keeps `threadId` in a ref (`web/src/hooks/useChat.ts:46`); dismissing the panel drops it (`useChat.ts:107`).
**Frontend:** `ChatBar` is a textarea + send button (`web/src/components/ChatBar.tsx`), `App.send` (`App.tsx:355`) calls `chat.ask(q)`; `AnswerPanel` renders the one exchange, linkifies http(s) via `segmentLinks`, shows `usedIds` chips found with `extractUsedIds`.

### Paste / drop

`DropOverlay` (`web/src/components/DropOverlay.tsx:51`) installs `document` `dragover/dragleave/drop/paste` listeners once; `paste` takes the first image from `clipboardData.files` and either `attachImage(target, file)` (when `target`, the id of the open big editor, is set) or `uploadImage(file)` (new note). It never looks at `document.activeElement`.

### Note images (the model R2 mirrors)

`note_images` (`src/db/schema.ts:87`): id (note-id format), note_id, path `images/YYYY/MM/<id>.<ext>`, sha256 (partial unique where `deleted_at is null`), mime, width, height, bytes, taken_at, original_name, host, position (never renumbered), deleted_at. Writes only through `NotesService` (`src/notes/service.ts`): `attachImage`, `removeImage`, `restoreImage`, `purgeNote`, `purgeImage`; each is a transaction that locks the note row first (`lockNote`) and emits one `NoteEvents` op after commit. Ingest (`src/images/ingest.ts`): sha256 → live duplicate returns the holder note (restoring it if deleted) → probe → `originalRelPath` → `writeNewFile` → `service.attachImage` → on failure unplace the file. HTTP: `POST /api/notes/:id/images`, `DELETE /api/images/:id`, `POST /api/images/:id/restore`, `GET /api/images/:id/{thumb,display,original,preview}`; variants are derived into `cache/<imageId>/` by `src/images/derive.ts`. Wire: `Note.images: NoteImage[]` built by `rowToNote`/`toNoteImage` (`src/notes/types.ts`); web mirror in `web/src/types.ts`.

### Reveal

`src/http/reveal.ts`: `GET /api/capabilities → {reveal}`; `POST /api/images/:imageId/reveal` (sameOriginOnly) → `locateImage` → `performReveal(target, reveal)` → `wslpath -w` → `explorer.exe /select,<winpath>` detached. Web: `RevealButton` (`web/src/components/RevealButton.tsx`) rendered per image; the card footer renders it for `note.images[0]` between the invisible-but-width-reserving `.copied` label and `.card-date` (`NoteCard.tsx:122-124`), which is why it reads as centered (`.card-meta` flex, `.card-date { margin-left:auto }`, `styles.css:94-100`).

### Embeddings (the model R5 mirrors)

`src/embeddings/*`: `Embedder` interface (`embed(string[])`), `createOpenRouterEmbedder` (POST `/api/v1/embeddings`, `EMBEDDING_MODEL='openai/text-embedding-3-small'`, `EMBEDDING_DIMENSIONS=1536`), `note_embeddings` side table (vector(1536), body_sha256, model, attempts, next_attempt_at; HNSW cosine), `repo.ts` (`listPending`, `saveEmbedding`, `recordFailure`, `nearestNotes`), `backfill.ts` (`runBackfill`, `RateLimiter`, `Clock`), `worker.ts` (event-kicked, debounced, 60 s sweep, bounded close), CLI `src/cli/embedBackfill.ts`. `background.ts` starts the worker only when `deps.embedder` is non-null (`OPENROUTER_API_KEY`).

### MCP

`src/mcp/server.ts` builds a fresh stateless server per POST `/mcp`: `registerNoteTools` (17 notes tools incl. image tools), `registerImageTools`, connectors. The chat agent's tool allowlist is `NOTES_TOOL_NAMES` + connector names (`src/chat/status.ts`), captions in `captionForToolUse`. Claude Code reaches the same endpoint as the `notes` MCP server (user scope, registered by `scripts/install.sh`), and the `/n` skill (`claude/skills/n/SKILL.md`) is linked into `~/.claude/skills/`.

---

## Key Data Structures

- `AppDeps` (`src/deps.ts`): `{config, db, events, service, embedder}`; constructed in `src/daemon.ts:74` and by test harnesses (`tests/integration/imageHarness.ts:41`, `tests/integration/helpers/api-harness.ts`).
- `ChatRequest`/`ChatTurn`/`ChatTurnEnd` (`src/chat/backend.ts`): `{message, threadId, signal}` → `{events, end()}` → `{threadId, brain}`.
- `Note` (`src/notes/types.ts:41`) / `NoteImage` (`:18`) and `web/src/types.ts`.
- `ToolDeps` (`src/mcp/tools.ts:10`): `{service, dataDir, db, connectors?, wallUrl?}`; the MCP server is built per request from it (`src/http/app.ts:41` `mcpToolDeps`).
- `View = 'wall' | 'bin'` (`web/src/types.ts`), `Mode`.

---

## Dependencies

- Env: `OPENROUTER_API_KEY` (embeddings; image embeddings reuse it), `LLM_*` (GLM fallback), `NOTESD_PORT`, `NOTES_DATA_DIR`, `NOTESD_EXPLORER_BIN`.
- Data dir subdirs created in `src/daemon.ts` `DATA_SUBDIRS` and `src/images/store.ts` `ensureDataDirs`.
- Services: Neon Postgres (pgvector), OpenRouter, Claude Agent SDK child process, `explorer.exe` via WSL interop.
- Test infra: Docker pgvector Postgres on 55433 (`scripts/test-int.sh`); `truncateAll` in `tests/integration/setup.ts` lists tables explicitly and must grow with each new table.
- Worktree needs `npm ci` and `ln -s ~/mcp-notes/.env.local .env.local` (see `scripts/install.sh` warning).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `chatSchema`, `POST /api/chat` | `src/http/api.ts:34,246` | def | http |
| `ChatBackend`, `ChatRequest`, `ChatTurnEnd` | `src/chat/backend.ts` | def | chat |
| `optionsFor … resume` | `src/chat/agent.ts:284-305` | call | chat |
| `buildChatSystemPrompt` | `src/chat/prompt.ts:12` | def | chat |
| `NOTES_TOOL_NAMES`, `allowedChatTools`, `captionForToolUse` | `src/chat/status.ts` | def/config | chat |
| `createStubChatBackend` | `src/chat/stub.ts` | impl | chat |
| `scripted-chat` helper | `tests/integration/helpers/scripted-chat.ts` | test | tests |
| `DATA_SUBDIRS`, `ensureDataDirs` | `src/daemon.ts:20,40`, `src/images/store.ts:25` | config | daemon/images |
| `AppDeps` literals | `src/daemon.ts:75`, `tests/integration/imageHarness.ts:41` | def/test | deps |
| `imageIdTaken`, `newId` | `src/notes/imageRepo.ts:133`, `service.ts:152` | def | notes |
| `rowToNote`, `toNotes`, `Note.images` | `src/notes/types.ts:224`, `service.ts:663` | def | notes |
| `purgeNote` file removal | `src/notes/service.ts:528-549` | call | notes |
| `performReveal`, `RevealTarget` | `src/http/reveal.ts:200-236` | def | http |
| `registerImageTools` | `src/mcp/imageTools.ts:93` | def | mcp |
| `describeNote`, `describeImage` | `src/mcp/imageTools.ts:55,60` | def | mcp |
| `startBackground` | `src/background.ts:19` | def | daemon |
| `Embedder`, `createOpenRouterEmbedder`, `embedderFromConfig` | `src/embeddings/{embedder,openrouter}.ts` | def | embeddings |
| `runBackfill`, `RateLimiter`, `Clock`, `retryDelayMs` | `src/embeddings/{backfill,state}.ts` | def | embeddings |
| `truncateAll` table list | `tests/integration/setup.ts` | test | tests |
| `DropOverlay` global paste | `web/src/components/DropOverlay.tsx:99-104` | def | web |
| `ChatBar` | `web/src/components/ChatBar.tsx` | def | web |
| `useChat` (`threadId` ref) | `web/src/hooks/useChat.ts:46` | def | web |
| `AnswerPanel` | `web/src/components/AnswerPanel.tsx` | def | web |
| `NoteEditor` strip, Esc handler | `web/src/components/NoteEditor.tsx:68-86,215-227` | def | web |
| `NoteCard` footer | `web/src/components/NoteCard.tsx:108-157` | def | web |
| `.card-meta`, `.copied`, `.card-date` | `web/src/styles.css:94-100` | css | web |
| `closeEditor`/`commit` empty-note rule | `web/src/App.tsx:138,181` | def | web |
| `Rail`/`Sidebar` bin button | `web/src/components/{Rail,Sidebar}.tsx` | def | web |
| `View` type | `web/src/types.ts` | def | web |
| `/n` skill text | `claude/skills/n/SKILL.md` | doc | claude |
| `SKILL_NAMES`, `register_mcp` | `scripts/install.sh:23,193` | config | scripts |
| `RESERVED_PREFIXES` (SPA fallback serves `/history`) | `src/http/static.ts:19` | config | http |

---

## Impact Points (files that WILL need changes)

Owner phase in brackets; the plan index maps phases to the requirement IDs.

1. `web/src/components/NoteCard.tsx`, `web/src/styles.css` — footer reveal position [P1]
2. new `web/src/components/Lightbox.tsx` (+css), `NoteEditor.tsx` strip [P2]
3. `web/src/components/{DropOverlay,ChatBar}.tsx`, `App.tsx`, `hooks/useChat.ts`, `api.ts`, `AnswerPanel.tsx`, `src/http/api.ts`, `src/chat/{backend,agent,stub}.ts`, new `src/chat/images.ts`, `src/http/chatImages.ts`, `src/db/schema.ts` + migration 0003, `src/deps.ts`, `src/daemon.ts` [P3]
4. `src/db/schema.ts` + migration 0004, new `src/notes/fileRepo.ts`, `src/files/*`, `src/notes/{service,types,imageRepo}.ts`, `src/http/{files,reveal,app}.ts`, `src/mcp/imageTools.ts` (`describeNote`), `src/images/store.ts`, `tests/integration/setup.ts` [P4]
5. `web/src/components/{NoteEditor,NoteCard,RevealButton,DropOverlay}.tsx`, new `FileChips`, `web/src/{api,types}.ts`, `App.tsx` empty-note rule [P5]
6. `src/embeddings/*` (image embedder, repo, worker, backfill), `src/db/schema.ts` + migration 0005, `src/background.ts`, `src/mcp/imageTools.ts` or new `similarTools.ts`, `src/chat/status.ts`, `src/mcp/instructions.ts`, `claude/skills/n/SKILL.md`, `package.json` script [P6]
7. `src/db/schema.ts` + migration 0006, new `src/chat/{service,context,repo,ids,citation}.ts`, `src/chat/{agent,backend,prompt}.ts`, `src/http/api.ts` (+ new `chatApi.ts`), `src/deps.ts`, `src/daemon.ts`, harnesses [P7]
8. new `claude/hooks/*`, `src/http/capture.ts`, `scripts/{install,uninstall}.sh`, `claude/skills/n/SKILL.md`, `src/mcp` (`pasted_image`) [P8]
9. new `web/src/pages/HistoryPage.tsx`, `components/{Bubble,...}`, `hooks/useHistory.ts`, `lib/chatTime.ts`, `App.tsx` (View `history`, URL sync), `Rail.tsx`, `Sidebar.tsx`, `AnswerPanel.tsx`, `types.ts` [P9]
10. `Bubble`, `HistoryPage`, `ChatBar` (reply chip), `api.ts` [P10]
11. `lib/links.ts` (note-id segments), `AnswerPanel.tsx`, `Bubble`, `NoteEditor.tsx` (show-on-wall button), `App.tsx` (open-in-place), `hooks/useDeepLink.ts` [P11]

**This document describes. The plan files prescribe.**
