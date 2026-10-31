# Package: mcp-notes

**Location**: `.` (repo root)
**Last Updated**: 2026-10-31 (after task P1-NOTES-A042)
**Documentation Created**: 2026-10-30T03:03Z (after task P1-NOTES-A000)

## Overview

`mcp-notes` is a local Node/TypeScript daemon (`notesd`) that keeps short notes and images in Postgres on Neon. It exposes them to Claude Code over MCP and to a React web UI on loopback. All 8 phases of `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` have landed. Phase 1 added config loading, the Drizzle schema and its one migration, the database client factory, note id generation, `#hashtag` parsing, and the unit and Docker-Postgres integration test harness. Phase 2 added the notes service (the only writer), the `notesd` daemon (Hono on 127.0.0.1) with `/health`, and a stateless MCP streamable-HTTP endpoint at `/mcp` exposing 11 note tools. Phase 3 added deployment: a systemd user unit for `notesd`, an idempotent `scripts/install.sh` (and `scripts/uninstall.sh`) that also registers the `notes` MCP server at user scope and links the `/n` Claude Code skill, and a Windows logon task that keeps WSL running. Phase 4 (P1-NOTES-A003) added the image store under `src/images/`: magic-byte probing, byte-exact storage, sha256 dedupe, lazy derivatives and the inbox watcher. Phase 5 (P1-NOTES-A004) added the image HTTP routes and upload, the MCP tools `create_image` and `view_images`, and the `has_image` and taken-date filters. Phase 6 (P1-NOTES-A005) added the UI JSON API under `/api` (notes CRUD, tags), a live `/api/events` SSE stream of note changes, a streamed `/api/chat` stub behind the `ChatBackend` interface, and static serving of the built SPA from `web/dist` with a 503 fallback when it is not built. Phase 7 (P1-NOTES-A006) added the web UI core in `web/`: a Vite + React + TypeScript SPA with the note wall, rail, sidebar, header, inline editing, the chat bar and answer panel, tooltips, live updates over SSE plus a 60 s refetch, and a text/images/all visibility mode. Phase 8 (P1-NOTES-A007) added images to the web UI: a justified gallery, a photo modal, a full-screen tab at `/full/<id>` (a second Vite entry, `fullscreen.html`), drag/drop and paste upload, and a "not on this machine" placeholder, by rewriting the four stub components phase 7 left in place. Iteration 4 (`docs/plans/CHAT_BAR_BRAIN_PLAN.md`) gives the chat bar a real brain. Its phase 1 (P1-NOTES-A008) widened the chat seam: backends yield `delta` and `status` events and report which brain answered, `Config` gained a `chat` block, and `startDaemon` takes the backend as an injectable option. Its phase 2 (P1-NOTES-A009) added the real brain under `src/chat/` (`agent.ts`, `env.ts`, `prompt.ts`, `status.ts`): each chat message is one Claude Agent SDK run on the owner's Claude Code login, restricted to the daemon's own `notes` MCP tools plus WebSearch/WebFetch, with threads mapped to SDK sessions, a turn cap, a wall-clock timeout, one run in flight, and a single retry on GLM when Claude fails on auth or a usage limit before any text. `startDaemon` now builds that backend by default. Its phase 3 (P1-NOTES-A010) taught the web answer panel to show the `status` caption while streaming and the brain label from `done.brain`, and made dismissing the panel start a new thread. Its phase 4 (P1-NOTES-A011) fitted the daemon for the brain: the systemd unit now sets `HOME` and `NOTESD_CLAUDE_BIN` (the resolved absolute `claude` path), `scripts/install.sh` warns on a missing Claude login or GLM keys and smoke-tests `/api/chat`, and `npm run test:live` runs an opt-in suite with one real Claude and one real GLM message. Iteration 5 (`docs/plans/CONNECTORS_PLAN.md`) lets the same `/mcp` server read three of the owner's other apps (expense-tracking, run-insights, Seer), strictly read-only. Its phase 1 (P1-NOTES-A012) added the connector core under `src/connectors/`: one stateless connector per system that re-reads the sibling repo's `.env.local` on every call, connects only to the direct (non-pooler) host with `default_transaction_read_only=on` and runs each query in `BEGIN READ ONLY` with a statement timeout and a row cap; Seer's `lab.sqlite` is read in a short-lived, killable child process. It registers six generic tools (`expenses_schema`/`expenses_sql`, `runs_schema`/`runs_sql`, `seer_schema`/`seer_sql`) behind a single-SELECT guard, appends a `Connectors.` paragraph to the MCP instructions, fixes all 15 connector tool names in `src/connectors/names.ts`, leaves no-op curated stubs for phases 2-4, and adds a second Docker container whose databases are built from the sibling repos' own migrations. Its phase 2 (P1-NOTES-A013) filled expense-tracking's curated tools: `expenses_spending` (one WIB day range broken down by category, day, ISO week and largest items), `expenses_get` (one expense group with items and photos) and `expenses_months` (zero-filled monthly totals), all integer rupiah, with the app's 17 categories copied as data. Its phase 3 (P1-NOTES-A014) filled run-insights' curated tools: `runs_list`, `runs_get` and `runs_review`, in the app's units with readable companions. Its phase 4 (P1-NOTES-A015) filled Seer's curated tools: `seer_leaderboard`, `seer_positions` and `seer_sera_best`. Its phase 5 (P1-NOTES-A016) opened the connectors to the chat bar and `/n`: the chat brain may call all 15 connector tools (captioned `reading expenses`/`reading runs`/`reading seer`), its system prompt names the three apps and asks for data answers with an opinion in the apps' units, and the `/n` skill routes spending, runs and Seer questions to those tools. Iteration 6 (`docs/plans/SEMANTIC_SEARCH_PLAN.md`) adds semantic search. Its phase 1 (P1-NOTES-A017) laid the storage only: migration `drizzle/0001_note_embeddings.sql` enables pgvector and adds the `note_embeddings` side table (one row per note, 1536-dim vector, HNSW cosine index, failure/backoff columns), and `src/embeddings/` gained the constants, the pure state rules (`bodySha256`, `embedInput`, `embeddingState`, `retryDelayMs`, `clampError`) and the repo (`listPending`, `saveEmbedding`, `recordFailure`, `embeddingStats`). The notes integration container is now `pgvector/pgvector:pg16`. Its phase 2 (P1-NOTES-A018) added the embedder seam: the `Embedder` interface and `EmbeddingError` in `src/embeddings/embedder.ts`, the OpenRouter client in `src/embeddings/openrouter.ts` (one `fetch` per batch of up to 64, 15 s timeout, strict response validation), `Config.embeddings` read from `OPENROUTER_API_KEY`, and an `embedder: Embedder | null` threaded through `startDaemon` options, `AppDeps` and `NotesService`. Tests get a deterministic offline `FakeEmbedder` (`tests/helpers/fakeEmbedder.ts`). Phase 2 alone called nothing. Its phase 3 (P1-NOTES-A019) made notes get embedded: `src/embeddings/backfill.ts` holds the shared drain loop (`runBackfill`: batches of 16, a per-note fallback when a batch call fails, a 1 s `RateLimiter` between calls, abort between batches), `src/embeddings/worker.ts` runs it inside `notesd` (started by `startBackground` when an embedder is configured, kicked by `created`/`updated` events with a 500 ms debounce, swept every 60 s, one log line per batch that did work), and `npm run embed:backfill` (`src/cli/embedBackfill.ts`) runs the same loop once with progress, `--retry-failed`, and Ctrl-C stopping after the current batch. Writes never wait on OpenRouter. Its phase 4 (P1-NOTES-A020) made `search` hybrid by default: `src/search/blend.ts` scores candidates by full-text rank, cosine similarity, tag match and recency (all weights in one `BLEND` object), `src/search/queryVector.ts` embeds the query once per (model, text) with a 5 s ceiling and an LRU cache, `repo.searchCandidates` unions full-text matches, nearest current vectors and notes named by id under the same filters, and the MCP `search` tool takes an optional `mode` (`hybrid` | `text`) and reports `mode` plus a `fallback` sentence when it had to answer with full text only. `tests/fixtures/semantic/labelled.ts` is the labelled evaluation set (16 notes, 10 queries) used to tune and check the blend. Its phase 5 (P1-NOTES-A021) added `related`: `embeddings.nearestNotes` walks the HNSW cosine index from one note's current vector, `NotesService.related` returns the live notes closest in meaning (never the note itself, a deleted note or a stale vector) and embeds an unembedded source on demand, the MCP `related` tool exposes it, the server instructions gained a `Related.` paragraph, and the chat bar may call it (captioned `finding related notes`). Its phase 6 (P1-NOTES-A022) checked it against the real model: `npm run test:live:embeddings` (`tests/live/embeddings.live.test.ts`) embeds the labelled set with one OpenRouter request, `BLEND.minSimilarity` was retuned from 0.3 to 0.22 on those numbers, and Neon was migrated (pgvector 0.8.6, `note_embeddings` with its HNSW index) and backfilled (12 embedded, 0 pending). Iteration 7 (wall editing) moves images to the `note_images` table so a note can hold several. Its phase 2 (P1-NOTES-A024) cut the server over: every read path returns `Note.images: NoteImage[]` (live images in position order, each with its own id and `urls`) instead of `Note.image`, a new image note is one note row plus its first image row (image id = note id, position 0) in one transaction, dedupe matches a live image with the same sha256, derivatives live in `cache/<imageId>/`, `has_image` and the taken-date filters match when any live image matches, images are served by image id at `/api/images/:imageId[/variant]` with `/api/notes/:id/:variant` kept as an alias for the first live image of a live note, `view_images` accepts note ids or image ids and returns at most 8 images per call with an overflow line, `src/http/sameOrigin.ts` adds the `sameOriginOnly` guard (for phases 4 and 5), and `startBackground` runs `reconcileLegacyImages` once at startup. Its phase 6 (P1-NOTES-A028) moved the web UI onto `images[]`: a wall card shows its first image as the cover with a count badge when there are several, the gallery shows one tile per image, the photo modal steps image by image within a note and then across notes with a `k/n` indicator, and the full-screen tab is addressed by image id. Its phase 10 (P1-NOTES-A032) was docs and rollout only, with no source change: `README.md`, the `/n` skill and `docs/INSTALL.md` (new section 7: migration 0002, Show in Explorer, recycle bin) describe several images per note, and Neon was migrated with 0002 (`note_images` created, 4 legacy images copied). Iteration 8 (`docs/plans/CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`) adds chat history, note files and image similarity search. Its phase 3 (P1-NOTES-A036) added a separate chat image store: migration `drizzle/0003_chat_images.sql` creates `chat_images` (sha256-unique, no soft delete, its own id space, never a note), `src/chat/images.ts` ingests and locates them (originals under `<dataDir>/chat-images/YYYY/MM/`, derivatives under `cache/c_<id>/`), `src/http/chatImages.ts` serves `POST /api/chat/images` and `GET /api/chat/images/:id[/variant]`, `POST /api/chat` accepts up to four `image_ids` (and a message may be images alone), and the agent backend sends each image's `preview` as an SDK base64 image block before the text, named `[image upload:ID]` (`src/chat/compose.ts`). In the web UI an image pasted while the chat bar has focus uploads to that store and shows as a removable thumbnail in the bar (`useChatImages`), the answer panel shows the sent images, and the document-level paste handler leaves the chat bar alone. Its phase 4 (P1-NOTES-A037) added the note files backend: migration `drizzle/0004_note_files.sql` creates `note_files` (non-image files of a note, soft-removable, sha256-unique among live rows, ids in the shared note/image id space, `extracted_text` / `extraction_status` reserved for a later extraction), `src/files/` stores them byte-exact under `<dataDir>/files/<noteId>/<safeName>` (Windows-safe names, `name (2).ext` on a clash, sha256 dedupe, magic-bytes-then-extension mime), `NotesService` gained `attachFile` / `removeFile` / `restoreFile`, every wire `Note` carries `files: NoteFile[]`, `src/http/files.ts` serves `POST /api/notes/:id/files` (sniffed images still go to the image store), `DELETE /api/files/:id`, `POST /api/files/:id/restore`, `GET /api/files/:id` and `GET /api/files/:id/download` (always an attachment), `reveal.ts` adds `POST /api/files/:id/reveal` and a note-level `POST /api/notes/:id/reveal` (opens the note's files folder, else selects its first image), `purgeNote` also removes the note's files and folder, and MCP note JSON, `describeNote` / `describeImage`, the server instructions (`Files.` paragraph) and the chat prompt expose files read-only (no MCP tool attaches, removes or opens them). Its phase 6 (P1-NOTES-A039) added image similarity search: an `ImageEmbedder` seam (`src/embeddings/imageEmbedder.ts`) with a Gemini Embedding 2 client over OpenRouter (`google/gemini-embedding-2`, `src/embeddings/openrouterImage.ts`, one request per image or text query, a 1536-wide L2-renormalised Matryoshka prefix), migration `drizzle/0005_note_image_embeddings.sql` (`note_image_embeddings`, one row per note image keyed by image sha256 and model, HNSW cosine index, failure backoff), the repo (`src/embeddings/imageRepo.ts`), a per-image drain loop and `notesd` worker (`imageBackfill.ts`, `imageWorker.ts`; images whose original is on the other laptop are skipped, not failed), `npm run embed:images:backfill` (`--dry-run` cost estimate, `--limit N`, `--retry-failed`), and the read-only MCP tool `similar_images` (`src/mcp/similarTools.ts`: exactly one of `image_id`, `upload_id` (a wall-chat upload, embedded on the fly and never stored), `query` (words in the same vector space) or `pasted_image` (reserved for the phase 8 paste hook; answers with a how-to today), plus `limit`). The server instructions gained a `Similar images.` paragraph, the chat brain may call `similar_images` (captioned `finding similar photos`) and its prompt says to use it on `[image upload:ID]`, and `npm run test:live:imageEmbeddings` runs a few real, billed Gemini calls. Its phase 7 (P1-NOTES-A040) made chat history ours: migration `drizzle/0006_chat_history.sql` adds `chat_threads`, `chat_messages` (4-character ids such as `K7F2`, shown as `[msg:K7F2]`; `reply_to`; soft delete), `chat_message_revisions` and `chat_message_attachments`, and `ChatService` (`src/chat/service.ts`, the only writer, on `AppDeps.chat`) adds, edits (user rows only, old text kept as a revision), soft-deletes (optionally with the answer), restores, pages a unified timeline, and records captured exchanges idempotently (`recordExchange`, for phase 8), emitting `ChatEvents` after commit. The Agent SDK run is now stateless (`persistSession: false`, no `resume`): `src/chat/context.ts` rebuilds every turn from our rows into `<chat_history>` / `<reply_to>` / `<message>` blocks of `[msg:ID] role (YYYY-MM-DD HH:mm WIB): text` lines under a 24k-character budget, `src/chat/turn.ts` adds the current and reply-target images, and the backend contract became `ChatRequest { turn, signal }`. `POST /api/chat` takes `reply_to`, writes the user row first and sends `event: accepted`, strips a leading `[msg:ID]` from the streamed answer into the answer's `reply_to` (`src/chat/citation.ts`), writes the assistant row only on a clean finish, and `done` carries `user_message_id`, `assistant_message_id` and `reply_to`. `src/http/chatApi.ts` adds `GET /api/chat/messages` (timeline), `GET /api/chat/threads/:id`, and same-origin `PATCH` / `DELETE /api/chat/messages/:id` plus `POST .../restore`; `/api/events` also sends `event: chat {op, thread_id, id}`. Its phase 8 (P1-NOTES-A041) captures Claude Code: `claude/hooks/notes-capture.mjs`, an async `Stop` hook, reads the session transcript after every turn and, when the turn's prompt was `/n ...`, spools `{prompt as typed, final answer, timestamps, cwd, pasted images}` to `~/.local/state/notes-capture/outbox/<user uuid>.json` and POSTs it to the new `POST /api/capture/claude-code` (`src/http/capture.ts`: loopback host, no or loopback Origin, `X-Notes-Capture: 1`, JSON only), which stores pasted images in the chat image store and calls `ChatService.recordExchange` (`src/chat/capture.ts`) to write one single-turn `claude_code` thread, idempotent on `<claude_session>:<user_uuid>`; undelivered payloads are retried by later hook runs. `claude/hooks/notes-paste.mjs`, a `PreToolUse` hook on `mcp__notes__similar_images`, finds `[Image #N]` in the latest image-carrying prompt, uploads it to `POST /api/chat/images` (`source=claude_code`) and rewrites `pasted_image: N` into `upload_id` (`updatedInput`, or a `deny` fallback strategy). `scripts/install.sh` merges both hooks into `~/.claude/settings.json` through `scripts/claude-hooks.mjs` (`--skip-hooks` / `NOTES_SKIP_HOOKS=1`, `NOTES_PASTE_STRATEGY`), `scripts/uninstall.sh` removes them, `npm run verify:paste-hook` is an opt-in live check that Claude Code honours the rewrite, `PASTED_IMAGE_NEEDS_HOOK` now explains an unresolved paste, and the `/n` skill describes pasted images and the chat history capture.

**Key Responsibilities:**
- Resolve runtime config (`DATABASE_URL`, port, loopback host, data dir, chat brain settings) from `.env.local` plus the environment
- Own the whole schema: `notes`, `note_revisions` (migration `drizzle/0000_init.sql`, iterations 1-3) and `note_embeddings` plus the pgvector extension (migration `drizzle/0001_note_embeddings.sql`, iteration 6) and `note_images` (migration `drizzle/0002_note_images.sql`, iteration 7 phase 1) and `chat_images` (migration `drizzle/0003_chat_images.sql`, iteration 8 phase 3) and `note_files` (migration `drizzle/0004_note_files.sql`, iteration 8 phase 4) and `note_image_embeddings` (migration `drizzle/0005_note_image_embeddings.sql`, iteration 8 phase 6) and `chat_threads` / `chat_messages` / `chat_message_revisions` / `chat_message_attachments` (migration `drizzle/0006_chat_history.sql`, iteration 8 phase 7)
- Keep the chat history in Postgres (threads, messages with short `[msg:ID]` ids, edit revisions, attachments by reference, soft delete), rebuild each chat turn's context from those rows instead of an SDK session, and serve a unified timeline plus edit/delete/restore over `/api/chat/...` (iteration 8 phase 7)
- Capture every Claude Code `/n` exchange (prompt, final answer, pasted images) into the chat history as a `claude_code` thread through a `Stop` hook with an on-disk outbox, and let `/n` search by a pasted image through a `PreToolUse` hook that uploads it and turns `pasted_image` into `upload_id` (iteration 8 phase 8)
- Track one image embedding per note image (Gemini Embedding 2, a vector space separate from the note text one) keyed by image sha256 and model, filled by the `notesd` image worker and `npm run embed:images:backfill`, and answer `similar_images` by picture, chat upload or words (iteration 8 phase 6)
- Track one embedding per note keyed by body hash and model, with failure backoff, ready for semantic search (iteration 6; the `notesd` embedding worker and `npm run embed:backfill` keep it filled)
- Build one Drizzle type over two drivers: Neon websocket pool in production, `pg` for the Docker test database
- Generate and normalise short note ids (`A-B32`)
- Parse `#hashtags` from note bodies into the `tags` column (pure module, shareable with the web app)
- Create, read, update, append, soft-delete, restore and revert notes atomically, keeping every prior body as a revision in the same transaction
- List and search notes with tag, date, image and deleted filters plus offset cursors; search is hybrid (words + meaning + tags + recency) by default, with full-text `mode: "text"` and an automatic full-text fallback (iteration 6 phase 4)
- Find the notes closest in meaning to one note (`related`, iteration 6 phase 5)
- Serve the notes to Claude Code as MCP tools over loopback HTTP, and emit in-process change events
- Serve note images over HTTP by image id (upload, metadata, original, display, thumb, preview; note-id alias kept) and to Claude through `create_image` / `view_images` (phase 5; per-image since iteration 7 phase 2)
- Serve the web UI a JSON API, an SSE change feed, a streamed chat endpoint (a Claude Agent SDK run over the notes MCP tools, GLM fallback) and the built SPA
- Store images pasted into the chat bar in their own sha256-deduped `chat_images` store (never notes), serve them over `/api/chat/images`, and send up to four with a chat message to the agent as image blocks (iteration 8 phase 3)
- Store non-image files on a note under `files/<noteId>/` (sha256-deduped, soft remove/restore, purge with the note), list them on every wire note, and serve them over `/api/files` as download-only attachments with Show in Explorer (iteration 8 phase 4)
- Ship the web UI itself (`web/`, built to `web/dist` by Vite): a live note wall with inline editing, tag filters, visibility modes, a chat panel, a photo gallery and modal, a full-screen image tab and image upload, and a chat history page at `/history[?thread=ID]` showing every wall chat and `/n` exchange as one live timeline (iteration 8 phase 9)
- Run `notesd` as an always-on systemd user service in WSL, registered with Claude Code as the `notes` MCP server and driven by the `/n` skill
- Expose the owner's expense-tracking, run-insights and Seer databases (plus Seer's `lab.sqlite`) over MCP as read-only `<system>_schema` / `<system>_sql` tools, with fail-soft, secret-free errors (iteration 5)

## Layout

```
src/config.ts          loadConfig, ConfigError, REPO_ROOT, defaults
src/db/schema.ts       Drizzle tables notes, note_images, note_files, note_revisions, note_embeddings, note_image_embeddings, chat_images, chat_threads, chat_messages, chat_message_revisions, chat_message_attachments; ImageMeta, NoteOrigin, ChatImageSource, EXTRACTION_STATUSES/ExtractionStatus, CHAT_SOURCES/CHAT_ROLES/CHAT_ATTACHMENT_KINDS; row types
src/embeddings/constants.ts  EMBEDDING_MODEL, EMBEDDING_DIMENSIONS (1536), EMBEDDING_MAX_CHARS, OPENROUTER_EMBEDDINGS_URL
src/embeddings/state.ts      pure: bodySha256, embedInput, embeddingState, retryDelayMs, clampError
src/embeddings/repo.ts       note_embeddings queries: listPending, saveEmbedding, recordFailure, embeddingStats, nearestNotes, SQL fragments
src/embeddings/embedder.ts   Embedder interface, EmbedOptions, EmbeddingError, embeddingErrorText
src/embeddings/openrouter.ts createOpenRouterEmbedder (fetch, batching, validation), embedderFromConfig, postOpenRouterEmbeddings (shared POST), snippet, errorName
src/embeddings/backfill.ts   runBackfill drain loop, RateLimiter, Clock/realClock, EmbeddingStore + dbEmbeddingStore
src/embeddings/worker.ts     startEmbeddingWorker (events + 60 s sweep around runBackfill), formatBatch
src/cli/embedBackfill.ts     `npm run embed:backfill`: one-shot backfill with progress, --retry-failed, Ctrl-C resumes later
src/embeddings/imageConstants.ts  (iteration 8 phase 6) IMAGE_EMBEDDING_MODEL (google/gemini-embedding-2), IMAGE_EMBEDDING_DIMENSIONS (1536), IMAGE_EMBED_LONG_EDGE, prices, estimateImageTokens/estimateImageCostUsd
src/embeddings/imageEmbedder.ts   ImageEmbedder interface (embedImage(png), embedText(query))
src/embeddings/openrouterImage.ts createOpenRouterImageEmbedder, imageEmbedderFromConfig, request bodies, fitVector, isPng, MAX_EMBED_PNG_BYTES
src/embeddings/imageInput.ts      toEmbeddingPng (rotate, <= 1024 px, flatten, PNG), notePngForEmbedding (from the preview derivative)
src/embeddings/imageRepo.ts       note_image_embeddings queries: listPendingImages, saveImageEmbedding, recordImageFailure, imageEmbeddingStats, nearestImages
src/embeddings/imageBackfill.ts   runImageBackfill per-image drain loop, ImageEmbeddingStore + dbImageEmbeddingStore, UnavailableImages memo
src/embeddings/imageWorker.ts     startImageEmbeddingWorker (events + sweep around runImageBackfill), formatImageDrain
src/embeddings/chatUploads.ts     ChatUploadSource / dbChatUploadSource: chat upload id -> stored original (for similar_images upload_id)
src/cli/embedImagesBackfill.ts    `npm run embed:images:backfill`: --dry-run (count + token/cost estimate), --limit N, --retry-failed
src/search/blend.ts          pure: BLEND weights, queryTerms, tagMatch, recencyScore, similarityScore, blendScore, isEligible, rankCandidates
src/search/queryVector.ts    QueryVectorCache (LRU), embedQuery (5 s ceiling), SEMANTIC_OFF_FALLBACK, embedFailedFallback
src/db/client.ts       createDb / closeDb / isNeonUrl; Db type; re-exports schema
src/notes/ids.ts       generateId, normalizeId, parseId, isValidId, InvalidIdError
src/notes/tags.ts      parseTags, tagSpans, normalizeTag
src/notes/types.ts     wire Note/NoteImage/Revision/TagCount/NotePage/SearchPage, SearchMode, RelatedNote/RelatedResult, Bin/BinImage/PurgeResult, NoteFile/FileMeta, NoteError, DuplicateImageError, DuplicateFileError, rowToNote, toNoteImage, toNoteFile, imageUrls, fileUrls, cleanOrigin
src/notes/dates.ts     parseDateBound (YYYY-MM-DD local day or ISO datetime)
src/notes/events.ts    NoteEvents in-process bus (created/updated/deleted/restored/purged)
src/notes/repo.ts      Drizzle queries: NoteFilter, list/search/searchCandidates/insert/lock/touchNote/revisions/tags, cursors
src/notes/service.ts   NotesService, the only writer of notes (+ attachImage/removeImage/restoreImage, iteration 7 phase 3; listBin/purgeNote/purgeImage, phase 4; attachFile/removeFile/restoreFile, iteration 8 phase 4)
src/notes/imageRepo.ts note_images queries: imagesForNotes, findImageById, findLiveImageBySha256, insertImage, nextPosition, imageIdTaken (notes + images + files), setImageDeleted, isLiveShaClash, pgErrorInfo
src/notes/fileRepo.ts  note_files queries (iteration 8 phase 4): filesForNotes, findFileById, findLiveFileBySha256, filePathTaken, insertFile, nextFilePosition, setFileDeleted, isLiveFileShaClash, isFilePathClash
src/notes/binRepo.ts   recycle-bin queries (iteration 7 phase 4): listDeletedNoteIds, listBinImages, lockImageRow, deleteNoteRow, deleteImageRow, clearLegacyImage
src/mcp/instructions.ts buildInstructions(timeZone): MCP server instructions text (+ Attaching and Connectors paragraphs)
src/mcp/tools.ts       registerNoteTools (12 tools, `related` since iteration 6 phase 5), noteFilterShape (+ has_image, taken_from/to), toFilter, ToolDeps (+ connectors?), run/jsonResult (compact), IMAGE_FILTER_HINT
src/mcp/imageTools.ts  registerImageTools: create_image, view_images, attach_image, remove_image, restore_image; describeImage, describeNote, filesLine (iteration 8 phase 4), VIEW_IMAGES_MAX
src/mcp/similarTools.ts registerSimilarTools: similar_images (iteration 8 phase 6); countSources, bodySnippet, IMAGE_SEARCH_OFF, PASTED_IMAGE_NEEDS_HOOK
src/mcp/server.ts      createMcpServer (notes, image, similar and connector tools), handleMcpRequest (stateless, JSON responses)
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
src/connectors/{expenses,runs,seer}/curated.ts  register<Id>Curated (3 curated tools per system: expenses phase 2, runs phase 3, seer phase 4)
src/connectors/expenses/categories.ts  EXPENSE_CATEGORIES (17 slugs), EXPENSE_CATEGORY_LABELS, EATING_CATEGORIES, toExpenseCategory, categoryLabel
src/connectors/expenses/dates.ts       pure WIB calendar helpers: DATE_RE/MONTH_RE, addDays, daysInclusive, isoWeekMonday/Key, todayWib, addMonths
src/connectors/expenses/queries.ts     curated SQL, row builders, fetchSpending / fetchGroup / fetchMonths, limits
src/connectors/runs/curated.ts   registerRunsCurated: runs_list, runs_get, runs_review (+ runsList/runsGet/runsReview)
src/connectors/runs/queries.ts   curated SQL (/* runs:* */), row shapers (runMetrics, periodTotals, splitOut, zonesOut, insightOut), read helpers
src/connectors/runs/periods.ts   WIB days, ISO week / month keys: resolvePeriod, resolveRange, isRealDate, todayInWib
src/connectors/runs/format.ts    unit helpers: metresToKm, formatDuration ("h:mm:ss"), formatPace ("m:ss /km"), hrDrop1Min, percentOf
src/http/app.ts        createApp: /health, /mcp (+ loopbackOnly guard), mounts the routers below
src/http/api.ts        apiRoutes: /api/notes CRUD, /api/tags, /api/events (SSE: note + chat events), /api/chat (SSE, + image_ids since iteration 8 phase 3; persisted + reply_to + accepted since phase 7); readJson, describeIssues exported
src/http/chatApi.ts    chatHistoryRoutes (iteration 8 phase 7): GET /api/chat/messages, GET /api/chat/threads/:id, PATCH/DELETE /api/chat/messages/:id, POST /api/chat/messages/:id/restore; chatErrorResponse
src/http/chatImages.ts chatImageRoutes (iteration 8 phase 3): POST /api/chat/images, GET /api/chat/images/:id[/{original,display,thumb,preview}]
src/http/files.ts      fileRoutes (iteration 8 phase 4): POST /api/notes/:id/files, DELETE /api/files/:id, POST /api/files/:id/restore, GET /api/files/:id[/download]; attachmentDisposition, DOWNLOAD_CSP
src/http/reveal.ts     revealRoutes: GET /api/capabilities, POST /api/{images/:imageId,files/:fileId,notes/:id}/reveal (sameOriginOnly); performReveal, noteRevealPlan, explorerArgs(mode), RevealMode
src/http/capture.ts    captureRoutes (iteration 8 phase 8): POST /api/capture/claude-code behind captureGuard (loopback + X-Notes-Capture: 1 + JSON); decodeImageBase64, limits
src/http/static.ts     staticRoutes: web/dist SPA, /assets, /full/:id, 503 when not built
src/http/images.ts     imageRoutes: POST /api/images, POST /api/notes/:id/images, DELETE /api/images/:imageId, POST /api/images/:imageId/restore, GET /api/images/:imageId[/{original,display,thumb,preview}], alias GET /api/notes/:id/{variant}
src/http/imageAccess.ts shared HTTP/MCP image glue: resolveImageFile (image id), resolveNoteImageFile (note alias), ingestFromUpload/Path, attachFromUpload/Path, toolImageDeps/toolAttachDeps, ImageInputError, etagMatches
src/http/sameOrigin.ts sameOriginOnly guard (403 forbidden_origin), isSameOrigin, isLoopbackUrl
src/chat/backend.ts    ChatBackend, ChatRequest { turn, signal } (phase 7), ComposedTurn, ChatTurnImage (+ messageId), ChatTurn, ChatEvent, ChatTurnEnd { brain? }, ChatBrain (the chat brain seam)
src/chat/stub.ts       createStubChatBackend, STUB_REPLY, splitIntoDeltas
src/chat/agent.ts      createAgentChatBackend (the real brain: stateless Agent SDK run per message, persistSession false, GLM fallback, guardrails; images as image blocks)
src/chat/images.ts     chat image store (iteration 8 phase 3): ingestChatImage, locateChatImage, resolveTurnImages, ChatImage wire shape, errors, limits
src/chat/compose.ts    pure: uploadTag, imageLabel, composePromptText, composeLabelledText (phase 7), composeUserTurn, userTurnContent, toSdkPrompt (iteration 8 phase 3)
src/chat/ids.ts        (iteration 8 phase 7) MESSAGE_ID_PATTERN, generateMessageId, isMessageId, normalizeMessageId, messageLabel ('[msg:K7F2]')
src/chat/types.ts      wire ChatMessageView/ChatThreadView/ChatThreadDetail/ChatTimelinePage/ChatReplyPreview/ChatAttachmentView, AttachmentRef, ChatError(+codes), snippet, attachmentView, toThreadView, toMessageView
src/chat/events.ts     ChatEvents in-process bus (created/updated/deleted/restored), ChatChange, ChatOp
src/chat/repo.ts       chat table queries: threads, messages, revisions, attachments, nextMessageInThread, listTimelineRows, timeline cursor encode/decode
src/chat/service.ts    ChatService, the only writer of the chat tables: addUserMessage, addAssistantMessage, editMessage, deleteMessage, restoreMessage, listTimeline, getThread, getMessage, listRevisions, loadTurnContext, recordExchange
src/chat/context.ts    pure: buildTurnContext, renderMessageLine, attachmentLabel, formatWib; CONTEXT_CHAR_BUDGET, CONTEXT_LINE_CHAR_CAP, OMITTED_LINE, CHAT_TIME_ZONE
src/chat/turn.ts       composeWallTurn: our rows -> context text + current/reply-target images (ComposedTurn)
src/chat/citation.ts   parseLeadingCitation, CitationFilter (streaming strip of a leading [msg:ID]), CITATION_LOOKAHEAD
src/chat/capture.ts    (iteration 8 phase 8) captureClaudeCodeExchange: pasted images -> chat image store, then ChatService.recordExchange; captureExternalKey, CaptureImageError, CAPTURE_SOURCE, MAX_CAPTURED_IMAGE_BYTES
src/chat/env.ts        claudeEnv, glmEnv, resolveExecutable, STRIPPED_ENV_KEYS/PREFIX, CLIENT_APP
src/chat/prompt.ts     buildChatSystemPrompt (date/time/tz, id quoting, the three apps, data answers, plain prose, turn layout + [msg:ID] replies since phase 7)
src/chat/status.ts     allowedChatTools (notes + connector + web), captionForToolUse, NOTES_TOOL_NAMES, WEB_TOOL_NAMES, CONNECTOR_CAPTIONS
src/deps.ts            AppDeps { config, db, events, service, embedder, imageEmbedder, chat: ChatService }
src/daemon.ts          startDaemon (+ StartDaemonOptions.chat), ensureDataDirs, DATA_SUBDIRS (+ chat-images, files), CHAT_SUBDIR
src/background.ts      startBackground: ensures data dirs, runs reconcileLegacyImages once, starts the inbox watcher and (with an embedder) the embedding worker, and (with an image embedder) the image embedding worker
src/images/probe.ts    magic-byte sniff, probeImage (mime, oriented size, EXIF taken_at), sha256Hex, HEIC decode
src/images/store.ts    data-dir paths (+ chat-images/), images/YYYY/MM/<id>.<ext>, atomic write/copy/move (EXDEV-safe), removeImageFiles (purge)
src/images/derive.ts   lazy cache/<imageId>/{thumb.webp,preview.jpg,display.jpg}
src/images/records.ts  ImageRecords: raw read-only note_images lookups (bySha256Live, byImageId, firstLiveImageOfNote), imageMetaOf
src/images/ingest.ts   ingestImage (dedupe by live sha256, store, create note + first image), attachImage (add one image to a live note), locateImage (image id), locateNoteImage, imageDeps, attachDeps
src/images/inbox.ts    startInboxWatcher (chokidar on <dataDir>/inbox, failures to inbox/failed/)
src/images/legacy.ts   LEGACY_COPY_SQL, reconcileLegacyImages: copy notes.image_path/image_meta into note_images (idempotent)
src/files/name.ts      pure (iteration 8 phase 4): sanitizeFileName (Windows-safe stored name), displayFileName, withNameSuffix, isSafeFileName, length caps
src/files/mime.ts      detectFileMime (magic bytes, then EXTENSION_MIMES, else FALLBACK_MIME), isValidMime
src/files/store.ts     FILES_SUBDIR, fileRelPath, isNoteFileRelPath, filesDirFor, removeNoteFile, removeNoteFolderIfEmpty
src/files/records.ts   FileRecords: raw read-only note_files lookups (bySha256Live, byFileId, pathTaken), dbFileRecords
src/files/ingest.ts    attachFile (dedupe under a sha lock, place bytes, NotesService.attachFile), attachUpload (sniffed images -> attachImage), locateFile, fileDeps/uploadDeps, FileInputError, MAX_FILE_BYTES
src/main.ts            notesd entry: loadConfig, startDaemon, SIGINT/SIGTERM shutdown
drizzle/               0000_init.sql, 0001_note_embeddings.sql, 0002_note_images.sql, 0003_chat_images.sql, 0004_note_files.sql, 0005_note_image_embeddings.sql, 0006_chat_history.sql + meta/ (generated by drizzle-kit; do not hand-edit, except 0001's prepended CREATE EXTENSION and 0002's appended legacy-copy INSERT)
drizzle.config.ts      drizzle-kit config, picks the DIRECT (unpooled) Neon URL
scripts/test-int.sh    starts/reuses Docker containers mcp-notes-pg-test (55433) and mcp-notes-pg-connectors (55435), both pgvector/pgvector:pg16 (recreated if on another image), runs integration suite
scripts/install.sh     idempotent WSL install: deps, build, systemd user unit, linger, MCP registration, /n skill link, Claude Code hooks in ~/.claude/settings.json (--skip-hooks)
scripts/uninstall.sh   removes the unit, the MCP registration, the skill link and our two hook entries (keeps data dir, linger, hook outbox/logs, settings backup); sourceable (main runs only when executed)
scripts/claude-hooks.mjs  (iteration 8 phase 8) install | uninstall | status of the two mcp-notes hooks in a settings.json: mergeHooks, removeHooks, ourGroups, isOurHandler, atomic writeSettings, one-time .bak-notes-hooks backup (+ .d.mts types)
scripts/verify-paste-hook.mjs  `npm run verify:paste-hook`: opt-in live check that Claude Code honours the paste hook's rewrite (one headless claude -p run against a running notesd)
claude/hooks/notes-capture.mjs  Stop hook (async): /n turn -> outbox spool -> POST /api/capture/claude-code, drains older outbox files first (+ .d.mts)
claude/hooks/notes-paste.mjs    PreToolUse hook on mcp__notes__similar_images: pasted_image N -> POST /api/chat/images -> upload_id (updatedInput | deny strategy) (+ .d.mts)
claude/hooks/lib/transcript.mjs pure Claude Code 2.1.x JSONL transcript readers: parseTranscript, isHumanPrompt, promptText, isNotesPrompt, extractImages, findTurn, findLatestImagePrompt, pickPastedImage
claude/hooks/lib/state.mjs      daemonBaseUrl (127.0.0.1:NOTESD_PORT|7317), stateDir (${XDG_STATE_HOME:-~/.local/state}/notes-capture), writeLog (1 MB rotation), readStdin, isMainModule
scripts/windows/install-wsl-keepalive.ps1  Task Scheduler logon task keeping the WSL distro up (-Uninstall removes it)
deploy/notesd.service  systemd user unit template (@NODE_BIN@ @NODE_DIR@ @REPO_DIR@ @DATA_DIR@ @CLAUDE_BIN@ @HOME_DIR@), rendered by install.sh
claude/skills/n/SKILL.md  the /n Claude Code skill, symlinked to ~/.claude/skills/n
docs/INSTALL.md        install, WSL keepalive rationale, post-merge re-install, iteration 7 migration 0002 + Show in Explorer + recycle bin (section 7), uninstall, troubleshooting
tests/unit/            vitest unit tests (node); hooks/ (transcript, notesCapture, notesPaste + fixtures.ts), scripts/ (claudeHooks) since iteration 8 phase 8
tests/integration/     *.int.test.ts, setup.ts helpers, globalSetup.ts (migrates once)
tests/integration/connectors/  connector harness (harness.ts, siblings.ts), globalSetup.ts (builds connectors_<id> DBs), core/generic/mcp int tests, runs.curated.int.test.ts
tests/live/            chat.live.test.ts (npm run test:live), connectors.live.test.ts (npm run test:live:connectors), embeddings.live.test.ts (npm run test:live:embeddings), imageEmbeddings.live.test.ts (npm run test:live:imageEmbeddings)
vitest.config.ts       the only vitest config; switches mode on VITEST_INTEGRATION=1, CHAT_LIVE_TEST=1, CONNECTORS_LIVE_TEST=1, EMBEDDINGS_LIVE_TEST=1 or IMAGE_EMBEDDINGS_LIVE_TEST=1
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
- `DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig`: `{ apiKey: null }`, what `loadConfig` returns without `OPENROUTER_API_KEY`. Tests that build `Config` literals use it too.

#### Config
```ts
interface Config {
  databaseUrl: string          // runtime URL; pooled Neon host in production
  port: number                 // NOTESD_PORT, default 7317; 0 = any free port (tests)
  host: '127.0.0.1'            // always loopback, the daemon has no auth
  dataDir: string              // absolute; NOTES_DATA_DIR, default ~/mcp-notes-data; not created here
  chat: ChatConfig             // the chat bar brain (POST /api/chat)
  embeddings: EmbeddingsConfig // note embeddings via OpenRouter (iteration 6)
}
interface EmbeddingsConfig {
  apiKey: string | null        // OPENROUTER_API_KEY, trimmed; null when unset or blank = semantic features off; never logged
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

Throws `ConfigError` when no database URL is set, on a non-integer or >65535 port, when `NOTESD_HOST` is anything but empty or `127.0.0.1`, when `CHAT_BRAIN` is not `claude`/`glm`, when `CHAT_MAX_TURNS`/`CHAT_TIMEOUT_MS` is not a positive integer, or when `CHAT_BRAIN=glm` and any `LLM_*` key is missing (the message names the missing keys). With `CHAT_BRAIN=claude` and incomplete `LLM_*`, `glm` is null and Claude runs have no fallback. `OPENROUTER_API_KEY` fills `embeddings.apiKey` (unset or blank gives null and never throws; note writes are unaffected). Other unknown keys are ignored. Synchronous file read; no other side effects.

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
| `image_path` | text | legacy (iterations 2-6, one image per note): relative to data dir `images/YYYY/MM/<id>.<ext>`; since iteration 7 read only by the reconcile, to be dropped in a later migration |
| `image_meta` | jsonb `ImageMeta` | legacy, written by image ingest from iteration 2 until iteration 7 phase 2 (no longer written); same status as `image_path` |
| `origin` | jsonb `NoteOrigin` | `cwd`, `repo`, `claude_session`, `source` (`mcp`/`web`/`inbox`/`upload`) |
| `created_at`, `updated_at` | timestamptz not null default now() | |
| `deleted_at` | timestamptz | soft delete; null = live |

Indexes: GIN on `tags`; GIN on `to_tsvector('simple', body)`; btree on `created_at`, `updated_at`; unique on `image_meta->>'sha256'` where image_meta is not null and the note is live; btree on `image_meta->>'taken_at'`. The two `image_meta` indexes are legacy and go with the columns.

#### note_images (iteration 7 phase 1, migration 0002)
One row per image; a note holds zero or more, in attach order. Images move here from `notes.image_path` / `image_meta`. Since phase 2 (P1-NOTES-A024) every server read and write of images uses this table; only `src/images/legacy.ts` still reads the legacy columns. Since phase 6 the web UI reads `images[]` too. Neon has had 0002 applied since phase 10 (4 legacy images copied).

| column | type | notes |
|---|---|---|
| `id` | text PK | note-id format `A-B32`. The first image of a note created with an image shares the note's id (so `cache/<noteId>/`, `/full/<noteId>` and `/api/notes/<noteId>/<variant>` stay valid for legacy images); later images get an id free in both `notes.id` and `note_images.id` (`imageIdTaken`) |
| `note_id` | text not null, FK `notes.id` on delete cascade | |
| `path` | text not null | relative to data dir: `images/YYYY/MM/<id>.<ext>` |
| `sha256` | text not null | lower-case hex of the original bytes |
| `mime`, `width`, `height`, `bytes` | text / integer not null | `bytes` fits int4 under the 200 MB upload cap |
| `taken_at` | timestamptz | EXIF DateTimeOriginal |
| `original_name`, `host` | text | `host` = `os.hostname()` of the machine holding the file |
| `position` | integer not null | attach order; never renumbered (remove + restore keeps it) |
| `created_at` | timestamptz not null default now() | |
| `deleted_at` | timestamptz | the image's own soft delete (removed from its note, shown in the bin). Independent of `notes.deleted_at`: an image of a deleted note keeps `deleted_at = null` |

Indexes: unique on `path`; btree on `(note_id, position)`; unique on `sha256` where `deleted_at is null` (`note_images_sha256_live_uniq`, dedupe among live images); btree on `taken_at`.

#### note_revisions
| column | type | notes |
|---|---|---|
| `id` | bigserial PK | revision number used by the `revisions` / `revert` tools |
| `note_id` | text not null, FK `notes.id` on delete cascade | |
| `body` | text not null | body as it was BEFORE the change |
| `saved_at` | timestamptz not null default now() | |

Index: `(note_id, saved_at desc)`.

#### note_embeddings (iteration 6, migration 0001)
A side table, not a column on `notes`, so every `select().from(notes)` stays free of the vector and it never enters `NoteRow` or the wire `Note`.

| column | type | notes |
|---|---|---|
| `note_id` | text PK, FK `notes.id` on delete cascade | one row per note that has (or had) text |
| `embedding` | `vector(1536)` | null while the latest attempt for `body_sha256` failed |
| `body_sha256` | text not null | hex sha256 of the UTF-8 body this row refers to |
| `model` | text not null | e.g. `openai/text-embedding-3-small` |
| `attempts` | integer not null default 0 | consecutive failures for this body + model; 0 after success |
| `last_error` | text | at most 500 chars, keys redacted (`clampError`) |
| `next_attempt_at` | timestamptz | failures only: not retried before this |
| `embedded_at` | timestamptz | when `embedding` was written; null on a failure row |
| `updated_at` | timestamptz not null default now() | |

Indexes: HNSW on `embedding vector_cosine_ops`; btree on `next_attempt_at`. The vector is *current* iff `embedding is not null`, `body_sha256` equals the note's current body hash and `model` equals the asked model. Deleted notes keep their row, so a restore needs no embedding call.

#### note_image_embeddings (iteration 8 phase 6, migration 0005)
The image twin of `note_embeddings`: a side table so no image listing drags 1536 floats. Model `google/gemini-embedding-2`, a vector space never compared with `note_embeddings`.

| column | type | notes |
|---|---|---|
| `image_id` | text PK, FK `note_images.id` on delete cascade | one row per note image that has (or had) an embedding |
| `embedding` | `vector(1536)` | null while the latest attempt for `image_sha256` failed |
| `image_sha256` | text not null | `note_images.sha256` of the bytes this row refers to |
| `model` | text not null | e.g. `google/gemini-embedding-2` |
| `attempts`, `last_error`, `next_attempt_at`, `embedded_at`, `updated_at` | as in `note_embeddings` | failure backoff via `retryDelayMs`, `clampError` |

Indexes: HNSW `note_image_embeddings_embedding_hnsw_idx` on `embedding vector_cosine_ops`; btree on `next_attempt_at`. Current iff `embedding is not null`, `image_sha256` equals the image's `note_images.sha256` and `model` equals the asked model. Removed images and images of deleted notes keep their row, so a restore needs no call. A purge removes it by cascade.

#### chat_images (iteration 8 phase 3, migration 0003)
Images pasted into a chat. Not note images: they never show on the wall and never join `note_images`. One row per byte content (sha256 unique), no soft delete. Ids have the `A-B32` shape but live in their own space (free in `chat_images` only) and are written `upload:ID`; derivatives go to `cache/c_<id>/` so they can never meet a note image's `cache/<id>/`.

| column | type | notes |
|---|---|---|
| `id` | text PK | `A-B32`, unique within this table only |
| `path` | text not null | relative to data dir: `chat-images/YYYY/MM/<id>.<ext>` |
| `sha256` | text not null | lower-case hex of the original bytes; an upload of known bytes returns the existing row |
| `mime`, `width`, `height`, `bytes` | text / integer not null | mime sniffed from magic bytes; `bytes` under the 50 MB chat cap |
| `original_name`, `host` | text | `host` = `os.hostname()` of the machine that first stored the file |
| `source` | text not null, check `in ('wall', 'claude_code')` | `ChatImageSource`; `claude_code` is for the phase 8 paste hook |
| `created_at` | timestamptz not null default now() | |

Indexes: unique `chat_images_sha256_uniq` on `sha256`; unique `chat_images_path_uniq` on `path`; btree on `created_at`.

#### note_files (iteration 8 phase 4, migration 0004)
Non-image files attached to a note. Mirrors `note_images`: the id is in the note-id format and must be free in `notes`, `note_images` and `note_files` alike (`imageIdTaken`); `position` is attach order, never renumbered; `deleted_at` is the file's own soft delete, independent of `notes.deleted_at`. Bytes that sniff as a supported image are stored as images, never here.

| column | type | notes |
|---|---|---|
| `id` | text PK | `A-B32`, shared id space with notes and images |
| `note_id` | text not null, FK `notes.id` on delete cascade | |
| `path` | text not null | relative to data dir: `files/<noteId>/<safeName>` (one folder per note) |
| `sha256` | text not null | lower-case hex of the bytes |
| `mime` | text not null | magic bytes, then extension, else `application/octet-stream` |
| `bytes` | integer not null | fits int4 under the 200 MB cap |
| `original_name` | text not null | the user's name (control characters removed); shown in the UI and downloads |
| `host` | text | `os.hostname()` of the machine holding the file |
| `position` | integer not null | attach order; remove + restore keeps it |
| `extracted_text` | text | always null in v1 |
| `extraction_status` | text not null default `'none'`, check `in ('none','pending','done','failed','unsupported')` | `ExtractionStatus`; v1 writes only `none` |
| `created_at` | timestamptz not null default now() | |
| `deleted_at` | timestamptz | removed from its note; null = part of the note |

Indexes: unique `note_files_path_uniq` on `path`; btree `note_files_note_position_idx` on `(note_id, position)`; unique `note_files_sha256_live_uniq` on `sha256` where `deleted_at is null`.

#### Chat history (iteration 8 phase 7, migration 0006)
Our own record of every chat exchange; the Agent SDK keeps no session. `ChatService` is the only writer.

`chat_threads`: `id` text PK (a UUID), `source` text not null check `in ('wall','claude_code')`, `brain` text (brain of the latest answer), `external_key` text (idempotency key of a captured exchange, phase 8; null for wall threads), `created_at`, `updated_at` timestamptz not null (bumped with `greatest`, never lowered). Indexes: unique `chat_threads_external_key_uniq`, btree on `updated_at`.

`chat_messages`:

| column | type | notes |
|---|---|---|
| `id` | text PK | 4 chars `[0-9A-Z]` (`K7F2`), shown as `[msg:K7F2]`; retried on a clash |
| `thread_id` | text not null, FK `chat_threads.id` on delete cascade | |
| `role` | text not null, check `in ('user','assistant')` | |
| `text` | text not null | current (edited) text; `''` allowed for an image-only user message |
| `source` | text not null, check `in ('wall','claude_code')` | copied from the thread so the timeline needs no join |
| `brain` | text | assistant rows only |
| `reply_to` | text, FK `chat_messages.id` on delete set null | any thread |
| `seq` | bigserial not null, unique | tie-break for equal `created_at` |
| `created_at` | timestamptz not null | always from `ChatService`'s clock (or the captured timestamp) |
| `edited_at`, `deleted_at` | timestamptz | soft delete |

Indexes: `chat_messages_timeline_idx` `(created_at, seq)`, `chat_messages_thread_idx` `(thread_id, created_at, seq)`, `chat_messages_reply_to_idx`, unique `chat_messages_seq_uniq`.

`chat_message_revisions`: `id` bigserial PK, `message_id` FK cascade, `text` (the text BEFORE an edit), `saved_at`; index `(message_id, saved_at desc)`.

`chat_message_attachments`: PK `(message_id, position)`, `message_id` FK cascade, `kind` check `in ('chat_image','note_file','note_image')`, `ref_id` (no FK; a reference into `chat_images`, `note_files` or `note_images`); index `(kind, ref_id)`.

#### Types
- `ImageMeta`: `{ sha256, mime, width, height, bytes, taken_at: string|null (UTC ISO 'Z'), original_name: string|null, host: string|null }`
- `NoteOrigin`: `{ cwd?, repo?, claude_session?, source? }`
- `ChatImageSource`: `'wall' | 'claude_code'` (iteration 8 phase 3)
- `EXTRACTION_STATUSES` / `ExtractionStatus`: `'none' | 'pending' | 'done' | 'failed' | 'unsupported'` (iteration 8 phase 4)
- `CHAT_SOURCES` / `ChatSource` (`'wall' | 'claude_code'`), `CHAT_ROLES` / `ChatRole` (`'user' | 'assistant'`), `CHAT_ATTACHMENT_KINDS` / `ChatAttachmentKind` (`'chat_image' | 'note_file' | 'note_image'`) (iteration 8 phase 7)
- `NoteRow`, `NewNoteRow`, `NoteImageRow`, `NewNoteImageRow`, `NoteRevisionRow`, `NewNoteRevisionRow`, `ChatImageRow`, `NewChatImageRow`, `NoteFileRow`, `NewNoteFileRow`, `NoteImageEmbeddingRow` (iteration 8 phase 6), `ChatThreadRow`, `ChatMessageRow`, `ChatMessageRevisionRow`, `ChatMessageAttachmentRow` (iteration 8 phase 7): Drizzle `$inferSelect` / `$inferInsert`.

Change a table here, then `npm run db:generate`; never edit an applied migration. drizzle-kit does not emit `CREATE EXTENSION`, so 0001 carries a hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`. 0002 ends with a hand-appended INSERT...SELECT that copies legacy images into `note_images`; it must stay byte-identical to `LEGACY_COPY_SQL` in `src/images/legacy.ts` (`migration0002.int` asserts it). The test suite asserts pgvector >= 0.8 (phases 4-5 use `hnsw.iterative_scan`; Neon has 0.8.6).

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
interface NoteImage {                                               // iteration 7 phase 2: one per image
  id; note_id; position: number                                     // image id (note-id format; first image = note id); attach order, never renumbered
  mime; width; height; bytes; taken_at: string|null; original_name: string|null; host: string|null; available: boolean
  urls: { thumb; display; original; preview }                       // /api/images/<id>/<variant>
  deleted_at?                                                       // only on removed images
}
interface FileMeta { sha256; mime; bytes: number; original_name; host: string|null }   // iteration 8 phase 4: what ingest knows before the row exists
interface NoteFile {                                                // iteration 8 phase 4: one per non-image file
  id; note_id; position: number                                     // file id (note-id format, never equal to a note or image id); attach order
  name; mime; bytes: number; host: string|null; available: boolean // name = original_name; stored name may differ
  extraction_status: ExtractionStatus                               // always 'none' in v1
  urls: { download }                                                // /api/files/<id>/download
  deleted_at?                                                       // only on removed files
}
interface Note { id; body; tags: string[]; created_at; updated_at; deleted_at?; origin: Origin|null; images: NoteImage[]; files: NoteFile[] }   // files: live, by position
interface Revision { revision: number; note_id; body; saved_at }
interface TagCount { tag; count: number; last_used }
interface NotePage { notes: Note[]; next_cursor: string|null }
type SearchMode = 'hybrid' | 'text'                                 // iteration 6 phase 4
interface SearchPage extends NotePage { mode: SearchMode; fallback?: string }   // mode = ranking actually used; fallback only when hybrid was asked but could not run
interface RelatedNote { note: Note; similarity: number }            // iteration 6 phase 5; similarity = 1 - cosine distance, 4 decimals
interface RelatedResult { note_id: string; related: RelatedNote[] } // most similar first
interface BinImage { image: NoteImage; note_id; kind: 'note' | 'image'; deleted_at }   // iteration 7 phase 4; deleted_at = bin time (note's for 'note', image's own for 'image')
interface Bin { notes: Note[]; images: BinImage[] }                 // GET /api/bin; both newest deleted_at first
interface PurgeResult { purged: string; files: number }             // purged note or image id; files removed from disk (image originals + cache entries + files/<noteId>/ entries)
type NoteErrorCode = 'invalid_id'|'invalid_input'|'not_found'|'deleted'|'not_deleted'|'empty_body'|'conflict'|'duplicate_image'|'duplicate_file'|'invalid_revision'|'not_embedded'   // duplicate_file: iteration 8 phase 4; not_deleted: iteration 7 phase 4, purge of a live item
class NoteError extends Error { readonly code: NoteErrorCode }
class DuplicateImageError extends NoteError { readonly noteId: string }   // iteration 7 phase 3: code 'duplicate_image'; noteId = note holding the live bytes (restoreImage)
class DuplicateFileError extends NoteError { readonly noteId: string }    // iteration 8 phase 4: code 'duplicate_file' (restoreFile; HTTP 409 with note_id)
function cleanOrigin(value: unknown): Origin | null       // keeps known non-blank string keys; null if none left
function imageAvailable(dataDir: string, imagePath: string): boolean   // file exists and stays inside dataDir
function imageUrls(imageId): NoteImage['urls']
function toNoteImage(row: NoteImageRow, dataDir: string): NoteImage   // deleted_at set only on removed rows
function fileUrls(fileId): NoteFile['urls']
function toNoteFile(row: NoteFileRow, dataDir: string): NoteFile     // available via imageAvailable; deleted_at only on removed rows
function rowToNote(row: NoteRow, dataDir: string, images: readonly NoteImageRow[], files: readonly NoteFileRow[] = []): Note   // keeps live images and files only, each sorted by position
```
`Note` is the wire shape shared by MCP, HTTP and the UI. All timestamps are UTC ISO strings. `deleted_at` is present only on deleted notes. `images` is built from `note_images` rows (empty for text notes; removed images are dropped), never from the legacy `notes.image_*` columns; `files` (iteration 8 phase 4) is built the same way from `note_files`. Each `available` is checked against the local data dir on every conversion. `ImageMeta` is still re-exported for ingest. `NoteError` is the only error the service throws on purpose (`DuplicateImageError` is a `NoteError` subclass that also names the holder note). HTTP (phase 6) maps `code` to a status.

`BinImage.kind` (iteration 7 phase 4) tells the bin UI what restore / delete forever act on: `'note'` is a non-removed image of a deleted note (act on the note), `'image'` is an image removed from its note (act on the image; its `image.deleted_at` is set). A removed image of a deleted note is listed once, as `'image'`.

### src/notes/dates.ts

```ts
function parseDateBound(value: string, bound: 'from' | 'to'): Date
```
`YYYY-MM-DD` is a whole day in the process's local timezone: `from` gives that day's local midnight and `to` gives the next day's midnight. An ISO datetime (must contain `T`) is exact, and a `to` bound gets +1 ms. Callers compare `col >= from AND col < to`, so both bounds are inclusive. Invalid input throws `NoteError('invalid_input')`.

### src/notes/events.ts

```ts
type NoteOp = 'created' | 'updated' | 'deleted' | 'restored' | 'purged'   // purged: iteration 7 phase 4
interface NoteEvent { type: 'note'; op: NoteOp; id: string }
class NoteEvents {
  emit(op: NoteOp, id: string): void
  on(listener: (e: NoteEvent) => void): () => void   // returns unsubscribe
  listenerCount(): number
}
```
In-process `EventEmitter` wrapper with no listener cap. `NotesService` is the only emitter. SSE (phase 6) subscribes. `purged` carries the purged note's id (`purgeNote`) or the owning note's id (`purgeImage`).

### src/notes/repo.ts

```ts
type Tx; type Executor = Db | Tx
const DEFAULT_LIMIT = 50, MAX_LIMIT = 5000
interface NoteFilter {
  tagsAny?: string[]; tagsAll?: string[]
  dateField?: 'created' | 'updated'      // default 'created'; also the list sort column
  from?: string; to?: string             // via parseDateBound
  hasImage?: boolean                     // true = at least one live image, false = none, undefined = both
  takenFrom?: string; takenTo?: string   // EXIF taken_at range, via parseDateBound; matches when any live image is in range
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
interface CandidateQuery { query; vector: readonly number[]; model; ids: readonly string[]; excluded: readonly string[]; textLimit; vectorLimit }
interface CandidateRow { row: NoteRow; textRank: number | null; similarity: number | null }
searchCandidates(db: Db, q: CandidateQuery, filter): Promise<CandidateRow[]>   // hybrid candidates, unordered (phase 4)
findNotesByIds, findNoteById, lockNote (SELECT ... FOR UPDATE)
insertNote(db, values): Promise<NoteRow | null>   // null on id clash; never writes the legacy image columns (images go through imageRepo.insertImage)
idExists, setBody, setOrigin, setDeleted, insertRevision, listRevisions (newest first), getRevision
touchNote(tx, id): Promise<NoteRow>              // bumps updated_at only (an image was attached/removed/restored); unknown -> not_found (iteration 7 phase 3)
listTags(db): Promise<TagRow[]>                   // live notes only; count desc, tag asc
```
Paging fetches `limit + 1` rows with an offset cursor. `next_cursor` is non-null only when another page exists. Image filters (iteration 7 phase 2) are `exists` subqueries over `note_images` (`note_id = notes.id and deleted_at is null`): `hasImage: true` is `exists`, `false` is `not exists`, and `takenFrom`/`takenTo` add both bounds (`taken_at >= from`, `taken_at < to`, as `timestamptz`) to **one** `exists`, so a single live image must meet both; served by `note_images_taken_at_idx`. The subquery names `note_images` unaliased, so an outer query that also joins `note_images` must alias its own copy. Images with no EXIF date never match a taken bound. MCP exposes `hasImage`/`takenFrom`/`takenTo` as `has_image`/`taken_from`/`taken_to`; `/api/notes` exposes only `has_image`. The search vector expression must stay `to_tsvector('simple', body)` to hit the GIN index.

`searchCandidates` (iteration 6 phase 4) runs three queries, every one under the same `filterConditions(filter)`, so filters apply before ranking: (1) up to `textLimit` full-text matches in text mode's order, left-joined to the note's *current* embedding (`isCurrentEmbeddingSql(model)`); (2) up to `vectorLimit` nearest current vectors (`ORDER BY embedding <=> $q LIMIT k`, the HNSW cosine shape) inside a transaction with `set local hnsw.iterative_scan = strict_order`, so selective filters still yield up to k rows, and with the query's `-word` exclusions applied as `not (tsv @@ websearch_to_tsquery(...))`; (3) the notes whose ids the query names. Rows are merged by id, first source wins; each carries both `textRank` (raw `ts_rank`, null without a full-text match) and `similarity` (`1 - cosine distance`, null without a current vector) whichever source found it. It does not page; the service ranks and slices.

### src/notes/imageRepo.ts (iteration 7 phase 1)
Data access for `note_images`. Never touches the legacy `notes.image_*` columns. Every function takes an `Executor` (a `Db` or a transaction).
```ts
const NOTE_IMAGES_SHA_LIVE_INDEX = 'note_images_sha256_live_uniq'
interface LiveImageHit { image: NoteImageRow; noteDeletedAt: Date | null }
function isLiveShaClash(err): boolean          // 23505 on the live-sha256 index, found through the Drizzle cause chain
function imagesForNotes(db, noteIds, opts?: { includeRemoved? }): Promise<Map<string, NoteImageRow[]>>
                                                // every requested id is a key ([] if none); ordered by position, then id
function findImageById(db, id): Promise<NoteImageRow | null>          // any state
function findLiveImageBySha256(db, sha256): Promise<LiveImageHit | null>   // non-removed image; its note may be deleted
function insertImage(db, values: NewNoteImageRow): Promise<NoteImageRow>   // live-sha clash -> NoteError('duplicate_image'); other errors rethrown
function nextPosition(db, noteId): Promise<number>   // max(position) over all rows incl. removed, + 1; 0 for none
function imageIdTaken(db, id): Promise<boolean>      // used as a note id, an image id or (iteration 8 phase 4) a file id
function pgErrorInfo(err): PgErrorInfo | undefined   // exported in iteration 8 phase 4 for fileRepo: first { code, constraint, message } in the cause chain
function setImageDeleted(db, id, deleted): Promise<NoteImageRow>
                                                // remove is idempotent and keeps the first time; unknown -> not_found;
                                                // restore while the bytes live elsewhere -> duplicate_image; never touches the note
```
A failed insert inside a transaction aborts that transaction, so callers that catch `duplicate_image` mid-transaction must roll back.

### src/notes/binRepo.ts (iteration 7 phase 4)
Recycle-bin reads and the hard deletes behind delete forever. Only `NotesService` calls it.
```ts
interface BinImageRow { image: NoteImageRow; noteDeletedAt: Date | null }
function listDeletedNoteIds(db, tagsAll?): Promise<string[]>        // deleted notes with every tag; deleted_at desc, id desc
function listBinImages(db, tagsAll?): Promise<BinImageRow[]>        // removed images + non-removed images of deleted notes; order coalesce(image.deleted_at, note.deleted_at) desc, id desc
function lockImageRow(tx, id): Promise<NoteImageRow | null>         // SELECT ... FOR UPDATE
function deleteNoteRow(tx, id): Promise<boolean>                    // note_images, note_revisions, note_embeddings cascade (FK)
function deleteImageRow(tx, id): Promise<boolean>
function clearLegacyImage(tx, noteId): Promise<void>                // notes.image_path / image_meta -> null; updated_at untouched
```
Tag filters go through `normalizeTagInput` and `arrayContains(notes.tags, ...)` on the owning note, so they are AND.

### src/notes/fileRepo.ts (iteration 8 phase 4)
Data access for `note_files`, the same shape as imageRepo: only `NotesService` writes, inside its transaction after the owning note is locked.
```ts
const NOTE_FILES_SHA_LIVE_INDEX = 'note_files_sha256_live_uniq', NOTE_FILES_PATH_INDEX = 'note_files_path_uniq'
interface LiveFileHit { file: NoteFileRow; noteDeletedAt: Date | null }
function isLiveFileShaClash(err): boolean / isFilePathClash(err): boolean   // 23505 on the named index
function filesForNotes(db, noteIds, opts?: { includeRemoved? }): Promise<Map<string, NoteFileRow[]>>   // every id a key; position, then id
function findFileById(db, id): Promise<NoteFileRow | null>          // any state
function findLiveFileBySha256(db, sha256): Promise<LiveFileHit | null>
function filePathTaken(db, path): Promise<boolean>                  // any row, any state, any host
function insertFile(db, values): Promise<NoteFileRow>               // live-sha clash -> duplicate_file; path clash -> conflict (caller retries next name)
function nextFilePosition(db, noteId): Promise<number>              // max over all rows incl. removed, + 1; 0 for none
function setFileDeleted(db, id, deleted): Promise<NoteFileRow>      // remove idempotent (keeps first time); unknown -> not_found; restore clash -> duplicate_file
```

### src/notes/service.ts

```ts
const MAX_ID_ATTEMPTS = 20
const RELATED_DEFAULT_LIMIT = 10, RELATED_MAX_LIMIT = 50
interface RelatedOptions { limit?: number }          // clamped to 1..50, default 10
interface AttachImageInput { id: string; path: string; meta: ImageMeta }   // id from newId(); path relative to dataDir (images/YYYY/MM/<id>.<ext>)
interface AttachFileInput { id: string; path: string; meta: FileMeta }     // iteration 8 phase 4; path must be files/<noteId>/<safe name>
interface BinOptions { tagsAll?: string[] }          // iteration 7 phase 4; `#` and case ignored
class NotesService {
  constructor(deps: { db: Db; dataDir: string; events: NoteEvents; embedder?: Embedder | null })   // embedder: query side of hybrid search (phase 4) and related (phase 5); writes never use it
  requireId(input: string): string                    // normalizeId or NoteError('invalid_id')
  newId(): Promise<string>                            // id free as a note, image or file id (imageIdTaken), for callers that must name a file first
  create(input: { body; origin?; image?: { path; meta }; allowEmpty?; id? }): Promise<Note>   // image -> first note_images row (id = note id, position 0), same transaction
  getOne(id, { includeDeleted? }): Promise<Note | null>
  get(ids, { includeDeleted? }): Promise<{ notes; missing; deleted }>   // input order, deduped
  findBySha256(sha256, { includeDeleted? }): Promise<Note | null>   // note holding a live image with these bytes; deleted holder only with includeDeleted
  list(filter?: NoteFilter): Promise<NotePage>
  search(query, filter?, opts?: SearchOptions): Promise<SearchPage>   // blank query -> invalid_input; opts { mode?: 'hybrid'|'text' (default hybrid), queryTimeoutMs? }
  tags(): Promise<TagCount[]>
  related(id, opts?: RelatedOptions): Promise<RelatedResult>   // iteration 6 phase 5
  private embedNow(id, body, input): Promise<void>    // embeds one source note now; not_embedded on no embedder / failure / empty result
  revisions(id): Promise<Revision[]>                  // not_found if the id has no note
  update(id, body, { origin?, allowEmpty? }): Promise<Note>
  append(id, text, { origin? }): Promise<Note>        // joins with a blank line
  delete(id): Promise<Note>                           // soft; no-op if already deleted
  restore(id): Promise<Note>                          // no-op if live
  revert(id, revision: number): Promise<Note>
  attachImage(noteId, input: AttachImageInput): Promise<Note>   // iteration 7 phase 3: append one image to a live note
  removeImage(imageId): Promise<Note>                 // soft; returns the owning note; no-op if already removed
  restoreImage(imageId): Promise<Note>                // back at its old position; restores a deleted note too
  attachFile(noteId, input: AttachFileInput): Promise<Note>     // iteration 8 phase 4: append one non-image file to a live note
  removeFile(fileId): Promise<Note>                   // soft; returns the owning note; no-op if already removed
  restoreFile(fileId): Promise<Note>                  // back at its old position; restores a deleted note too
  listBin(opts?: BinOptions): Promise<Bin>            // iteration 7 phase 4: read-only recycle bin
  purgeNote(id): Promise<PurgeResult>                 // delete forever, deleted notes only; UI-only (no MCP tool)
  purgeImage(imageId): Promise<PurgeResult>           // delete forever, removed images only; UI-only (no MCP tool)
  private removeFiles(targets): Promise<number>       // removeImageFiles per image after commit; failures logged, not thrown
  private removeNoteFiles(noteId, targets): Promise<number>   // iteration 8 phase 4: removeNoteFile per file row, then removeNoteFolderIfEmpty; failures logged
  private requireImageId(input): string               // normalizeId or NoteError('invalid_id') with an image-id message
  private lockImage(tx, imageId): Promise<{ note: NoteRow; image: NoteImageRow }>   // lock the owning note, then re-read the image
  private requireFileId(input): string / lockFile(tx, fileId)   // iteration 8 phase 4: same as the image pair, for files
}
function fileValues(noteId, id, path, meta, position)    // module-private: note_files insert values (extraction_status defaults to 'none')
function imageValues(noteId, id, path, meta, position)   // module-private: note_images insert values; used by create and attachImage
function toBinImage(row: BinImageRow, dataDir): BinImage  // module-private: bin row -> wire BinImage
```
Every mutation runs in one transaction that locks the row (`FOR UPDATE`), writes the previous body to `note_revisions`, then writes the new state. Delete also stores the body as a revision. Exactly one `NoteEvents` event is emitted after commit, and none for a no-op: an unchanged body on update, a revert to an identical body, a repeat delete or restore. `update`, `append` and `revert` on a deleted note throw `deleted`. `create` runs in one transaction: it skips any id already used by a note or an image (`imageIdTaken`), inserts the note and, when `image` is given, its first image row. Generated ids are retried up to 20 times. With an explicit `id`, a taken id throws `conflict` without retry. A live-sha256 clash on the image throws `duplicate_image` and leaves nothing behind. `allowEmpty` exists for HTTP and image notes. MCP never sets it. Every read (`getOne`, `get`, `list`, `search`, `related`, mutations) converts rows through the private `toNotes`, which loads all their live images with one `imageRepo.imagesForNotes` call and (iteration 8 phase 4) all their live files with one `fileRepo.filesForNotes` call.

Image mutations (iteration 7 phase 3, P1-NOTES-A025) write no revision; each bumps the note's `updated_at` through `repo.touchNote` and emits one event with the **note** id after commit (none for a no-op). `attachImage` locks the note live (`deleted` on a deleted note), throws `conflict` if the image id is taken (`imageIdTaken`), and inserts at `imageRepo.nextPosition` (max over every row, removed ones included, + 1, so a removed image keeps its slot); a live-sha clash surfaces as `duplicate_image` from `insertImage`. Emits `updated`. `removeImage` and `restoreImage` take an image id and go through the private `lockImage`, which finds the image, locks its owning note row (`FOR UPDATE`), then re-reads the image, so concurrent changes to one note's images serialise; the lock order is note row first, image row second (phase 4's purge must keep it). Unknown image -> `not_found`. `removeImage` works whatever state the note is in and emits `updated`. `restoreImage` is a no-op for a live image in a live note; for a removed image it first checks `findLiveImageBySha256` and throws `DuplicateImageError(holderNoteId)` when another image holds the bytes, and a unique violation racing in during `setImageDeleted` becomes a plain `duplicate_image` ("try again"); a deleted owning note is restored in the same transaction. Emits `restored` when the note came back, else `updated`.

File mutations (iteration 8 phase 4, P1-NOTES-A037) follow the image rules exactly: no revision, `touchNote`, one event with the note id, none for a no-op. `attachFile` refuses a `path` that is not `files/<noteId>/<one safe segment>` (`isNoteFileRelPath`) with `invalid_input`, locks the note live, throws `conflict` for a taken id, and inserts at `fileRepo.nextFilePosition`; a live-sha clash is `duplicate_file`. `removeFile` / `restoreFile` go through `lockFile` (note row first, then the file re-read). `restoreFile` throws `DuplicateFileError(holderNoteId)` when another live file holds the bytes, a racing unique violation becomes a plain `duplicate_file`, and a deleted owning note is restored too. Unknown file -> `not_found` ("File ids are listed in each note's files").

Recycle bin (iteration 7 phase 4, P1-NOTES-A026). `listBin` reads `binRepo.listDeletedNoteIds` then `get(ids, { includeDeleted: true })` (keeps the order, attaches each note's live images; a note purged in between is just not listed), plus `binRepo.listBinImages` mapped through `toBinImage`. It emits nothing and leaves `tags()` (live notes only) unaffected. `purgeNote` locks the note in one transaction: unknown -> `not_found`, live -> `not_deleted`; it collects every image row of the note, removed ones included (plus the legacy `notes.image_path` if no row has that path), then `deleteNoteRow` cascades images, files, revisions and embeddings. Since iteration 8 phase 4 it also collects every `note_files` row (removed included) and, after commit, `removeNoteFiles` unlinks each under `files/<noteId>/` (`removeNoteFile` touches only a regular file or symlink at exactly that path) and then the folder if empty; its count is added to `files`. `purgeImage` looks the image up, then locks note row first and image row second (`lockNote`, `lockImageRow`, the same order as `lockImage`); a non-removed image -> `not_deleted` (an image of a deleted note that was never removed is purged with its note, not here). It deletes the row and, when the row is the note's legacy image (image id = note id and the path equals `notes.image_path`), calls `clearLegacyImage` in the same transaction so `reconcileLegacyImages` cannot bring it back. Both remove files only after commit through `removeFiles` (a failure is logged as `notesd: purge could not remove the files of image ...` and skipped; the rows are already gone), then emit one `purged` event and return `{ purged, files }`.

`search` (iteration 6 phase 4): `mode: 'text'` is exactly the pre-iteration-6 `repo.searchNotes` ranking and never calls the embedder. Hybrid (the default) checks the cursor first, then embeds the query through `embedQuery` (per-service `QueryVectorCache`, so paging embeds once). With no embedder it returns the text ranking with `fallback: SEMANTIC_OFF_FALLBACK`; if the embedding throws or times out, it returns the text ranking with `fallback: embedFailedFallback(err)`. Either way `mode` is `'text'`. Otherwise it calls `repo.searchCandidates` with `queryTerms(query)` ids and exclusions and `BLEND.textCandidates` / `BLEND.vectorCandidates`, ranks with `rankCandidates` (tag match from the note's `tags`, `now = new Date()`) and slices `[offset, offset + limit)`. The cursor is an offset into whichever ranking produced the page.

`related` (iteration 6 phase 5) clamps `limit` to 1..50 (default 10), throws `not_found` for an unknown id, `deleted` for a deleted note (the message suggests `restore`), and `invalid_input` when `embedInput(body)` is null (a photo with no text or an empty body; the message suggests `append` or `list` by date). It calls `embeddings.nearestNotes` with `embedder?.model ?? EMBEDDING_MODEL`. When that returns null (the source has no current vector), `embedNow` embeds the body once and stores it through `saveEmbedding` (the same body-hash-guarded upsert the worker uses), then asks again; a second null means the body changed meanwhile and throws `not_embedded` ("try again"). `embedNow` throws `not_embedded` with no embedder (semantic search off, use `search` instead), when the embedder throws (the background job retries), or when it returns no vector. With no embedder, sources that already have a current vector still answer. Similarity is `1 - distance` rounded to 4 decimals. It is read-only apart from that on-demand vector and emits no event.

### src/mcp/instructions.ts

```ts
function localTimeZone(): string                    // Intl resolved IANA zone
function buildInstructions(timeZone?: string): string
```
The server-instructions text Claude reads once per session. It covers the note model, id format, writing and revision semantics, reading and search syntax, and date semantics (it names the daemon's timezone). It also says comparisons are Claude's job. Phase 5 added an `Images.` section: the `image` field shape, `available: false` meaning the file is on another host, `view_images` with up to 8 ids, saved-date queries (`has_image` + `from`/`to`) versus taken-date queries (`taken_from`/`taken_to`), and `create_image` copying a local file with dedupe. Iteration 5 phase 1 appended a `Connectors.` section: the three systems and their `expenses_*` / `runs_*` / `seer_*` prefixes, strictly read-only, prefer the curated tools (the list is generated from `CONNECTOR_TOOL_NAMES`, skipping each system's first two), fall back to `<system>_sql` only after `<system>_schema`, units and timezone (Asia/Jakarta days, whole rupiah, Seer in USD), and "if a system is not reachable, say so and answer from the rest". Iteration 6 phase 4 rewrote the search part of the `Reading.` paragraph: search understands meaning by default (mode `"hybrid"`, with the "ArangoDB credentials" and "auth failures after resume" examples), pass the question in plain words, ids and code tokens still rank first, mode `"text"` keeps the old exact-word syntax, and a result carrying `fallback` means meaning search was unavailable, so tell the user. Iteration 6 phase 5 added a `Related.` paragraph after `Reading.`: `related(id)` returns the notes closest in meaning to one note, most similar first with a similarity score (1 = same meaning, near 0 = unrelated), never the note itself or a deleted note, for "what else do I have on this?". Iteration 7 phase 2 rewrote the `Notes.` paragraph (every note has `images`, an array, empty for text notes) and the `Images.` paragraph: a note can hold several images, the per-image entry shape `{id, note_id, position, mime, width, height, bytes, taken_at, original_name, host, available, urls}`, a first image shares the note's id, `view_images` takes up to 8 note or image ids (a note id shows every image, at most 8 images per call, a last line lists the ids left), `has_image` means at least one image, a taken range matches when any image was taken then, and `create_image` makes a new note. `src/chat/prompt.ts` got the matching `view_images` sentence. Iteration 7 phase 3 added an `Attaching.` paragraph between `Images.` and `Connectors.`: every image entry has its own id (the first image of a picture note shares the note id), `attach_image(id, path)` copies a local file into an existing note, a file already in some note comes back with `attached: false` (tell the user where it is), `remove_image(image_id)` is soft (bin, file untouched), `restore_image(image_id)` puts it back at its old position (restoring a deleted note too), and "Nothing you can call deletes a note or an image permanently"; only the user can, from the web page's recycle bin. Iteration 8 phase 4 added `files` (an array, empty when none) to the `Notes.` paragraph's field list and a `Files.` paragraph between `Attaching.` and `Connectors.`: notes can hold non-picture files attached on the wall, each entry `{id, note_id, position, name, mime, bytes, host, available, extraction_status, urls}`, Claude cannot open their contents (`extraction_status` is always `"none"` today) but should name each file with type and size, no tool attaches/removes/restores files, `view_images` ignores them, and `available: false` means another host. `src/chat/prompt.ts` got the matching sentence: the chat brain sees each file's name, type and size but cannot open or attach files. Iteration 8 phase 6 added a `Similar images.` paragraph between `Files.` and `Connectors.`: `similar_images` takes exactly one of `image_id`, `upload_id` (`[image upload:ID]` in a wall-chat message), `query` (words and pictures share one vector space) or `pasted_image` (number of an image pasted into the Claude Code conversation), returns hits `{image_id, note_id, similarity, note: {body, tags}, available}` most similar first, never the source, a removed image or a deleted note's image; it only measures likeness, so call `view_images` on the top ids before saying which match, and use `search` to find photos by their note words. `src/chat/prompt.ts` got the matching sentence: pasted chat images are named `[image upload:ID]`; to find photos like one, call `similar_images` with `upload_id` (`image_id` / `query` otherwise), then `view_images` on the top hits.

### src/mcp/tools.ts

```ts
interface ToolDeps { service: NotesService; dataDir: string; db: Db; connectors?: Connectors; wallUrl?: string;
  imageEmbedder?: ImageEmbedder | null;   // iteration 8 phase 6: similar_images; omitted/null = image search off (existing vectors still answer image_id)
  chatUploads?: ChatUploadSource }        // iteration 8 phase 6: upload_id lookup; omitted = upload_id answers "not available"
// db is read-only, for phase 5; connectors omitted = defaultConnectors(). mcpToolDeps (src/http/app.ts) fills imageEmbedder from AppDeps and chatUploads with dbChatUploadSource(db, dataDir).
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
| `search` | `query`, `mode?` (`hybrid` default \| `text`) + `noteFilterShape` | `{ notes, next_cursor, mode, fallback? }` |
| `tags` | none | `{ tags }` |
| `related` | `id`, `limit?` (1-50, default 10) | `{ note_id, related: [{ note, similarity }] }`; `readOnlyHint` (iteration 6 phase 5) |
| `revisions` | `id` | `{ revisions }` |
| `revert` | `id`, `revision` | `{ note }` |

Errors never throw out of a handler. They come back as `isError` results.

### src/mcp/imageTools.ts

```ts
const VIEW_IMAGES_MAX = 8
function filesLine(note: Note): string | null      // iteration 8 phase 4: `files: a.pdf (application/pdf, 1.2 MB); ...`, null when none
function describeNote(note: Note): string          // id, saved, tags, files line (if any), body (a note without an image)
function describeImage(note: Note, image: NoteImage, k: number, n: number): string
                                                   // note id, `image: <imageId> (image k of n)`, saved, taken (or 'unknown (no EXIF date)'), WxH mime size, original name, tags, files line (if any), body
function registerImageTools(server: McpServer, deps: ToolDeps): void
```
| tool | input | returns |
|---|---|---|
| `create_image` | `path` (absolute or `~/`), `body?`, `origin?` | `{ note, created }`; origin gets `source: 'mcp'`; always a new note with that one image |
| `view_images` | `ids[1..8]`: note ids or image ids | per image: a metadata text block, then an MCP `image` block (the preview JPEG, base64); at most 8 images, then one overflow line |
| `attach_image` | `id` (note), `path` (absolute or `~/`), `origin?` (accepted, ignored) | `{ note, attached }`; a new image is the last entry of `note.images`; `attached: false` = the bytes already live in `note` (iteration 7 phase 3) |
| `remove_image` | `image_id` | `{ note }`: the owning note without that image; soft, idempotent |
| `restore_image` | `image_id` | `{ note }`; `duplicate_image` error naming the holder note when the bytes are live elsewhere |

`create_image` goes through `ingestFromPath`, which copies the file (never moves it) and dedupes against live images by sha256 (`created: false`, returning the holder note). An `ImageInputError` comes back as `isError` text `create_image refused (<code>): <message>`. `view_images` (iteration 7 phase 2) loads the notes with `includeDeleted` and walks the ids in input order: a note id expands to every live image of the note in position order, and an id that is not a note is looked up as an image id (`records.byImageId`) and shows that one image, numbered within its note. Images already shown in the call are skipped. After 8 images, the rest are collected into one last text line `<n> more image(s) not shown (at most 8 per call): <ids>. Call view_images again with these ids.` It answers with a text line instead of an image for an unknown id, a deleted note, an image whose note is deleted, a removed image, a text note, a file on another host (`image not on this machine: the file lives on <host>`) or a preview that failed to generate. It always serves the `preview` variant (long edge <= 1568, <= 3.75 MB), so the payload stays under Claude's image limit. `attach_image` (iteration 7 phase 3) goes through `attachFromPath` with `toolAttachDeps(deps)`; an `ImageInputError` comes back as `attach_image refused (<code>): <message>` and any other error through `errorResult`. `remove_image` / `restore_image` call `NotesService.removeImage` / `restoreImage` inside `run`. No MCP tool deletes a note or an image permanently.

### src/mcp/similarTools.ts (iteration 8 phase 6)

```ts
const SIMILAR_IMAGES_DEFAULT_LIMIT = 10, SIMILAR_IMAGES_MAX_LIMIT = 50, SIMILAR_SNIPPET_CHARS = 200
const IMAGE_SEARCH_OFF: string            // no OPENROUTER_API_KEY: pictures cannot be compared; use search / list has_image
const PASTED_IMAGE_NEEDS_HOOK: string     // a call still carrying pasted_image: the notes-paste hook is missing, found no pasted image, or could not upload it
interface SimilarArgs { image_id?; upload_id?; query?; pasted_image?; limit? }
type SimilarSource = { image_id } | { upload_id } | { query }
interface SimilarHit { image_id; note_id; similarity; note: { body; tags }; available }
interface SimilarImagesResult { source; model; hits: SimilarHit[]; next: string }
function countSources(args: SimilarArgs): number
function bodySnippet(body, max?): string   // whitespace collapsed, ellipsis when cut, never half a surrogate
function registerSimilarTools(server: McpServer, deps: ToolDeps): void
```
| tool | input | returns |
|---|---|---|
| `similar_images` | exactly one of `image_id`, `upload_id`, `query`, `pasted_image` (1-20); `limit?` (1-50, default 10) | `{ source, model, hits, next }`; `readOnlyHint` |

Not exactly one source is an `isError`. `pasted_image` (`N` of `[Image #N]`) never reaches the handler when the `notes-paste` PreToolUse hook worked (iteration 8 phase 8): the hook uploads the pasted image and rewrites the call to `upload_id`. A call that still carries it answers `PASTED_IMAGE_NEEDS_HOOK` ("pasted_image could not be resolved": paste again with the request, run `scripts/install.sh`, or use `image_id` / `query`). `image_id`: normalised and located (`locateImage`, any state); `nearestImages` from its stored vector with `imageEmbedder?.model ?? IMAGE_EMBEDDING_MODEL`, so existing vectors answer even with no embedder. With no current vector it embeds the image now from its preview PNG and stores it with `saveImageEmbedding` (as `related` does for notes), then asks again; it refuses with a readable message when there is no embedder, the original lives on another host, preparation or the call fails, or the bytes changed meanwhile. `upload_id`: needs the embedder and `chatUploads`; the upload's original must be on this machine; it is converted with `toEmbeddingPng`, embedded on the fly and never persisted (an upload is a question, not a note). `query`: trimmed, must be non-empty, `embedText`. Hits are joined to live notes through `service.get`; a hit whose note or image disappeared meanwhile is dropped. `next` tells the model to `view_images` the top ids, or, with no hits, that new images are embedded in the background within a minute and `npm run embed:images:backfill` embeds existing ones. `SimilarError` messages come back as plain `isError` text; other errors go through `errorResult`.

### src/http/imageAccess.ts

```ts
const MAX_IMAGE_BYTES = 200 * 1024 * 1024
type ImageVariant = 'original' | 'display' | 'thumb' | 'preview'
interface ServedFile { absPath; mime; etag; size; immutable }
type ResolveResult =
  | { status: 'ok'; loc: LocatedImage; file: ServedFile; servedOriginal: boolean }
  | { status: 'not_found' } | { status: 'no_image'; id /* note alias only */ } | { status: 'not_on_this_machine'; id; host: string | null }
type ImageInputErrorCode = 'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large'
class ImageInputError extends Error { readonly code: ImageInputErrorCode }
function toolImageDeps(deps: ToolDeps): ImageDeps      // ImageDeps from ToolDeps (MCP gets ToolDeps, not AppDeps)
function expandHome(p, home?): string                   // '~' and '~/...' only
function etagMatches(header, etag): boolean             // If-None-Match lists, W/ weak tags, '*'
function resolveImageFile(img, rawImageId, variant): Promise<ResolveResult>     // by image id, any state
function resolveNoteImageFile(img, rawNoteId, variant): Promise<ResolveResult>  // note alias: first live image of a live note
function ingestFromUpload(img, file: File, body?, maxBytes?): Promise<{ note; created }>   // origin.source = 'web'
function ingestFromPath(img, rawPath, body?, origin): Promise<{ note; created }>           // move: false
function toolAttachDeps(deps: ToolDeps): AttachDeps     // iteration 7 phase 3: toolImageDeps + notes: deps.service
function attachFromUpload(img: AttachDeps, noteId, file: File, maxBytes?): Promise<AttachResult>   // POST /api/notes/:id/images
function attachFromPath(img: AttachDeps, noteId, rawPath): Promise<AttachResult>                    // attach_image; copied, never moved
```
The one place HTTP and MCP share image logic. `resolveImageFile` normalises an **image id** and calls `locateImage`; it serves any existing row (live, removed from its note, or in a deleted note, so the bin can show thumbnails) and only a bad or unknown id is `not_found`. `resolveNoteImageFile` is the legacy note-id alias: it calls `locateNoteImage` (first live image by position); an unknown or deleted note is `not_found` and a live note with no live image is `no_image`. Both share the private `resolveLocated`: an original that is missing locally (checked up front via `available`, and again when a derive getter throws `OriginalMissingError`) is `not_on_this_machine` with the image's `host`. Cached derivatives are never served once the original is gone. ETags are `"<sha256>"` for the original (and for `display` when it is the original) and `"<sha256>-<variant>"` for derivatives. Only originals are `immutable`. Both ingest helpers reject empty and oversized input, blank bodies become no body, and they map `UnsupportedImageError` to `ImageInputError('not_an_image')`. The attach helpers do the same checks (the path one through the private `checkLocalImagePath`: absolute or `~/`, exists, regular file, non-empty, under `MAX_IMAGE_BYTES`) and the same `UnsupportedImageError` mapping (private `runAttach`), then call `ingest.attachImage`.

### src/http/images.ts

```ts
interface ImageRouteOptions { maxUploadBytes?: number }   // default MAX_IMAGE_BYTES; tests lower it
function imageRoutes(deps: AppDeps, opts?: ImageRouteOptions): Hono
```
| route | input | success |
|---|---|---|
| `POST /api/images` | multipart: `file` (required), `body?` | 201 `{ note, created: true }` (a new note with one image), or 200 with `created: false` when a live image already holds the bytes |
| `POST /api/notes/:id/images` | multipart: `file` (required) | 201 `{ note, attached: true }` (image appended), or 200 `{ note, attached: false }` with the note already holding the bytes (iteration 7 phase 3) |
| `DELETE /api/images/:imageId` | any id spelling | 200 the owning `Note` without that image (soft remove; idempotent) |
| `POST /api/images/:imageId/restore` | any id spelling | 200 the owning `Note`; 409 `{ error: 'duplicate_image', note_id, message }` when the bytes are live elsewhere |
| `GET /api/images/:imageId` | any id spelling | `NoteImage` JSON for any existing row (removed images carry `deleted_at`); 404 `not_found` otherwise |
| `GET /api/images/:imageId/original` | any id spelling | the stored bytes, `Content-Disposition: inline` with the original name; any state |
| `GET /api/images/:imageId/display` | | the original if browser-displayable, else `display.jpg` |
| `GET /api/images/:imageId/thumb` | | `thumb.webp` (480 px wide) |
| `GET /api/images/:imageId/preview` | | `preview.jpg` (long edge <= 1568) |
| `GET /api/notes/:id/{original,display,thumb,preview}` | note id | alias: the same variant of the note's first live image; deleted note 404 `not_found`, no live image 404 `no_image` |

The upload is capped by `bodyLimit` at `maxUploadBytes + 1 MB` (multipart overhead), then again on the file size. Image GETs stream the file and set `ETag`, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy`, and `Cache-Control: private, max-age=31536000, immutable` for originals or `private, max-age=86400` for derivatives. A matching `If-None-Match` returns 304. `createApp` calls `imageRoutes(deps)` with no options. The attach route uses the same `bodyLimit` cap; attach, remove and restore map errors through the private `writeErrorResponse`: `ImageInputError` -> 413 `too_large` or 415 `<code>`; `NoteError` `not_found`/`deleted` -> 404 `not_found`, `invalid_id` -> 400, `duplicate_image` -> 409 with `note_id` (from `DuplicateImageError`, else null), `conflict` -> 409; anything else rethrows (500). A malformed id is 400 `invalid_id`, a bad multipart 400 `bad_multipart`, no file 400 `file_required`. These three routes are not behind `sameOriginOnly`.

### src/mcp/server.ts

```ts
const SERVER_NAME = 'mcp-notes', SERVER_VERSION = '0.1.0'
function createMcpServer(deps: ToolDeps): McpServer
function handleMcpRequest(req: Request, deps: ToolDeps): Promise<Response>
```
The server is stateless. Each POST gets a fresh `McpServer` and a `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` and no session id generator, and both are closed after the response. A daemon restart therefore never strands a client. `createMcpServer` registers the note tools, the image tools, the similar tools (`similar_images`, iteration 8 phase 6), then `registerConnectorTools(server, deps.connectors ?? defaultConnectors())`. That is lazy: nothing is read or connected until a connector tool is called.

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
function registerConnectorTools(server, connectors): void   // _schema + _sql for every system, then each register<Id>Curated
// per system: EXPENSES_ABOUT/RUNS_ABOUT/SEER_ABOUT, create{Expenses,Runs,Seer}Connector, register{Expenses,Runs,Seer}Curated
```

| tool | input | returns |
|---|---|---|
| `<id>_schema` | `tables?` (exact names, up to 100) | `{ system, source: 'db', about, tables }` |
| `seer_schema` | `tables?`, `source?` `db` / `lab` / `both` (default) | one part, or `{ system, db, lab }` with a failed side as `{ error }` (throws only when both fail) |
| `<id>_sql` | `sql` (one SELECT / WITH ... SELECT), `max_rows?` 1..1000 (default 200) | `{ columns, rows, row_count, truncated }` |
| `seer_sql` | as above, plus `source?` `db` (default, Postgres) or `lab` (SQLite) | same |

All connector tools carry `readOnlyHint` and `openWorldHint` and answer compact JSON through `run(..., { compact: true })`. Every query goes: `connectorSettings` (per call), `resolveRepoDir`, `loadDatabaseTarget` (direct URL chosen by host, `options` param dropped, `sslmode=require|prefer` rewritten to `verify-full`), a fresh `pg.Client` with the read-only startup options, `BEGIN READ ONLY`, the SQL wrapped as `SELECT * FROM (<sql>) AS q LIMIT cap+1` in array row mode, `ROLLBACK`, `end()`. The extra row sets `truncated`. The lab path is `<repo>/lab/lab.sqlite`, read in a child with an empty env that is SIGKILLed at the timeout; bigints come back as numbers when safe, blobs as `<blob N bytes>`. `<id>_sql` runs `guardSelect` first: it refuses an empty query, more than one statement, anything not starting with SELECT or WITH, write/DDL/transaction words (INSERT, UPDATE, DELETE, INTO, CREATE, PRAGMA, ATTACH, BEGIN, ...), calls to effectful functions (`pg_terminate_backend`, `set_config`, `pg_read_file`, `dblink*`, `pg_advisory_*`, `load_extension`, ...) and row locks (`FOR UPDATE` / `FOR SHARE`). Refusals read `<label> query failed: refused before reaching the database: <why>`. The guard is a convenience; the read-only session and transaction are the real barrier. Phase 1 left `src/connectors/{expenses,runs,seer}/curated.ts` as no-op stubs; phases 2, 3 and 4 replaced them (below), each using `run(..., { compact: true })` and `toObjects`.

#### Expenses curated tools (iteration 5 phase 2)

`registerExpensesCurated(server, connector)` in `src/connectors/expenses/curated.ts` registers three tools, each with `readOnlyHint` and a compact JSON answer. The handlers are thin; the work is in `queries.ts`, whose fetchers take any `ReadOnlySource` (so unit tests pass a fake) and run their queries in parallel through `connector.query` with explicit `maxRows`.

| tool | input | returns |
|---|---|---|
| `expenses_spending` | `from`, `to` (WIB `YYYY-MM-DD`, inclusive, at most 366 days), `categories?` (slugs), `top?` 1..50 (default 10) | `{ from, to, days, today_wib, categories, total_idr, item_count, group_count, days_with_spending, average_per_day_idr, by_category, by_day, by_week, largest_items }` |
| `expenses_get` | `id` (expense group id, case-sensitive) | `{ id, title, occurred_on, note, raw_text, created_at, updated_at, total_idr, item_count, items, photo_count, photos }` |
| `expenses_months` | `months?` 1..60 (default 6), `to_month?` `YYYY-MM` (default current WIB month), `categories?` | `{ to_month, months, today_wib, categories, total_idr, average_per_month_idr, by_month }` |

```ts
// categories.ts: copied as data from ~/expense-tracking/lib/categories.ts, never imported
const EXPENSE_CATEGORIES   // 17 slugs in the app's display order: meals, jajan, dining, snacks, drinks, transport, fuel, parking, bills, internet, utilities, housing, entertainment, cinema, health, grooming, other
const EXPENSE_CATEGORY_LABELS, EATING_CATEGORIES (meals, jajan, dining, snacks, drinks), DEFAULT_EXPENSE_CATEGORY = 'other'
function isExpenseCategory(v), toExpenseCategory(v) /* unknown -> 'other' */, categoryLabel(v)
// dates.ts: UTC-midnight arithmetic on calendar strings; the host timezone never changes an answer
const WIB_TIME_ZONE, DATE_RE, MONTH_RE
function isValidDateIso, isValidMonthKey, addDays, daysInclusive, weekdayOf, isoWeekMonday, isoWeekKey, todayWib(now?), addMonths
// queries.ts
const MAX_SPENDING_DAYS = 366, DEFAULT_TOP = 10, MAX_TOP = 50, DEFAULT_MONTHS = 6, MAX_MONTHS = 60
const SPENDING_BY_DAY_SQL, SPENDING_BY_CATEGORY_SQL, LARGEST_ITEMS_SQL, GROUP_SQL, GROUP_ITEMS_SQL, GROUP_PHOTOS_SQL, MONTHLY_TOTALS_SQL
function buildDayTotals, buildWeekTotals, buildCategoryTotals, buildLargestItems, fillZeroMonths, validateRange, shareOf, toInt, rowsOf (= toObjects)
function fetchSpending(source, args, now?), fetchGroup(source, id), fetchMonths(source, args, now?)
```

Semantics mirror the app: money is `sum(expense_items.amount_idr)` as integer rupiah, days are `expense_groups.occurred_on` (a WIB date), and there is no `user_id` filter (one owner per app). Totals for `expenses_spending` are summed from `by_day`. `by_week` lists every ISO week (Monday-Sunday, keyed `YYYY-Www` plus its Monday) the range touches, zero-filled, with `partial`/`days_in_range` for weeks the range cuts. `by_category` merges unknown stored slugs into `other` (its `group_count` is then an upper bound) and sorts by total, ties in display order. `largest_items` breaks ties by newest day, then item id. `expenses_get` orders items by `sort_order, id` and photos by `sort_order, created_at`, like `getGroupDetail`. `expenses_months` mirrors `getMonthlyTotals` (LEFT JOIN, zero-fill in JS); each month is `complete`, `in_progress` or `future`, and `average_per_month_idr` averages complete months only. A bad range, a reversed range, an over-long range or an unknown group id throws a plain `Error` with a hint Claude can act on, which `run()` turns into an `isError` result.

#### Run-insights curated tools (iteration 5 phase 3)

Run-insights curated tools (P1-NOTES-A014), all compact and `readOnlyHint`, dates as WIB calendar days, raw app units each with a readable companion (km, `h:mm:ss`, `m:ss /km`):

| tool | input | returns |
|---|---|---|
| `runs_list` | `from` YYYY-MM-DD, `to?` (default today) | `{ from, to, totals, runs, truncated }`: reviewed runs only, newest first, with headline/verdict of the app's analysis; totals use distance-weighted pace and time-weighted HR |
| `runs_get` | exactly one of `id` or `date` | `{ id \| date, ... }` full metrics, per-km splits (last flagged partial), HR zones 1-5, note, `reviewed`, latest analysis, `profile`; unreviewed runs included; unknown id or unreal date throws |
| `runs_review` | `scope` `week` (ISO) / `month`, `key?` (`2026-W34`, `2026-08` or a day inside; default current) | `{ scope, key, from, to, review, review_missing, totals, runs }` (brief runs); `review` null when the app stored none |

### src/http/app.ts

```ts
const loopbackOnly: MiddlewareHandler     // 403 JSON-RPC error unless URL host and any Origin are loopback (isLoopbackUrl from sameOrigin.ts)
interface CreateAppOptions { chat?: ChatBackend }   // omitted: apiRoutes' default (the stub)
function createApp(deps: AppDeps, options?: CreateAppOptions): Hono
```
Mount order is fixed: `GET /health` returns `{ ok: true, service: 'notesd' }`. `POST /mcp` sits behind `loopbackOnly` (a DNS-rebinding guard), and `GET`/`DELETE /mcp` return 405 with `Allow: POST`. After those come `apiRoutes` (P6), `chatHistoryRoutes` (iteration 8 phase 7), `imageRoutes` (P5), `chatImageRoutes` (iteration 8 phase 3), `fileRoutes` (iteration 8 phase 4), `revealRoutes` (iteration 7; file and note reveal since iteration 8 phase 4), `captureRoutes` (iteration 8 phase 8) and `staticRoutes` (P6, last, because it owns the SPA fallback). Later phases fill the routers in `api.ts`, `images.ts` and `static.ts` and must not edit this file. `createApp` passes `options.chat` through to `apiRoutes` (stub when omitted) and always uses the 25 s heartbeat.

### src/http/sameOrigin.ts (iteration 7 phase 2)

```ts
function isLoopbackUrl(value: string): boolean                    // URL host is localhost, 127.0.0.1, [::1] or ::1; unparseable -> false
function isSameOrigin(originHeader: string | undefined, requestUrl: string): boolean   // Origin's origin === request URL's origin (scheme, host, port)
const sameOriginOnly: MiddlewareHandler                           // 403 { error: 'forbidden_origin' } unless loopback host AND same-origin Origin
```
Guard for endpoints only notesd's own page may call (purge in phase 4, reveal in phase 5). Since iteration 7 phase 4 it guards the two `DELETE /api/bin/...` purge routes in `api.ts`. A missing, empty, foreign or unparseable Origin, including the literal `null`, is refused. `app.ts` imports `isLoopbackUrl` from here for `loopbackOnly` instead of keeping its own copy.

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
| `GET /api/bin` | repeated `tag` (AND on the owning note) | `Bin` `{ notes, images }`, newest deleted first (iteration 7 phase 4) |
| `POST /api/notes/:id/restore` | | `Note`; no-op returning the note when it is live; 404 unknown, 400 non-id |
| `DELETE /api/bin/notes/:id` | `sameOriginOnly` | `PurgeResult`; 409 `not_deleted` for a live note, 403 `forbidden_origin` without the page's Origin |
| `DELETE /api/bin/images/:imageId` | `sameOriginOnly` | `PurgeResult`; 409 `not_deleted` for an image not removed from its note, 403 as above |
| `GET /api/tags` | | `TagCount[]` (bare array) |
| `GET /api/events` | | SSE, see below |
| `POST /api/chat` | `{ message?: string (trimmed, default ''), thread_id?: string (1..200), reply_to?: string (1..32, a message id in any spelling `normalizeMessageId` accepts; phase 7), image_ids?: string[] (0..4, each 1..16, default []) }`; text or at least one image required | SSE, see below |

`/api/events` opens with a `: connected` comment, then sends `event: note` with data `{ op, id }` for every `NoteEvents` emit (`created`/`updated`/`deleted`/`restored`/`purged`), and (iteration 8 phase 7) `event: chat` with data `{ op, thread_id, id }` for every `ChatEvents` emit (`created`/`updated`/`deleted`/`restored`; `id` is the message id), plus a `: heartbeat` comment every `sseHeartbeatMs`. On client abort it clears the timer and unsubscribes from both buses.

`/api/chat` (rewritten in iteration 8 phase 7) validates the body before streaming (bad input is a plain 400 JSON, not SSE; a malformed `reply_to` is 400 `invalid_reply_to`). It resolves `image_ids` with `resolveTurnImages` (deduped, request order, each `preview` derivative generated) still before the stream opens; a `ChatImageLookupError` answers JSON `{ error, id, message }` with 400 `unknown_image`, 409 `not_on_this_machine` or 422 `unreadable_image`. It then writes the user row with `ChatService.addUserMessage({ threadId: thread_id ?? null, source: 'wall', text, attachments: chat_image refs, replyTo })`; an unknown `thread_id` (e.g. an SDK session id from before phase 7) or one of another source starts a new thread, and a `ChatError` maps through `chatErrorResponse` (404 `reply_not_found` for a missing or deleted target). Nothing is written before validation passes. The stream then sends `event: accepted` `{ thread_id, user_message_id }`, builds the turn with `composeWallTurn` (context from our rows plus current and reply-target images) and calls `backend.reply({ turn, signal })`. Each `delta` passes through a `CitationFilter` (a leading `[msg:ID]`, even split across deltas, is held back and stripped; a `status` event flushes held non-whitespace text first), then goes out as `event: delta { text }`; `status` goes out as `event: status { text }` (`""` clears it). On a clean finish it releases any held tail, checks the cited id (must be live and not the user message itself, else dropped silently), writes the assistant row with `addAssistantMessage({ threadId, text: citation.text, brain, replyTo })` and sends `event: done` with `{ thread_id, user_message_id, assistant_message_id, reply_to: string | null, brain? }` (`thread_id` is OUR `chat_threads.id`; `brain` omitted when the backend reports none, as the stub does). A throw from composing, `reply()` or `events` becomes `event: error` with `{ error }` and the user row stays. A client disconnect aborts the `signal`, nothing more is written, and no assistant row is persisted.

### src/chat/backend.ts, src/chat/stub.ts

```ts
type ChatBrain = 'claude' | 'glm'
type ChatEvent = { type: 'delta'; text: string } | { type: 'status'; text: string }
interface ChatTurnEnd { brain?: ChatBrain }                     // -> done.brain (thread id is ours since iteration 8 phase 7)
interface ChatTurnImage {                                       // iteration 8 phase 3; resolved by api.ts from image_ids
  id: string                                                    // chat_images.id; the model sees `[image upload:ID]`
  previewPath: string; previewMime: 'image/jpeg'                // absolute cache/c_<id>/preview.jpg (long edge <= 1568 px)
  width: number; height: number; originalName: string | null    // of the original
  messageId?: string                                            // phase 7: owning chat message; label reads `[image upload:ID] from [msg:K7F2]`
}
interface ComposedTurn { text: string; images: readonly ChatTurnImage[] }   // phase 7: context.ts layout; current-turn images, then reply-target images
interface ChatRequest { turn: ComposedTurn; signal: AbortSignal }           // phase 7: no message/threadId/resume; backends keep no conversation state
interface ChatTurn { events: AsyncIterable<ChatEvent>; end(): ChatTurnEnd }   // end() valid only after events finished without throwing
interface ChatBackend { reply(request: ChatRequest): Promise<ChatTurn> }

const STUB_REPLY = 'The chat brain arrives in iteration 4. Until then this panel only echoes that fact.'
interface StubChatOptions { delayMs?: number }          // per-delta delay, default 40; tests pass 0
function splitIntoDeltas(text: string): string[]        // word pieces keeping trailing whitespace
function createStubChatBackend(options?: StubChatOptions): ChatBackend
```
`ChatBackend` is the seam iteration 4 fills: `api.ts` is its only consumer, and the implementation arrives via `startDaemon(config, { chat })` -> `createApp` -> `ApiOptions.chat`. Implementations are the stub (tests) and the Agent SDK backend (`src/chat/agent.ts`, the default since iteration 4 phase 2). The stub ignores the turn text and streams `STUB_REPLY` word by word as `delta` events. It emits no `status` events and `end()` returns `{}` (no brain; since iteration 8 phase 7 it no longer mints a `stub-<uuid>` thread id, since the route owns thread ids). It stops yielding as soon as `signal` aborts, including mid-delay.

### src/chat/agent.ts, src/chat/env.ts, src/chat/prompt.ts, src/chat/status.ts (iteration 4 phase 2)

```ts
// agent.ts
type AgentChatConfig = Config['chat']
type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>   // slice of the SDK's query; a turn with images passes a one-message stream
interface AgentChatOptions {
  chat: AgentChatConfig; cwd: string; mcpUrl: () => string;
  query?: QueryFn; now?: () => Date; baseEnv?: NodeJS.ProcessEnv; log?: (line: string) => void
  readPreview?: (absPath: string) => Promise<Uint8Array>   // iteration 8 phase 3; default fs.readFile
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
const NOTES_TOOL_NAMES: readonly [18 names from mcp/tools + mcp/imageTools + mcp/similarTools]   // 14 -> 17 in iteration 7 phase 3: attach_image, remove_image, restore_image; 18 in iteration 8 phase 6: similar_images
type NotesToolName
const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch']
const CONNECTOR_CAPTIONS: Record<SystemId, string>                     // from SYSTEM_META[id].caption: 'reading expenses' / 'reading runs' / 'reading seer'
function allowedChatTools(): string[]                                  // mcp__notes__<name> x18 + mcp__notes__<connector> x15 (ALL_CONNECTOR_TOOL_NAMES) + WebSearch, WebFetch
function captionForToolUse(name: string, input: unknown): string | null
```
`createAgentChatBackend` runs one stateless SDK `query` per `reply()` (since iteration 8 phase 7: no `resume`, `persistSession: false`, so nothing is written under `~/.claude/projects`; continuity comes only from `request.turn.text`, which claude and the GLM fallback both get verbatim). Its `prompt` comes from `toSdkPrompt(composeUserTurn({ message: turn.text, images: turn.images }, previews))` (`src/chat/compose.ts`), built once per run: the plain string for a turn without images, else a one-message stream whose content is one base64 image block per pasted image (its `preview` file read once per run through `readPreview`, so the GLM retry reuses it) followed by the text block; a preview that cannot be read fails the turn with `Could not read pasted image <id>: ...` and no fallback. Every run gets: `cwd` (`<dataDir>/chat`), `settingSources: []`, `strictMcpConfig: true`, one MCP server `notes` of type `http` at `mcpUrl()` (read at run start, with `alwaysLoad`), built-in `tools` limited to WebSearch/WebFetch, `allowedTools` from `allowedChatTools()`, `permissionMode: 'dontAsk'`, `includePartialMessages`, `maxTurns: chat.maxTurns`, a fresh `buildChatSystemPrompt(now())` as the whole system prompt, `persistSession: false` (phase 7; `resume` is never set), and `pathToClaudeCodeExecutable` from `resolveExecutable(chat.claudeBin, PATH)` (resolved once at construction). A Claude run uses `claudeEnv` (the daemon env minus every key, base URL, model override and parent-Claude-Code marker, so it runs on the owner's OAuth login; `CLAUDE_CONFIG_DIR` is kept). A GLM run uses `glmEnv` (same base plus `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL`/`DEFAULT_*_MODEL` from `chat.glm`) and `model: glm.model`.

Streaming: only top-level messages count (`parent_tool_use_id === null`). `stream_event` `text_delta`s become `delta` events. A top-level assistant `tool_use` block becomes a `status` caption from `captionForToolUse` (`searching notes`, `finding related notes`, `finding similar photos`, `reading 3 notes`, `looking at a photo`, `attaching a photo`, `removing a photo`, `restoring a photo`, `searching the web`, `saving a note`, ...; any of a system's connector tools from `CONNECTOR_TOOL_NAMES` gives that system's `CONNECTOR_CAPTIONS` entry, an unknown `mcp__notes__*` name gives null; repeats are not re-sent), and the next text clears it with `status ""`. Text that follows a tool use after earlier text is prefixed with a blank line (leading whitespace trimmed). A `result` of subtype `success` without `is_error` sets `end()` to `{ brain }` (since iteration 8 phase 7 the SDK `session_id` is ignored; the thread id is `chat_threads.id`).

Guardrails: one run in flight per backend (a new `reply()` stops the previous one, `superseded`); the request `signal` (`client`), a `chat.timeoutMs` wall-clock timer (`timeout`, unref'd) and `close()` (`closed`, called by daemon `stop()`) all abort the SDK child. A stopped run throws `Chat stopped: ...` from `events`. `error_max_turns` throws `Chat stopped: the agent hit its N-turn cap ...` and never falls back.

Fallback: with `chat.brain = 'claude'` and `chat.glm` set, a Claude attempt that fails before any `delta` went out, was not stopped, and whose failure is fallbackable (an assistant `error` in `FALLBACK_ERRORS`, or result/exception text matching `FALLBACK_TEXT`) is retried once on GLM with the identical composed turn (before phase 7: the same `resume` id); a shown caption is cleared first and one line is logged (`notesd chat: claude failed before answering (...); retrying once on glm`). Once text has streamed a failure is final. `chat.brain = 'glm'` runs GLM only and never falls back; with `glm` null it fails with `CHAT_BRAIN=glm needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.` A CLI that exits non-zero after a successful result is treated as success.

The system prompt states today's weekday, ISO and long date, time and timezone; says the owner is the only user; requires every used note id quoted as `A-B32` (the panel highlights by id); allows edits only when asked (get before update, never save the answer as a note); explains `view_images`; and asks for plain prose (no headings, tables, bold or code blocks unless asked). Iteration 5 phase 5 added the three read-only apps (expense-tracking `expenses_*`, run-insights `runs_*`, Seer and Sera `seer_*`) with curated tools first, `_schema` before writing SQL and `_sql` last; dates for the apps' tools as YYYY-MM-DD in the daemon timezone; data answers that say what the data shows plus an opinion (patterns, comparison with the previous period, what stands out, one concrete suggestion, the dates looked at) in the apps' units (Rp 38.500 whole rupiah, km, m:ss /km, bpm, Seer in USD); and, when an app's tool errors, naming the app instead of guessing its numbers. Iteration 8 phase 7 added two paragraphs: the turn layout (`<chat_history>` oldest first, with the `[earlier messages omitted]` line when trimmed; `<reply_to>`; `<message>` is what to answer; one `[msg:ID] role (YYYY-MM-DD HH:mm WIB): ...` line per message; only answer text of earlier turns is visible, so call tools again; pictures of the current and replied-to message are visible, earlier ones only as `[image upload:ID]`), and the optional reply marker: start the answer with `[msg:ID] ` to reply to one specific earlier message, never the current one, never invented, no labels elsewhere.

### Chat images: src/chat/images.ts, src/chat/compose.ts, src/http/chatImages.ts (iteration 8 phase 3)

```ts
// images.ts
const CHAT_IMAGES_SUBDIR = 'chat-images'
const MAX_CHAT_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_CHAT_IMAGES_PER_MESSAGE = 4
interface ChatImageStoreDeps { db: Db; dataDir: string; hostname?; now?; random? }
function chatImageStoreFor(app: AppDeps): ChatImageStoreDeps          // no AppDeps field: deps.db + config.dataDir
function chatImageRelPath(id, ext, savedAt: Date): string             // 'chat-images/YYYY/MM/<id>.<ext>', local time
function chatImageCacheId(id): string                                 // 'c_<id>' -> cache/c_<id>/
type ChatImageVariant = 'original' | 'display' | 'thumb' | 'preview'
function chatImageUrl(id, variant): string                            // /api/chat/images/<id>/<variant>
interface ChatImage { id; mime; width; height; bytes; original_name; host; source: ChatImageSource; created_at; available: boolean; urls: Record<ChatImageVariant, string> }
function toChatImage(row: ChatImageRow, available: boolean): ChatImage
class ChatImageInputError extends Error { code: 'not_an_image' | 'too_large' }                      // HTTP 415 / 413
class ChatImageLookupError extends Error { code: 'unknown_image' | 'not_on_this_machine' | 'unreadable_image'; imageId }   // HTTP 400 / 409 / 422
function findChatImage(db, id): Promise<ChatImageRow | null>
function ingestChatImage(deps, { bytes, originalName, source, maxBytes? }): Promise<{ image: ChatImage; created: boolean }>
function locateChatImage(deps, rawId): Promise<{ row; source: ImageSource; available } | null>   // source.id is the c_<id> cache key
function resolveTurnImages(deps, rawIds): Promise<ChatTurnImage[]>    // deduped, request order, preview generated

// compose.ts (pure)
function uploadTag(id): string                                        // '[image upload:<id>]'
function composePromptText(message, imageIds): string                 // message, blank line, header + one uploadTag line per image; text-only unchanged
function imageLabel(image: { id; messageId? }): string               // phase 7: uploadTag, plus ' from [msg:ID]' when messageId is set
function composeLabelledText(message, images): string                 // phase 7: message + 'The picture(s) shown above ...' + one imageLabel per image
function composeUserTurn(input: { message; images }, previews: string[]): UserTurn   // previews = base64, same length as images or throws; uses composeLabelledText when any image has messageId
function userTurnContent(turn): UserContentBlock[]                    // image blocks in paste order, then the text block
function toSdkPrompt(turn): string | AsyncIterable<SDKUserMessage>    // string when no images; else a fresh one-message stream

// http/chatImages.ts
interface ChatImageRouteOptions { maxUploadBytes?: number }           // default MAX_CHAT_IMAGE_BYTES
function chatImageRoutes(deps: AppDeps, opts?): Hono
```
`ingestChatImage` refuses an empty file (`not_an_image`) or one over the cap, hashes the bytes and serialises same-sha ingests in-process. Known bytes return the existing row (`created: false`, the first upload's `source` kept) and, when that original is missing on this machine, write the identical bytes back to the row's path (heal). New bytes are probed by magic bytes (`probeImage`), written with `writeNewFile` to `chat-images/YYYY/MM/<id>.<ext>`, then inserted with `onConflictDoNothing`; a lost race (same sha from another process or host) removes this file and returns the winner. `resolveTurnImages` throws `ChatImageLookupError` for an unknown id, an original that is not here (names `row.host`), or a preview that cannot be made.

| route | input | success / errors |
|---|---|---|
| `POST /api/chat/images` | multipart `file`, optional `source` (`wall` default \| `claude_code`) | 201 `{ image, created: true }`, 200 `{ image, created: false }` for known bytes; 400 `bad_multipart` / `file_required` / `invalid_source`, 413 `too_large` (body limit = cap + 1 MB), 415 `not_an_image` |
| `GET /api/chat/images/:id` | any id spelling | wire `ChatImage`; 404 `not_found` |
| `GET /api/chat/images/:id/{original,display,thumb,preview}` | | the file; derivatives made lazily into `cache/c_<id>/`; 404 `not_found` or `{ error: 'not_on_this_machine', host }` |

Files are served like note images: sha256 ETag (`"<sha>"` for the original, `"<sha>-<variant>"` otherwise) with 304 on `If-None-Match`, `private, max-age=31536000, immutable` for originals and `private, max-age=86400` for derivatives, `nosniff`, a sandboxing CSP, and an inline `Content-Disposition` with the original name when the original is served. No guard beyond the loopback host the daemon binds.

### Chat history: src/chat/{ids,types,events,repo,service,context,turn,citation}.ts, src/http/chatApi.ts (iteration 8 phase 7)

```ts
// ids.ts
const MESSAGE_ID_PATTERN = /^[0-9A-Z]{4}$/                         // 36^4 ids; ChatService retries up to 20 times on a PK clash
function generateMessageId(random?: (max) => number): string
function isMessageId(value): boolean
function normalizeMessageId(input): string | null                  // 'k7f2', 'msg:K7F2', '[msg:k7f2]', ' K7F2 ' -> 'K7F2'
function messageLabel(id): string                                  // '[msg:K7F2]'

// types.ts (wire shapes; every timestamp UTC ISO)
interface AttachmentRef { kind: ChatAttachmentKind; id: string }
interface ChatAttachmentView { kind; id; url; thumb_url: string | null }   // chat_image -> /api/chat/images/<id>/{display,thumb}; note_image -> /api/images/<id>/{display,thumb}; note_file -> /api/files/<id>/download, thumb null
interface ChatReplyPreview { id; role: ChatRole | null; text; deleted: boolean }   // text = snippet (140 chars) or '' when deleted/vanished
interface ChatMessageView { id; thread_id; role; text; source; brain; reply_to: ChatReplyPreview | null; created_at; edited_at; deleted_at; attachments }
interface ChatThreadView { id; source; brain; created_at; updated_at }
interface ChatThreadDetail { thread; messages }                    // ascending (created_at, seq)
interface ChatTimelinePage { messages; next_before: string | null }   // ascending; next_before pages older
type ChatErrorCode = 'invalid_id' | 'not_found' | 'thread_not_found' | 'reply_not_found' | 'not_editable' | 'empty_text' | 'invalid_cursor' | 'conflict'
class ChatError extends Error { code: ChatErrorCode }
const REPLY_SNIPPET_CHARS = 140; function snippet(text, max?): string
function attachmentView(ref), toThreadView(row), toMessageView(row, attachments, target)

// events.ts
type ChatOp = 'created' | 'updated' | 'deleted' | 'restored'
interface ChatChange { type: 'chat'; op; thread_id; id }           // id = message id
class ChatEvents { emit(op, threadId, id); on(listener): () => void; listenerCount() }

// service.ts
const DEFAULT_TIMELINE_LIMIT = 50, MAX_TIMELINE_LIMIT = 200
interface ChatServiceDeps { db: Db; events?: ChatEvents; now?: () => Date; random?: (max) => number }
class ChatService {
  readonly events: ChatEvents
  requireMessageId(input): string                                   // or ChatError invalid_id
  createThread({ source, brain?, externalKey?, createdAt? }): Promise<ChatThreadView>
  addUserMessage({ threadId, source, text, attachments?, replyTo?, createdAt? }): Promise<UserTurnStart>   // { thread, message, threadCreated }
  addAssistantMessage({ threadId, text, brain, replyTo?, createdAt? }): Promise<ChatMessageView>
  editMessage(id, text): Promise<ChatMessageView>
  deleteMessage(id, { withAnswer? }): Promise<{ deleted: string[] }>
  restoreMessage(id): Promise<ChatMessageView>
  listTimeline({ before?, limit?, includeDeleted? }): Promise<ChatTimelinePage>
  getThread(id, { includeDeleted? }): Promise<ChatThreadDetail | null>
  getMessage(id, { includeDeleted? }): Promise<ChatMessageView | null>
  listRevisions(id): Promise<Array<{ text; saved_at }>>              // newest first
  liveMessageExists(id): Promise<boolean>
  loadTurnContext(threadId, currentMessageId): Promise<TurnContextInput>
  recordExchange({ source, externalKey, brain?, user: { text, createdAt, attachments? }, assistant: { text, createdAt } | null }): Promise<RecordedExchange>   // { created, thread, messageIds }
}

// context.ts (pure)
const CONTEXT_CHAR_BUDGET = 24_000, CONTEXT_LINE_CHAR_CAP = 4_000, OMITTED_LINE = '[earlier messages omitted]', CHAT_TIME_ZONE = 'Asia/Jakarta'
interface ContextMessage { id; role; text; createdAt: Date; attachments: readonly AttachmentRef[] }
interface TurnContextInput { history; current; replyTarget: ContextMessage | null; budgetChars? }
interface TurnContext { text; images: Array<{ id; messageId }>; omitted: number }
function formatWib(date): string                                   // '2026-10-31 09:15 WIB'
function attachmentLabel(ref): string                              // [image upload:ID] | [note image:ID] | [note file:ID]
function renderMessageLine(message, cap?: number | null): string   // '[msg:ID] role (… WIB): text <labels>'
function buildTurnContext(input): TurnContext

// turn.ts
function composeWallTurn(chat: ChatService, source: { db; dataDir }, { threadId, currentMessageId, currentImages }): Promise<ComposedTurn>

// citation.ts
const CITATION_LOOKAHEAD = 16
function parseLeadingCitation(text): { replyTo: string | null; text: string }
class CitationFilter { push(chunk): string; flush(): string; end(): string; get replyTo(): string | null; get text(): string }

// http/chatApi.ts
function chatErrorResponse(c, err): Response                       // non-ChatError rethrown (500)
function chatHistoryRoutes(deps: AppDeps): Hono
```

`ChatService` is the only writer of the four chat tables. Every write is one transaction that locks the thread or message row (`for update`) first, and `ChatEvents` fire after commit. `addUserMessage` refuses `text === ''` with no attachments (`empty_text`); continues the given thread only when it exists and has the same `source` (otherwise creates a new UUID thread); refuses a `replyTo` that is missing or deleted (`reply_not_found`, nothing written); inserts the row with a fresh id, its attachments in order, and bumps `updated_at`. `addAssistantMessage` needs an existing thread (`thread_not_found`), drops a reply target that is gone by now, and sets the thread's `brain`. `editMessage` trims, refuses blank text, touches user rows only (`not_editable`), writes the old text to `chat_message_revisions` and sets `edited_at`; the same text is a no-op without an event; the answer is never regenerated. `deleteMessage` soft-deletes; with `withAnswer` on a user row it also deletes the assistant row that directly follows it in the thread (by `(created_at, seq)`), and returns only the ids it changed. `restoreMessage` on a live row is a no-op that returns it. `listTimeline` reads every thread and source newest-first by `(created_at, seq)`, fetches `limit + 1` to know whether there is more, returns the page ascending, and `next_before` is a base64url cursor of the oldest row's exact microsecond `created_at` text plus `seq` (an unparseable cursor is `invalid_cursor`). `loadTurnContext` takes the thread's live rows before the current message (edited text, deleted left out), the current row, and its live reply target from any thread. `recordExchange` (for phase 8 capture) writes one single-turn thread per trimmed `externalKey`; a replay or a lost race on the unique key writes nothing and returns `created: false` with the existing thread.

`buildTurnContext` keeps the newest history lines that fit `budgetChars` (each line capped at 4,000 chars with ` [cut]`; the current message is never cut), prefixing `[earlier messages omitted]` when any were dropped. The reply target is rendered in `<reply_to>`, or as `The owner is replying to [msg:ID] above.` when it is already in the kept history. `<chat_history>`, `<reply_to>` and `<message>` tags inside message text are neutralised to `‹…›`. Images to send are the current message's chat images, then the reply target's, deduped; `composeWallTurn` resolves the reply target's images with `resolveTurnImages` and leaves any that fail (not on this machine, unreadable) as labels only.

`CitationFilter` holds back the start of the answer while it could still be `[msg:XXXX]` (up to 16 chars, leading whitespace ignored), strips a complete marker and the whitespace after it, and releases anything else at once; `flush()` (on a status event) releases held text unless it is only whitespace; `end()` releases the rest. The cited id is only syntactically checked; the route checks it is live.

| route (chatApi.ts) | input | success / errors |
|---|---|---|
| `GET /api/chat/messages` | `before?` (cursor), `limit` (1..200, default 50), `include_deleted` (`0`/`1`/`true`/`false`) | `ChatTimelinePage`; 400 bad query or `invalid_cursor` |
| `GET /api/chat/threads/:id` | `include_deleted?` | `ChatThreadDetail`; 404 `not_found` |
| `PATCH /api/chat/messages/:id` | `sameOriginOnly`; `{ text }` | `ChatMessageView`; 400 `invalid_json` / `invalid_id` / `empty_text` / `not_editable`, 404 `not_found`, 403 `forbidden_origin` |
| `DELETE /api/chat/messages/:id` | `sameOriginOnly`; `with_answer?` | `{ deleted: string[] }`; 404 `not_found` |
| `POST /api/chat/messages/:id/restore` | `sameOriginOnly` | `ChatMessageView`; 404 `not_found` |

`chatErrorResponse` maps `not_found` / `thread_not_found` / `reply_not_found` to 404, `conflict` to 409, the rest to 400; it is shared with `POST /api/chat`.

### Claude Code capture: src/chat/capture.ts, src/http/capture.ts, claude/hooks/, scripts/claude-hooks.mjs (iteration 8 phase 8)

```ts
// src/chat/capture.ts
const MAX_CAPTURED_IMAGE_BYTES = 20 * 1024 * 1024, CAPTURE_SOURCE = 'claude_code'
interface ClaudeCodeCaptureInput { claudeSession; userUuid; prompt; answer /* '' = no assistant row */; promptAt: Date; answeredAt: Date; images: { mediaType; bytes: Buffer }[] }
interface CaptureResult { duplicate: boolean; threadId; userMessageId; assistantMessageId: string | null }
class CaptureImageError extends Error { index: number; code: string }   // from ChatImageInputError
function captureExternalKey(claudeSession, userUuid): string           // '<session>:<user uuid>'
function captureClaudeCodeExchange(deps: AppDeps, input): Promise<CaptureResult>

// src/http/capture.ts
const CAPTURE_PATH = '/api/capture/claude-code', CAPTURE_HEADER = 'x-notes-capture'
const MAX_CAPTURE_BODY_BYTES = 64 MB, MAX_CAPTURE_IMAGES = 8, MAX_CAPTURE_IMAGE_BYTES = 20 MB, MAX_PROMPT_CHARS = 200_000, MAX_ANSWER_CHARS = 1_000_000
const CAPTURE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
function decodeImageBase64(data): Buffer | null                        // strict standard base64, whitespace ignored
const captureGuard: MiddlewareHandler
function captureRoutes(deps: AppDeps): Hono
```
`captureClaudeCodeExchange` ingests each image into the phase 3 chat image store (`source: 'claude_code'`, sha-deduped, so a replay stores nothing new; outside the DB transaction because it writes files), then calls `ChatService.recordExchange` with `source: 'claude_code'`, `brain: null`, the images as `chat_image` attachments on the user row, and an assistant row only when the answer is non-blank. An `answeredAt` not after `promptAt` is clamped to `promptAt + 1 ms`.

| route | input | success / errors |
|---|---|---|
| `POST /api/capture/claude-code` | `captureGuard`; JSON `{ claude_session, user_uuid, prompt (non-blank), answer, prompt_timestamp, answered_at (ISO with Z or offset), cwd? (accepted, not stored), images?: [{ media_type, data_base64 }] (<= 8) }` | 201 `{ thread_id, user_message_id, assistant_message_id }`; 200 `{ duplicate: true, ... }` for a known `<claude_session>:<user_uuid>` (nothing written); 400 `invalid_json` / validation text / `invalid_base64` with `index`; 403 `forbidden_host` / `forbidden_origin` / `capture_header_required`; 413 `too_large` / `image_too_large`; 415 `json_required` / `unsupported_image` |

`captureGuard` requires a loopback request URL (DNS-rebinding guard, as `/mcp`), no Origin or a loopback one, `X-Notes-Capture: 1` (a browser cannot send it cross-origin without a preflight notesd never answers) and `Content-Type: application/json`. It is not `sameOriginOnly`: the caller is a local Node process with no Origin.

Hooks (`claude/hooks/`, plain Node >= 22 ESM with built-ins only, `.d.mts` types for the tests; both always exit 0):

- `notes-capture.mjs` (Stop, `async: true`, 60 s timeout). `runCapture` reads `transcript_path`, polling every 250 ms for up to 3 s until the turn found by `findTurn` contains the start of `last_assistant_message` (`turnSettled`). If the turn's prompt `isNotesPrompt` (`/n` typed, or the `<command-name>/n</command-name>` form), `buildPayload` uses the hook's `session_id` (else the entry's `sessionId`), the prompt entry's `uuid`, `promptText` (the typed `/n ...`), the final message as answer, and up to 8 images (allowed types, <= 20 MB each, <= 48 MB of base64 in all). The payload is spooled atomically (0600) to `<stateDir>/outbox/<user uuid>.json`, then `drainOutbox` retries older files oldest first (at most 20 attempts per run, stopping at the first network error / 5xx / 429 / 404 / 405, dropping other 4xx, unreadable files and files older than 14 days), then the new payload is delivered (10 s timeout) and removed on 2xx. Nothing is written to stdout/stderr; problems go to `<stateDir>/capture.log`.
- `notes-paste.mjs` (PreToolUse, matcher `mcp__notes__similar_images`, 30 s timeout). `runPaste` acts only when `tool_input.pasted_image` is a positive integer (or digit string). `findPastedImage` takes the latest human prompt carrying images (`findLatestImagePrompt`, one re-read after 500 ms if the transcript lags) and `pickPastedImage` picks image N by `imagePasteIds`, else block order. `uploadImage` posts it as multipart to `POST /api/chat/images` with `source=claude_code` (15 s timeout) and reads the `A-B32` id from `image.id` / `id` / `upload_id`. Output: `updatedInput` strategy (default) is `permissionDecision: 'allow'` with `updatedInput` = the input minus `pasted_image` plus `upload_id`; `deny` strategy (`NOTES_PASTE_STRATEGY=deny`) denies with a reason giving the model the exact arguments to call again with. No image or a failed upload allows the call unchanged (the server then answers `PASTED_IMAGE_NEEDS_HOOK`); other tools or calls without `pasted_image` print nothing. Problems go to `<stateDir>/paste.log`.
- `lib/state.mjs`: `stateDir(env)` is `${XDG_STATE_HOME:-$HOME/.local/state}/notes-capture` (relative `XDG_STATE_HOME` ignored); `daemonBaseUrl(env)` is `http://127.0.0.1:${NOTESD_PORT or 7317}`; `writeLog` appends one timestamped line, rotating to `.1` past 1 MB, never throws.
- `lib/transcript.mjs`: pure readers for Claude Code 2.1.x JSONL. `isHumanPrompt` excludes tool results, `isMeta` (the skill body after `/n`), sidechains, compact summaries and non-human origins; torn lines are skipped.

`scripts/claude-hooks.mjs install --settings FILE --node /abs/node --hooks-dir DIR [--paste-strategy updatedInput|deny]` / `uninstall --settings FILE` / `status --settings FILE`. Our handlers are recognised by the script name in their `command` (`OUR_SCRIPT`), so `mergeHooks` first strips any entry from another checkout, then adds one `Stop` group and one `PreToolUse` group (commands single-quoted with `shQuote`; the deny strategy bakes `NOTES_PASTE_STRATEGY='deny'` into the paste command only). Every other key and hook is kept; `removeHooks` drops only our handlers (and groups left empty). Install is idempotent (second run byte-identical); invalid JSON is refused and left alone; the first change to an existing file keeps a copy at `FILE.bak-notes-hooks` (never overwritten); writes are atomic on the symlink target and keep the mode (a new file is 0600).

### Note files: src/files/, src/http/files.ts, reveal (iteration 8 phase 4)

```ts
// files/name.ts (pure)
const MAX_FILE_NAME_CHARS = 120, MAX_FILE_NAME_BYTES = 240, FALLBACK_FILE_NAME = 'file'
function sanitizeFileName(raw): string          // basename, NFC, no control chars, `/\:*?"<>|` -> `_`, trailing dots/spaces dropped, CON/PRN/AUX/NUL/COMn/LPTn prefixed `_`, length-capped keeping the extension
function displayFileName(raw, safeName): string // user's basename, NFC, control chars removed, <= 255 code points; falls back to safeName
function withNameSuffix(name, k): string        // k <= 1 -> name, else `stem (k).ext`
function isSafeFileName(name): boolean
// files/mime.ts
const FALLBACK_MIME = 'application/octet-stream'; const EXTENSION_MIMES   // text-like formats only; no raster image extensions
function detectFileMime(bytes, name): Promise<string>   // file-type magic bytes, then extension, else FALLBACK_MIME
function isValidMime(mime): boolean
// files/store.ts
const FILES_SUBDIR = 'files'
function fileRelPath(noteId, safeName): string  // 'files/<noteId>/<safeName>'; throws on a bad id or name
function isNoteFileRelPath(noteId, rel): boolean
function filesDirFor(dataDir, noteId): string   // absolute folder the note-level reveal opens
function removeNoteFile(dataDir, noteId, rel): Promise<number>        // 1 removed, 0 missing/refused
function removeNoteFolderIfEmpty(dataDir, noteId): Promise<boolean>
// files/records.ts
interface FileRecords { bySha256Live(sha); byFileId(id); pathTaken(rel) }; function dbFileRecords(db): FileRecords
// files/ingest.ts
const MAX_FILE_BYTES = 200 MB, MAX_NAME_SUFFIX = 999
class FileInputError extends Error { code: 'empty_file' | 'too_large' }
type FileNotes = Pick<NotesService, 'getOne' | 'restore' | 'newId' | 'attachFile'>
function fileDeps(app: AppDeps): FileDeps; function uploadDeps(app): UploadDeps   // { files, images: AttachDeps }
function attachFile(deps, noteId, input: FileInput): Promise<{ note; attached }>
function attachUpload(deps: UploadDeps, noteId, file: File, maxBytes): Promise<{ note; attached; kind: 'file' | 'image' }>
function locateFile(deps, fileId): Promise<LocatedFile | null>      // any state; satisfies RevealTarget
// http/files.ts
interface FileRouteOptions { maxUploadBytes?: number }; const DOWNLOAD_CSP = "default-src 'none'; sandbox"
function attachmentDisposition(name): string   // attachment; ASCII filename= fallback + RFC 5987 filename*=
function fileRoutes(deps: AppDeps, opts?): Hono
// http/reveal.ts
type RevealMode = 'select' | 'open'; function explorerArgs(winPath, mode = 'select'): string[]   // ['/select,<p>'] or [<folder>]
function performReveal(target, reveal, mode = 'select'): Promise<RevealOutcome>
function noteRevealPlan(dataDir, img, note): Promise<{ target: RevealTarget | null; mode: RevealMode }>
```
`attachFile` checks the note is live (nothing written otherwise), refuses empty bytes, then under an in-process sha lock: a live file with the same sha256 anywhere returns its note (restored if deleted; bytes rewritten here when this host lacks them) with `attached: false`. Otherwise it sanitizes the name, detects the mime, takes `newId()`, picks the first `files/<noteId>/<name>` free on disk and in every row (`name (2).ext` ... up to 999), writes the bytes, then calls `NotesService.attachFile`; on failure the bytes are removed, `duplicate_file` returns the concurrent winner and `conflict` retries. `attachUpload` (HTTP only) sends bytes that sniff as a supported image to `attachImage` (`kind: 'image'`, they land in `note.images`), falling back to a file when the image probe refuses them.

| route | input | success / errors |
|---|---|---|
| `POST /api/notes/:id/files` | multipart `file` | 201 `{ note, attached: true, kind }`, 200 with `attached: false`; 400 `invalid_id` / `bad_multipart` / `file_required` / `empty_file`, 404 `not_found` (unknown or deleted note), 413 `too_large` with `max_bytes` (bodyLimit = cap + 1 MB) |
| `DELETE /api/files/:fileId` | any id spelling | 200 the owning `Note` (soft, idempotent) |
| `POST /api/files/:fileId/restore` | | 200 the owning `Note`; 409 `{ error: 'duplicate_file', note_id, message }` |
| `GET /api/files/:fileId` | | `NoteFile` JSON in any state (removed carries `deleted_at`); 404 `not_found` |
| `GET /api/files/:fileId/download` | | the bytes, always `Content-Disposition: attachment`, `nosniff`, `DOWNLOAD_CSP`, sha256 ETag (304), `private, max-age=31536000, immutable`; 404 `not_found` or `{ error: 'not_on_this_machine', host }` |
| `POST /api/files/:fileId/reveal` | `sameOriginOnly` | 202; Explorer with the file selected |
| `POST /api/notes/:id/reveal` | `sameOriginOnly` | 202; `noteRevealPlan`: a note with live files opens `files/<noteId>/` (available when any live file is local, else `not_on_this_machine` with the first file's host); no files selects the first live image; neither, or a missing/deleted note, 404 `not_found` |

Write routes map errors like the image routes (`not_found`/`deleted` 404, `invalid_id` 400, `duplicate_file`/`duplicate_image` 409 with `note_id`, `conflict` 409). Only the reveal routes are behind `sameOriginOnly`.

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

Image notes are ordinary notes with one or more `note_images` rows (iteration 7 phase 2; before that, `image_path` and `image_meta` on the note). All note writes still go through `NotesService`. The image modules only place files and read raw image fields. Phase 5 reaches them through `src/http/imageAccess.ts` (`imageDeps`/`toolImageDeps`, `ingestImage`, `locateImage` and the derive getters).

`startBackground` (in `src/background.ts`) builds `imageDeps(deps)` and runs `images/store.ensureDataDirs`, which is idempotent (tests call it without `startDaemon`). It then starts the inbox watcher with `ingest = ingestImage(img, { path, move: true, origin: { source: 'inbox' } })`. The stop function it returns closes the watcher and waits for the queue to drain. Since iteration 6 phase 3 it also starts `startEmbeddingWorker({ store: dbEmbeddingStore(deps.db), events: deps.events, embedder: deps.embedder })` when `deps.embedder` is set (logging `[notesd] embedding notes with <model>`), or logs once that embeddings are off when it is null; stop closes the inbox watcher first, then the worker.

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
type DataDirs = { root; images; cache; inbox; failed; chatImages }   // chatImages: <dataDir>/chat-images (iteration 8 phase 3)
function dataDirs(dataDir): DataDirs
function ensureDataDirs(dataDir): Promise<DataDirs>        // images/, cache/, inbox/failed/, chat-images/ (mkdir -p)
function chooseExt(originalName, mimeExt): string           // original's lower-cased ext if /^[a-z0-9]{1,8}$/, else the mime's
function originalRelPath(id, ext, savedAt: Date): string    // 'images/YYYY/MM/<id>.<ext>', local time of savedAt
function resolveInDataDir(dataDir, rel): string             // throws if the path escapes the data dir
function cacheDirFor(dataDir, id): string                   // <dataDir>/cache/<imageId>
function fileExists(p): Promise<boolean>; function removeQuietly(p): Promise<void>
class DestinationExistsError extends Error
function writeNewFile(dest, bytes): Promise<void>           // temp sibling + rename; never overwrites
function copyIntoNewFile(src, dest): Promise<void>
function moveIntoNewFile(src, dest, fs?: MoveFs): Promise<void>   // rename; on EXDEV copy, rename, unlink the source
function removeImageFiles(dataDir, image: { id; path }): Promise<number>   // iteration 7 phase 4: delete forever on disk; returns files removed
```
`removeImageFiles` unlinks the original only when `path` resolves strictly inside `<dataDir>/images/` and is a file or symlink, and removes `cache/<id>/` only when `id` is a single path segment. It returns 1 for the original plus one per cache entry; missing files count 0. It never touches anything else and leaves the `images/YYYY/MM` dirs in place.
This `ensureDataDirs` returns `DataDirs` and is separate from the one in `src/daemon.ts`.

#### src/images/derive.ts
```ts
const THUMB_WIDTH = 480, PREVIEW_LONG_EDGE = 1568, PREVIEW_MAX_BYTES = 3_750_000
type ImageSource = { id; mime; originalPath }               // id is the image id; originalPath is absolute
function derivativePaths(dataDir, id): { dir; thumb; preview; display }
class OriginalMissingError extends Error { readonly id }
function getDisplay(dataDir, src): Promise<{ path; mime }>  // the original if browser-displayable, else display.jpg (q92)
function getThumb(dataDir, src): Promise<string>            // thumb.webp, 480 px wide, never enlarged
function getPreview(dataDir, src): Promise<string>          // preview.jpg, long edge <= 1568, <= 3.75 MB
```
Derivatives are made on first request and cached under `cache/<id>/`. Each is written to a temp file and renamed into place, and concurrent callers for one output path share one in-flight promise. HEVC HEIC is decoded by `decodeHeicToJpeg`. Other types a browser cannot show (TIFF, non-HEVC HEIF) go through sharp. The preview steps JPEG quality down (85, 75, 65, 50, 35) until it fits `PREVIEW_MAX_BYTES`, so the base64 MCP payload stays under Claude's 5 MB image limit. It throws if no quality fits. Every getter throws `OriginalMissingError` when the original is not on this machine.

#### src/images/records.ts
```ts
type ImageRecord = { id; note_id; path; meta: ImageMeta; position: number; deleted_at: string | null; note_deleted_at: string | null }
interface ImageRecords {
  bySha256Live(sha256): Promise<ImageRecord | null>       // the image with these bytes and deleted_at null (at most one); its note may be deleted
  byImageId(id): Promise<ImageRecord | null>              // normalizeId; any state (removed, or in a deleted note)
  firstLiveImageOfNote(noteId): Promise<ImageRecord | null>   // lowest-position live image, whatever the note's state
}
function imageMetaOf(row: NoteImageRow): ImageMeta
function dbImageRecords(db: Db): ImageRecords
```
Read-only raw lookups over `note_images` joined to `notes.deleted_at`, which `NotesService` does not offer, since it hides deleted rows and returns the wire shape. `bySha256Live` goes through `imageRepo.findLiveImageBySha256`.

#### src/images/ingest.ts
```ts
type ImageNotes = Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>
type ImageDeps = { dataDir; notes: ImageNotes; records: ImageRecords; hostname?: () => string; now?: () => Date }
function imageDeps(app: AppDeps): ImageDeps
type IngestInput = { originalName?; body?; origin? } & ({ bytes } | { path; move? })
type IngestResult = { note: Note; created: boolean }
type AttachResult = { note: Note; attached: boolean }                       // iteration 7 phase 3; attached: false = bytes already live in `note`
type AttachNotes = ImageNotes & Pick<NotesService, 'attachImage'>           // separate so ImageNotes fakes stay valid
type AttachDeps = Omit<ImageDeps, 'notes'> & { notes: AttachNotes }
function attachDeps(app: AppDeps): AttachDeps
type LocatedImage = ImageSource & { noteId; position; relPath; available; host; imageDeleted; noteDeleted; deleted /* imageDeleted || noteDeleted */; meta: ImageMeta }
function ingestImage(deps, input): Promise<IngestResult>
function attachImage(deps: AttachDeps, noteId, input: IngestInput): Promise<AttachResult>
function locateImage(deps, imageId): Promise<LocatedImage | null>     // records.byImageId, any state
function locateNoteImage(deps, noteId): Promise<LocatedImage | null>  // records.firstLiveImageOfNote (the note alias)
```
`ingestImage` hashes the bytes and serialises on that sha256 within the process. A live image with the same bytes (`bySha256Live`) returns its holder note with `created: false`, restoring the note first when it is soft-deleted. A removed image (in the bin) does not count, so its bytes ingest as a new note. If the match's original is missing on this machine (it was ingested on another host), the same bytes are placed at the image's `path`. Otherwise it probes the bytes, picks the extension, writes the original byte for byte to `images/YYYY/MM/<id>.<ext>` and calls `notes.create({ id, image, allowEmpty: true })`, which writes the note and its first image (same id, position 0). When the insert fails, the file is removed, or moved back to its source when `move` was set. `duplicate_image` (a concurrent ingest) returns the winner, restoring its note if needed, and `conflict` retries with a new id, up to 5 attempts. With `move: true` the source is consumed on success, dedupe hits included. The image's `host` is `os.hostname()`, and `original_name` is the basename of `originalName` or of the source path.

`attachImage` (iteration 7 phase 3) first requires a live target note via `notes.getOne(id, { includeDeleted: true })` (unknown -> `NoteError('not_found')`, deleted -> `NoteError('deleted')`, nothing read or written). Then, under the same per-sha256 lock, a live image with these bytes anywhere (this note or another) returns its holder with `attached: false` through the same reuse path as ingest (restoring a deleted holder, re-placing a missing original), storing nothing. Otherwise it probes, takes a fresh id from `notes.newId()`, writes the original to `images/YYYY/MM/<imageId>.<ext>` and calls `notes.attachImage(target.id, { id, path, meta })` (`attached: true`). On failure the file is removed or moved back; `duplicate_image` returns the concurrent winner (`attached: false`) and `conflict` retries, up to `MAX_ID_ATTEMPTS`. `input.body` and `input.origin` are ignored: attaching never changes the note's text.

#### src/images/inbox.ts
```ts
type InboxWatcherOptions = { inboxDir; failedDir; ingest: (absPath) => Promise<IngestResult>; log?; stabilityThresholdMs? /*2000*/; pollIntervalMs? /*200*/ }
type InboxWatcher = { idle(): Promise<void>; close(): Promise<void> }
function isIgnoredInboxName(name): boolean    // dotfiles, '~$', .crdownload .part .partial .tmp .download .opdownload .!ut
function startInboxWatcher(opts): Promise<InboxWatcher>   // resolves after chokidar 'ready'
```
It watches the top level of the inbox only (depth 0, subdirectories ignored), including files already there at startup. A file is taken once its size and mtime hold still for the stability threshold. Files are handled one at a time in arrival order. Non-images are logged and left in place. A failed ingest moves the file to `inbox/failed/<name>`, or `<stem>-<epoch ms>[-n]<ext>` if that name is taken, and logs one `[inbox]` line. `idle()` resolves once every file seen so far is handled, and `close()` stops the watcher and drains the queue.

#### src/images/legacy.ts (iteration 7 phase 1)
```ts
const LEGACY_COPY_SQL: string                      // one idempotent INSERT...SELECT ... on conflict do nothing
function reconcileLegacyImages(db: Executor): Promise<number>   // rows inserted; 0 when every legacy image has its row
```
Copies every `notes` row (live or soft-deleted) with both `image_path` and `image_meta` set, and no `note_images` row whose id is the note id, into one row: id = note_id = `notes.id`, path = `image_path`, metadata from `image_meta` (`taken_at` cast to timestamptz), position 0, `created_at` = the note's. `deleted_at` is null unless that would break the live-sha256 index (an existing live row or an earlier candidate has the same sha256; candidates rank live notes first, then most recently deleted), in which case it is `coalesce(notes.deleted_at, now())`, so the image is kept and shows in the bin. Migration 0002 ends with this same statement. Since phase 2 (P1-NOTES-A024), `startBackground` calls `reconcileLegacyImages` once at daemon start to pick up images the old daemon ingested between the Neon migration and the restart.

### Embeddings: src/embeddings/ (iteration 6 phases 1-3, 5)

Storage, rules (phase 1), the embedder (phase 2), and the drain loop, worker and backfill CLI (phase 3) that fill `note_embeddings`. Hybrid search (phase 4, `src/search/` + `repo.searchCandidates`) reads it, and so does `related` (phase 5, `nearestNotes`). A null `Embedder` everywhere means semantic features are off (no `OPENROUTER_API_KEY`).

#### src/embeddings/constants.ts
```ts
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536        // must equal vector(1536) in schema.ts (unit test asserts)
const EMBEDDING_MAX_CHARS = 8_000        // UTF-16 units, run-insights' clamp
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings'
```
Mirrors `~/run-insights/lib/nina/embedding.ts` (read, never imported). A model or width change means a new migration plus a full re-embed.

#### src/embeddings/state.ts (pure, no I/O)
```ts
function bodySha256(body: string): string                 // hex sha256 of UTF-8; SQL twin is currentBodySha256Sql()
function embedInput(body: string): string | null           // trim, cut to EMBEDDING_MAX_CHARS, no marker; null if blank; never ends on half a surrogate
type EmbeddingState = 'current' | 'stale' | 'missing' | 'failed' | 'none'
interface StoredEmbedding { bodySha256; model; hasVector; attempts }
function embeddingState(body, stored: StoredEmbedding | null, model): EmbeddingState
function retryDelayMs(attempts: number): number            // 30 s doubling, capped at 1 h; <1/NaN treated as 1
function clampError(message: string): string               // redacts sk-or-... and Bearer tokens, collapses whitespace, <= 500 chars
```
`embeddingState`: `none` when blank; `missing` without a row; `stale` on another body hash or model (re-embed at once, no backoff); `failed` when the row for this body and model has no vector; else `current`.

#### src/embeddings/repo.ts
```ts
function currentBodySha256Sql(): SQL                     // encode(sha256(convert_to(notes.body,'UTF8')),'hex')
function isCurrentEmbeddingSql(model: string): SQL       // null (not false) when the left join found no row
function toVectorLiteral(v: readonly number[]): string   // JSON text for ${..}::vector; throws on NaN/Infinity
interface PendingNote { id; body; bodySha256 }
function listPending(db: Executor, opts: { model; limit; ignoreBackoff? }): Promise<PendingNote[]>
function saveEmbedding(db, v: { noteId; bodySha256; model; embedding: number[] }): Promise<boolean>
function recordFailure(db, v: { noteId; bodySha256; model; error }): Promise<void>
interface EmbeddingStats { withText; current; pending; failing }
function embeddingStats(db: Executor, model: string): Promise<EmbeddingStats>
interface NearestOptions { noteId; model; limit }        // limit already clamped by the caller (phase 5)
interface NearestNote { row: NoteRow; distance: number } // cosine distance, 0..2
function nearestNotes(db: Db, opts: NearestOptions): Promise<NearestNote[] | null>
```
- `listPending`: live and deleted notes with non-blank text (a Postgres regex matching exactly what JS `trim` keeps) whose row is missing, stale, or failed and due (`next_attempt_at <= now()`, or any failure with `ignoreBackoff`). Live first, then newest `updated_at`, then id.
- `saveEmbedding`: throws on a wrong width before any I/O. Upserts only if the note's body still hashes to `bodySha256`, resetting attempts/error/backoff. False when skipped (body changed or note gone). Idempotent.
- `recordFailure`: sets `embedding` null, `attempts` +1 when the prior row was a failure for the same body and model (else 1), `next_attempt_at = now() + retryDelayMs(attempts)`, `last_error = clampError(error)`. No-op when the body changed, the note is gone, or a current vector already exists (another daemon succeeded).
- `embeddingStats`: counts over live and deleted notes; `pending = withText - current`; `failing` = last attempt for this body and model failed.
- `nearestNotes` (phase 5): in one transaction, returns null when `noteId` has no current vector for `model` (no row, stale body, failed attempt or another model). Otherwise it sets `hnsw.iterative_scan = strict_order` and selects live notes other than `noteId` with a current vector, `ORDER BY embedding <=> (source vector) LIMIT limit` (the HNSW cosine shape), closest first. Deleted notes keep their vectors but never come back.

#### src/embeddings/embedder.ts (phase 2)
```ts
interface EmbedOptions { timeoutMs?: number }            // per-call override of the embedder's default
interface Embedder {
  readonly model: string                                 // stored in note_embeddings.model
  readonly dimensions: number                            // equals the vector(n) column
  embed(inputs: readonly string[], opts?: EmbedOptions): Promise<number[][]>   // one vector per input, input order
}
class EmbeddingError extends Error { name = 'EmbeddingError'; readonly detail?: unknown }
function embeddingErrorText(cause: unknown): string      // one line for a log or last_error, includes `detail` (the transport cause)
```
`EmbeddingError` is the only failure class (missing key, empty input, transport, timeout, non-2xx, non-JSON, bad count/index, wrong width, non-finite element); no caller branches on which. It never carries the API key. `embed` throws it with no request when `inputs` is empty or any input is blank after trim.

#### src/embeddings/openrouter.ts (phase 2)
```ts
const OPENROUTER_EMBED_TIMEOUT_MS = 15_000
const OPENROUTER_EMBED_MAX_BATCH = 64                    // larger embed() calls become sequential requests
const RESPONSE_SNIPPET_CHARS = 300
interface OpenRouterEmbedderOptions { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; maxBatch?: number }
function createOpenRouterEmbedder(opts): Embedder        // blank key -> EmbeddingError; bad maxBatch -> RangeError; no network at construction
function embedderFromConfig(config: EmbeddingsConfig, opts?: { fetch? }): Embedder | null   // null without a key
function postOpenRouterEmbeddings(fetchImpl, apiKey, body, timeoutMs): Promise<{ json; raw }>   // iteration 8 phase 6: shared with openrouterImage.ts
function snippet(raw: string): string                    // first RESPONSE_SNIPPET_CHARS
function errorName(cause: unknown): unknown              // tells TimeoutError/AbortError apart
```
`postOpenRouterEmbeddings` (extracted in iteration 8 phase 6, no behaviour change for text) does the one POST and maps every transport, timeout, unreadable-body, non-2xx and non-JSON failure to an `EmbeddingError`; the key goes only into the Authorization header. Each batch is one `POST OPENROUTER_EMBEDDINGS_URL` with `{ model: EMBEDDING_MODEL, input, encoding_format: 'float' }`, a bearer key and `AbortSignal.timeout`. Inputs pass through `embedInput` (trim and clamp, no marker). The body is read as text and then parsed, so errors carry a 300-char snippet. Each `data[i].index` (or position when absent) places a vector; a repeated or out-of-range index, a count mismatch, a width other than `EMBEDDING_DIMENSIONS` or a non-finite element is an `EmbeddingError` naming the model and column width. A failed chunk fails the whole call. No SDK.

#### src/embeddings/backfill.ts (phase 3)
```ts
const DEFAULT_BATCH_SIZE = 16                            // inputs per embed() call
const DEFAULT_MIN_INTERVAL_MS = 1_000                    // min gap between the starts of two embed() calls
interface Clock { now(): number; sleep(ms, signal?): Promise<void> }   // sleep resolves early on abort, never rejects
const realClock: Clock
class RateLimiter { constructor(minIntervalMs, clock?); acquire(signal?): Promise<boolean> }   // false (no slot taken) when aborted
interface EmbeddingStore { listPending(opts); saveEmbedding(v): Promise<boolean>; recordFailure(v) }   // the three repo calls
function dbEmbeddingStore(db: Db): EmbeddingStore       // thin adapter over src/embeddings/repo.ts
interface BackfillProgress { batches; calls; embedded; failed; skipped }
interface BatchReport { notes; calls; embedded; failed; skipped; fellBack; ms; failures: { id; error }[] }
interface BackfillResult extends BackfillProgress { aborted: boolean }
interface BackfillOptions { store; embedder; batchSize?; limiter?; minIntervalMs?; ignoreBackoff?; signal?; clock?; onBatch?; onProgress? }
function runBackfill(opts: BackfillOptions): Promise<BackfillResult>
function errorMessage(err: unknown): string
```
`runBackfill` is the one drain loop used by the worker and the CLI. Each pass lists pending notes (asking for `batchSize` plus the number already settled this run), drops settled ones and those whose `embedInput` is null, and embeds up to `batchSize` in one call. When a batch call fails it retries each note alone, so one bad input cannot block the others; a note that fails alone gets `recordFailure` (phase 1's backoff). A `saveEmbedding` that returns false (body changed during the call) counts as `skipped`. Every `(id, body hash)` that failed or was skipped is settled for the rest of the run, so neither `ignoreBackoff` nor a body that keeps changing can make the loop spin. Every call waits on the shared `RateLimiter`. The signal is checked between batches and before each call; a call already in flight finishes and its result is saved. The loop ends when a pass finds nothing new, or on abort (`aborted: true`).

#### src/embeddings/worker.ts (phase 3)
```ts
const DEFAULT_SWEEP_MS = 60_000                          // periodic drain: the other laptop's writes, retries now due
const DEFAULT_DEBOUNCE_MS = 500                          // coalesces bursts of events into one drain
const DEFAULT_CLOSE_GRACE_MS = 5_000                     // close() stops waiting for an in-flight call after this
interface EmbeddingWorkerOptions { store; events: NoteEvents; embedder; batchSize?; minIntervalMs?; sweepMs?; debounceMs?; closeGraceMs?; clock?; log? }
interface EmbeddingWorker { kick(): void; idle(): Promise<void>; close(): Promise<void> }
function startEmbeddingWorker(opts): EmbeddingWorker     // drains once at start
function formatBatch(r: BatchReport): string             // `[notesd] embeddings: 15/16 embedded, 1 failed (A-B32: ...), per-note fallback, 17 calls, 2310ms`
```
One `RateLimiter` and `AbortController` per worker. `created` and `updated` events call `kick()` (debounced); `deleted`, `restored` and `purged` do not, since a deleted note keeps its vector and a purged note's vector goes with it by FK cascade. The sweep is an unref'd `setInterval`. At most one drain runs; a kick during a drain sets a flag and runs one more pass afterwards. A drain that throws (e.g. a store error) is logged as `[notesd] embeddings: drain failed: ...` and the worker keeps going. Only batches that did work are logged; an idle sweep logs nothing. `idle()` flushes a pending debounce and waits until no drain runs (tests). `close()` is idempotent: it unsubscribes, clears the sweep and debounce, aborts, and waits for the in-flight drain up to `closeGraceMs`; past that the call is abandoned, its save fails once the pool closes, and the note stays pending for the next start.

#### src/cli/embedBackfill.ts (phase 3): `npm run embed:backfill`
```ts
interface EmbedBackfillIo { loadConfig; createDb; closeDb; createEmbedder(apiKey); out; err; signal?; minIntervalMs? }
function defaultIo(signal: AbortSignal): EmbedBackfillIo  // real config, Neon db, OpenRouter embedder, console
function embedBackfill(args: readonly string[], io): Promise<number>   // returns the exit code
```
`package.json` script `"embed:backfill": "tsx src/cli/embedBackfill.ts"`; the file runs `main()` only when executed directly. Arguments: `--retry-failed` (passes `ignoreBackoff`), `--help`/`-h` (usage, exit 0); anything else exits 2. Exit 1 on a config error or a missing `OPENROUTER_API_KEY` (no database opened). It prints `embeddingStats` before, an `embedded n/total, failed m` line after each batch, each failure on stderr, then a `done:` line (with `nothing to embed` when no call was made) and a hint about notes waiting on backoff. Exit 0 when nothing failed, 1 when any note failed, 130 when stopped. The first Ctrl-C aborts after the current batch (rerun to resume; finished notes are not embedded again); a second one exits at once. The database is always closed.

### Image embeddings: src/embeddings/image*.ts (iteration 8 phase 6)

Fills `note_image_embeddings` for `similar_images`. Separate model, vector space and table from the note text embeddings; reuses `RateLimiter`, `Clock`, `retryDelayMs`, `clampError`, `toVectorLiteral`, `EmbeddingError` and the worker defaults. The same `OPENROUTER_API_KEY` turns it on; a null `ImageEmbedder` means image search off (writes unaffected, no worker, `similar_images` says so).

#### src/embeddings/imageConstants.ts
```ts
const IMAGE_EMBEDDING_MODEL = 'google/gemini-embedding-2'
const IMAGE_EMBEDDING_DIMENSIONS = 1536   // must equal vector(1536) of note_image_embeddings (unit test asserts); pgvector HNSW caps vector at 2000
const IMAGE_EMBED_LONG_EDGE = 1024        // px of the PNG sent; never enlarged
const IMAGE_PRICE_USD_PER_M_TOKENS = 0.45, TEXT_PRICE_USD_PER_M_TOKENS = 0.2
const IMAGE_TOKENS_PER_TILE = 258, IMAGE_SMALL_EDGE = 384, IMAGE_TILE_EDGE = 768
function estimateImageTokens(width, height): number   // after the 1024 downscale: <= 384x384 is one tile, else 768-px tiles; dry-run estimate only
function estimateImageCostUsd(tokens): number
```
Gemini returns 3072 floats by default; requests ask for 1536 and the client keeps the first 1536 (a Matryoshka prefix), L2-renormalised. A model or width change means a new migration plus `npm run embed:images:backfill`.

#### src/embeddings/imageEmbedder.ts, src/embeddings/openrouterImage.ts
```ts
interface ImageEmbedder { readonly model; readonly dimensions; embedImage(png: Uint8Array, opts?): Promise<number[]>; embedText(query: string, opts?): Promise<number[]> }
const OPENROUTER_IMAGE_EMBED_TIMEOUT_MS = 30_000
const MAX_EMBED_PNG_BYTES = 8 * 1024 * 1024
function isPng(bytes): boolean
function pngDataUrl(png): string
function imageRequestBody(png): ImageEmbeddingRequestBody   // { model, input: [{ content: [{ type: 'image_url', image_url: { url: data:image/png;base64,... } }] }], dimensions }
function textRequestBody(text): ImageEmbeddingRequestBody    // same shape with a text part; text passes through embedInput
function fitVector(values, width?): number[]                 // first `width` values / L2 norm; EmbeddingError if narrower, non-finite or zero
function createOpenRouterImageEmbedder({ apiKey, fetch?, timeoutMs? }): ImageEmbedder   // blank key throws; no network at construction
function imageEmbedderFromConfig(config: EmbeddingsConfig, opts?): ImageEmbedder | null  // null without a key
```
One `postOpenRouterEmbeddings` call per image or query, no SDK, no batching. `embedImage` refuses (no request) bytes that are not a PNG or exceed `MAX_EMBED_PNG_BYTES`; `embedText` refuses a blank query. The response must hold exactly one vector (index 0 or absent). Every returned vector is unit length.

#### src/embeddings/imageInput.ts
```ts
function toEmbeddingPng(input: string | Uint8Array): Promise<Buffer>      // sharp: EXIF rotate, fit inside 1024, flatten on white, PNG
function notePngForEmbedding(dataDir, src: ImageSource): Promise<Buffer>   // the note image's preview derivative (HEIC/TIFF already decoded) -> toEmbeddingPng; OriginalMissingError when not here
```

#### src/embeddings/imageRepo.ts
```ts
interface PendingImage { id; noteId; sha256; path; mime; width; height; host; live }
function listPendingImages(db, { model, limit, ignoreBackoff?, excludeIds? }): Promise<PendingImage[]>
function saveImageEmbedding(db, { imageId, imageSha256, model, embedding }): Promise<boolean>
function recordImageFailure(db, { imageId, imageSha256, model, error }): Promise<void>
interface ImageEmbeddingStats { images; current; pending; failing }
function imageEmbeddingStats(db, model): Promise<ImageEmbeddingStats>
type NearestImageSource = { imageId: string } | { vector: readonly number[] }
interface NearestImage { imageId; noteId; distance; similarity }   // similarity = 1 - distance, 4 decimals
function nearestImages(db: Db, { source, model, limit }): Promise<NearestImage[] | null>
```
Plain SQL with full table names; the vector column is read only by `nearestImages` and never leaves the file. `listPendingImages` covers every image (live, removed, in a deleted note) whose row is missing, from another model, for other bytes, or failed and due; live images of live notes first, then newest, then id; `excludeIds` is the drain loop's settled set. `saveImageEmbedding` upserts only while the image still hashes to `imageSha256` (false otherwise) and resets the backoff; `recordImageFailure` mirrors `recordFailure`. `nearestImages` returns null for an image source with no current vector (so the caller can embed and ask again; a vector source never returns null), and otherwise, in one transaction with `hnsw.iterative_scan = strict_order`, returns live images of live notes with a current vector, never the source, `ORDER BY embedding <=> source LIMIT n`.

#### src/embeddings/imageBackfill.ts
```ts
const DEFAULT_IMAGE_PAGE_SIZE = 32
const DEFAULT_UNAVAILABLE_RECHECK_MS = 3_600_000
interface ImageEmbeddingStore { listPending(opts); isAvailable(image); loadPng(image); save(v); recordFailure(v) }
function dbImageEmbeddingStore(db: Db, dataDir: string): ImageEmbeddingStore
class UnavailableImages { constructor(recheckMs?, clock?); add(id); ids(): string[] }   // memo of originals missing here
type ImageOutcome = 'embedded' | 'failed' | 'skipped' | 'unavailable'
interface ImageReport { imageId; outcome; error?; ms }
interface ImageBackfillProgress { calls; embedded; failed; skipped; unavailable }
interface ImageBackfillResult extends ImageBackfillProgress { aborted; limited }
interface ImageBackfillOptions { store; embedder; limiter?; minIntervalMs?; ignoreBackoff?; signal?; clock?; maxImages?; pageSize?; unavailable?; onImage?; onProgress? }
function runImageBackfill(opts): Promise<ImageBackfillResult>
```
One image per call. Each image is offered at most once per run; an image whose original is not on this machine is settled as `unavailable` with no failure recorded (the other laptop's daemon embeds it), and the settled set is excluded in SQL so a long tail of remote images never hides a local one. A failed PNG preparation or call gets `recordImageFailure`; a `save` returning false is `skipped`. Every call waits on the `RateLimiter`; the signal is checked before each image and each call. `maxImages` (`--limit`) stops after that many embedded + failed + skipped (`limited: true`). Store errors reject; embedding and PNG errors never do.

#### src/embeddings/imageWorker.ts
```ts
interface ImageEmbeddingWorkerOptions { store; events; embedder; minIntervalMs?; sweepMs?; debounceMs?; closeGraceMs?; unavailableRecheckMs?; clock?; log? }
interface ImageDrainSummary extends ImageBackfillResult { ms; firstFailure: { id; error } | null }
function formatImageDrain(s): string   // `[notesd] image embeddings: 3 embedded, 1 failed (A-B32: ...), 40 not on this machine, 4 calls, 5210ms`
function startImageEmbeddingWorker(opts): EmbeddingWorker   // same { kick, idle, close } as the note worker; drains once at start
```
Same shape as the note worker: `created` and `updated` events kick a debounced drain (creating an image note emits `created`, attaching emits `updated`), a 60 s unref'd sweep, at most one drain at a time with one re-run flag, bounded `close()`. One `UnavailableImages` memo per worker, so a missing original is not looked at again for an hour. Logs only drains that made a call or recorded a failure, and `[notesd] image embeddings: drain failed: ...`.

#### src/embeddings/chatUploads.ts
```ts
interface ChatUploadFile { id; absPath }
type ChatUploadSource = (uploadId: string) => Promise<ChatUploadFile | null>   // any case, dash optional; null when unknown
function dbChatUploadSource(db: Db, dataDir: string): ChatUploadSource          // over locateChatImage (chat_images); lazy
```

#### src/cli/embedImagesBackfill.ts: `npm run embed:images:backfill`
```ts
const DRY_RUN_MAX_ROWS = 100_000
interface EmbedImagesBackfillIo { loadConfig; createDb; closeDb; createEmbedder(apiKey): ImageEmbedder; out; err; signal?; minIntervalMs? }
function defaultIo(signal: AbortSignal): EmbedImagesBackfillIo
function embedImagesBackfill(args, io): Promise<number>   // exit code
```
`package.json` script `"embed:images:backfill": "tsx src/cli/embedImagesBackfill.ts"`; never runs by itself (`notesd` embeds new images in the background). Arguments: `--dry-run` (counts due images here vs on another machine and prints an estimated token count and USD cost from `estimateImageTokens`; no network, no writes), `--limit N` / `--limit=N` (at most N images; then `stopped at --limit N; run again for the rest`), `--retry-failed` (`ignoreBackoff`), `--help`/`-h`; anything else is a usage error. Exit 1 on a config error or missing `OPENROUTER_API_KEY`; per-image progress lines, failures on stderr, `nothing to embed on this machine` when idle, a backoff hint when failures wait. Exit 130 when stopped (first Ctrl-C after the current image, second exits at once).

### Search: src/search/ (iteration 6 phase 4)

The ranking half of hybrid search. `NotesService.search` gathers candidates with `repo.searchCandidates` and hands them here.

#### src/search/blend.ts (pure, no I/O)

```ts
interface BlendTuning { textFloor; text; vector; minSimilarity; tag; hashtagHit; wordTagHit; recency; recencyHalfLifeDays; exactId; textCandidates; vectorCandidates }
const BLEND: BlendTuning   // 0.6, 0.4, 0.6, 0.22, 0.25, 1, 0.5, 0.1, 90, 2, 500, 100: the one place weights live
interface QueryTerms { hashtags: string[]; words: string[]; ids: string[]; excluded: string[] }
function queryTerms(query: string): QueryTerms
function tagMatch(tags, terms, tuning?): number              // 0..1
function recencyScore(updatedAt, now, tuning?): number       // 0.5^(ageDays / half-life); future = now
function similarityScore(similarity | null, tuning?): number // (cos - minSimilarity) / (1 - minSimilarity), clamped; null -> 0
interface BlendInput { exactId; textRank: number | null; similarity: number | null; tagMatch; recency }
function blendScore(x: BlendInput, tuning?): number
function isEligible(x: BlendInput, tuning?): boolean         // id or text match always; meaning-only needs cos >= minSimilarity
interface BlendCandidate { id; textRank: number | null; similarity: number | null; tagMatch; updatedAt: Date; exactId? }
type Ranked<T> = T & { score: number }
function rankCandidates<T extends BlendCandidate>(candidates, { now, tuning? }): Ranked<T>[]
```

`score = exactId? + (textFloor + text * rank/bestRank if full-text match) + vector * similarityScore + tag * tagMatch + recency * recencyScore`. Two invariants are asserted in `tests/unit/search.blend.test.ts` and must survive any retune: `textFloor + text > vector + tag + recency` (the best literal hit beats every meaning-only note) and `exactId > sum of all the rest` (a named id goes first). `queryTerms`: hashtags via `parseTags`; `-word` exclusions; ids from `X-XXX` tokens (any case) or a lone four-character query that contains a digit (so "pool" stays a word); words are the remaining tokens of 2+ chars, minus `or`. A `#hashtag` hit fills `tagMatch`; a bare word that equals a tag counts half. `rankCandidates` normalizes `textRank` by the best candidate, drops ineligible rows and sorts score desc, then `updated_at` desc, then id desc (text mode's tie-break). Numbers were tuned on the labelled set with the concept-bag fake embedder; phase 6's live test may change them, never the names.

#### src/search/queryVector.ts

```ts
const QUERY_EMBED_TIMEOUT_MS = 5_000
const QUERY_CACHE_SIZE = 64
class QueryVectorCache { constructor(capacity?); get size; get(key); set(key, vector) }   // LRU
function embedQuery(embedder, cache, query, timeoutMs?): Promise<number[]>
const SEMANTIC_OFF_FALLBACK: string            // no OPENROUTER_API_KEY
function embedFailedFallback(err): string      // reason clipped to 200 chars; never carries the key
```

`embedQuery` runs the query through `embedInput`, keys the cache by `${model}\n${input}`, and races one `embed([input], { timeoutMs })` against its own unref'd timer. It throws on an empty query, a timeout, an embedder error, no vector, or a width other than `EMBEDDING_DIMENSIONS`. Only successes are cached. Both fallback strings tell the user the results are full-text only.

### src/deps.ts, src/daemon.ts, src/background.ts, src/main.ts

```ts
interface AppDeps { config: Config; db: Db; events: NoteEvents; service: NotesService; embedder: Embedder | null;   // null: semantic features off
  imageEmbedder: ImageEmbedder | null   // iteration 8 phase 6; null: image search off
  chat: ChatService }                   // iteration 8 phase 7; the only writer of the chat tables
const CHAT_SUBDIR = 'chat'   // <dataDir>/chat: fixed cwd of every chat brain run; sessions are not persisted there (persistSession: false since iteration 8 phase 7)
const DATA_SUBDIRS = ['images', 'cache', 'inbox', 'inbox/failed', CHAT_SUBDIR, CHAT_IMAGES_SUBDIR, 'files']   // CHAT_IMAGES_SUBDIR = 'chat-images' from src/chat/images.ts; 'files' since iteration 8 phase 4
function ensureDataDirs(dataDir: string): Promise<void>
interface RunningDaemon { deps: AppDeps; port: number; stop: () => Promise<void> }
interface StartDaemonOptions {
  chat?: ChatBackend               // omitted: createAgentChatBackend from config.chat; tests inject the stub or a scripted fake
  embedder?: Embedder | null       // omitted: embedderFromConfig(config.embeddings); tests inject FakeEmbedder or null
  imageEmbedder?: ImageEmbedder | null   // iteration 8 phase 6; omitted: imageEmbedderFromConfig(config.embeddings) (same key); tests inject the fake or null
}
function startDaemon(config: Config, options?: StartDaemonOptions): Promise<RunningDaemon>
function startBackground(deps: AppDeps): Promise<StopBackground>   // StopBackground = () => Promise<void>; ensures data dirs, runs reconcileLegacyImages once (logs the count; a failure is logged and never blocks startup), starts the inbox watcher, the embedding worker when deps.embedder is set, and the image embedding worker (dbImageEmbeddingStore) when deps.imageEmbedder is set (else logs "image search off"); stop closes both workers in parallel
```
`startDaemon` runs these steps in order: refuse a non-loopback host, create the data dirs, the embedder (`options.embedder` when given, even null, else `embedderFromConfig`) and the image embedder (same rule with `imageEmbedderFromConfig`; both before `createDb`, so a blank key throws with no pool to leak), `createDb`, `NoteEvents`, `NotesService` (given the embedder), `ChatService({ db })` as `deps.chat` (iteration 8 phase 7), the chat backend (`options.chat`, or `createAgentChatBackend({ chat: config.chat, cwd: <dataDir>/chat, mcpUrl })`), `createApp(deps, { chat })`, `serve` on `config.host:config.port`, then `startBackground`. `mcpUrl` returns `http://<host>:<bound port>/mcp` and throws until `serve` has bound, so the agent always reaches this daemon's own `/mcp` even when `config.port` is 0. If listening fails it closes the db and rethrows. `port` is the bound port, which matters when `config.port` is 0. `stop()` is idempotent (it memoises one promise) and first calls `close()` on the default agent backend (stopping any in-flight run), then stops background jobs, then the server (closing all connections), then the db. `src/main.ts` is the `dev`/`start` entry. It logs the listen URL and handles SIGINT/SIGTERM with a 10 s forced exit.

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
web/src/App.tsx       all UI state: side, mode, view (wall | bin, iteration 7 phase 8; | history, iteration 8 phase 9), historyThread, active tags, editing id, expanded (big editor) id, chat input; owns useHistory and the one view <-> URL sync; wires every component
web/src/types.ts      Note (with images: NoteImage[], optional files?: NoteFile[] since iteration 8 phase 4; read `note.files ?? []`), NoteImage, NoteFile, PhotoItem, TagCount (mirror of src/notes/types.ts), Mode = 'text'|'images'|'all'; Bin, BinImage (phase 4 wire), View = 'wall'|'bin' (iteration 7 phase 8); ChatImage (iteration 8 phase 3); View gains 'history' and the phase 7 chat wire mirrors ChatRole, ChatSource, ChatAttachmentKind, ChatAttachment, ChatReplyPreview, ChatMessage, ChatPage, ChatOp, ChatChange (iteration 8 phase 9)
web/src/api.ts        fetch wrappers, ApiError, imageUrl / imageInfoUrl (by image id), chatImageUrl / uploadChatImage (iteration 8 phase 3), attachImage / removeImage (iteration 7 phase 7), fetchBin / restoreNote / restoreImage / purgeNote / purgeImage, DuplicateImageError (iteration 7 phase 8), Capabilities / fetchCapabilities / revealImage (iteration 7 phase 9), attachFile / attachRouted / removeFile / restoreFile / DuplicateFileError / fileDownloadUrl / revealFile / revealNote (iteration 8 phase 5)
web/src/chatHistoryApi.ts (iteration 8 phase 9) fetchChatMessages(ChatPageQuery) -> ChatPage, streamChat(StreamChatRequest) -> Response, chatImageSrc(id, 'thumb'|'display')
web/src/styles.css    design tokens on :root, grain overlay, masonry wall (CSS columns, 240px)
web/src/lib/text.ts   tagsOf, segmentBody, fontSizeFor, letterSpacingFor, rowsFor
web/src/lib/filter.ts MODE_TIP, MODE_ORDER, nextMode, hasImages, imageCount, matchesTags, visibleOnWall, photosOf (-> PhotoItem[]), headingFor, countLineFor, lastEdited, isHiddenByMode, BIN_HEADING, binCountLine (iteration 7 phase 8)
web/src/lib/usedIds.ts extractUsedIds(text, knownIds)
web/src/lib/dates.ts  relativeDate(iso, now, lower?)
web/src/lib/sse.ts    createSSEParser, readSSE (fetch-body SSE for POST /api/chat)
web/src/lib/oneLine.ts oneLine(s): line breaks (and the spaces/tabs around them) become one space, ends trimmed
web/src/lib/files.ts  (pure, iteration 8 phase 5) ATTACHABLE_IMAGE_TYPES (mirrors SUPPORTED_IMAGE_MIMES), routeFiles -> RoutedFile[] ({ kind: 'image'|'file', file }), pastedFiles(files, attaching), formatBytes, extensionOf, typeLabel, fileKind -> FileKind, Attachable, hasAttachments, noteRevealable
web/src/lib/route.ts  (pure, iteration 8 phase 9) HISTORY_PATH, Route, routeFromLocation, historyHref(thread), hrefForView(view, thread, loc)
web/src/lib/events.ts (iteration 8 phase 9) EVENTS_URL, subscribeEvents(type, fn) -> unsubscribe: the page's one shared EventSource on /api/events
web/src/lib/timeline.ts (pure, iteration 8 phase 9) HISTORY_HEADING, HISTORY_HINT, LocalBubble, TimelineItem, timeOf, sortMessages, oldestMs, mergeMessages, localToMessage, timelineOf, pruneLocal, threadForSend, historyCountLine
web/src/lib/chatTime.ts (pure, iteration 8 phase 9) CHAT_TZ = 'Asia/Jakarta', WallClock, jakartaParts, chatTime(iso, now), chatTimeTitle(iso)
web/src/hooks/useNotes.ts  notes + tags store: initial load, SSE (`note` + `open` via lib/events since iteration 8 phase 9), 60 s poll, debounced refetch, optimistic upsert/remove
web/src/hooks/useChat.ts   chat state machine over POST /api/chat (text, status caption, brain, thread id, collapsed + toggleCollapsed; images = ids sent with the query; ChatState.threadId from `accepted`/`done`, iteration 8 phase 9)
web/src/hooks/useHistory.ts useHistory(enabled, { includeDeleted? }): HistoryStore, HISTORY_PAGE = 50 (iteration 8 phase 9)
web/src/hooks/useChatImages.ts useChatImages(upload?): { images, readyIds, blocked, add, remove, clear }, MAX_CHAT_IMAGES = 4 (iteration 8 phase 3)
web/src/hooks/useNow.ts    Date re-rendered every 60 s
web/src/hooks/useCopied.ts copyText (clipboard + execCommand fallback), useCopied(ms = 1400)
web/src/hooks/useNotice.ts useNotice(ms = 2400): { notice, show(text) }, a quiet timed status label (iteration 7 phase 7)
web/src/hooks/useUndo.ts   UNDO_MS = 6000, useUndo(ms): { entry, push, undo, dismiss }, one undo entry at a time (iteration 7 phase 8)
web/src/hooks/useBin.ts    useBin(active, enabled): BinStore { bin, loaded, error, refetch, dropNote, dropImage } (iteration 7 phase 8)
web/src/hooks/useCapabilities.ts useCapabilities(): Capabilities, NO_CAPABILITIES, loadCapabilities(), resetCapabilitiesForTests(next?); one GET /api/capabilities per page (iteration 7 phase 9)
web/src/components/   Rail, Sidebar, Header, Wall, NoteCard, AnswerPanel, ChatBar (+ .css), Tooltip, NoteImage, Gallery, PhotoModal (+ .css), DropOverlay, NoteEditor (+ .css, iteration 7 phase 7), Bin, UndoBar (+ .css, iteration 7 phase 8), RevealButton (iteration 7 phase 9), FileChips (+ .css), NoteRevealButton (iteration 8 phase 5), Bubble (iteration 8 phase 9: THUMB_H, thumbWidth, lightboxItemsOf)
web/src/pages/        HistoryPage (+ .css) (iteration 8 phase 9)
web/src/fullscreen/   main.tsx (entry), FullscreenApp.tsx, view.ts (fit/1:1/pan reducer)
web/src/testing/fixtures.ts  shared test fixtures makeImage, makeNote (iteration 7 phase 6), makeFile (iteration 8 phase 5)
web/src/testing/chatFixtures.ts makeMessage(id, over?): a wire ChatMessage (wall user message in thread T1 at 2026-10-31T01:00Z) (iteration 8 phase 9)
```

### api.ts
```ts
class ApiError extends Error { readonly status: number }   // message = server's { error } when JSON
fetchNotes(): Promise<Note[]>              // GET /api/notes?limit=2000, returns .notes (one page)
fetchTags(): Promise<TagCount[]>           // GET /api/tags
createNote(body): Promise<Note>            // POST /api/notes
updateNote(id, body): Promise<Note>        // PATCH /api/notes/:id
deleteNote(id): Promise<void>              // DELETE; a 404 counts as success
postChat(message, threadId?, signal, imageIds = []): Promise<Response>   // POST /api/chat, raw SSE response; image_ids sent only when non-empty
chatImageUrl(imageId, variant): string                    // /api/chat/images/:id/:variant (iteration 8 phase 3)
interface ChatImageUpload { image: ChatImage; created: boolean }
uploadChatImage(file): Promise<ChatImageUpload>           // POST /api/chat/images, multipart `file` (name defaults to `pasted-image`)
type ImageFileVariant = 'thumb' | 'display' | 'original' | 'preview'
imageUrl(imageId, variant): string                        // /api/images/:imageId/:variant
imageInfoUrl(imageId): string                             // /api/images/:imageId (wire NoteImage JSON)
interface AttachResult { note: Note; attached: boolean }  // iteration 7 phase 7
attachImage(noteId, file): Promise<AttachResult>          // POST /api/notes/:id/images, multipart `file` (name defaults to `pasted-image`); attached: false = bytes already live in `note`
removeImage(imageId): Promise<Note>                       // DELETE /api/images/:imageId (soft remove to the bin); returns the owner note without it
fetchBin(tags = []): Promise<Bin>                         // GET /api/bin?tag=..&tag=.. (iteration 7 phase 8)
restoreNote(id): Promise<Note>                            // POST /api/notes/:id/restore; a 409 (already live) re-reads and returns the live note
class DuplicateImageError extends ApiError { readonly noteId: string }   // 409 duplicate_image from image restore: the bytes already live in noteId
restoreImage(imageId): Promise<Note>                      // POST /api/images/:imageId/restore -> owner note (restored too if it was deleted); throws DuplicateImageError
type PurgeResult = { purged: string; files: number }
purgeNote(id): Promise<PurgeResult>                       // DELETE /api/bin/notes/:id (sameOriginOnly: only the page itself may call it)
purgeImage(imageId): Promise<PurgeResult>                 // DELETE /api/bin/images/:imageId (sameOriginOnly)
interface Capabilities { reveal: boolean }                // iteration 7 phase 9; reveal = notesd runs under WSL with interop and can launch explorer.exe
fetchCapabilities(): Promise<Capabilities>               // GET /api/capabilities; anything but `reveal: true` reads as false
revealImage(imageId): Promise<void>                       // POST /api/images/:imageId/reveal -> 202; notesd spawns Explorer and does not wait
// iteration 8 phase 5 (P1-NOTES-A038): note files
interface FileAttachResult extends AttachResult { kind: 'image' | 'file' }   // 'image' = server sniffed a supported image; it is in note.images
attachFile(noteId, file): Promise<FileAttachResult>       // POST /api/notes/:id/files, multipart `file`; 409 duplicate_file/duplicate_image throws DuplicateFileError/DuplicateImageError; 413 throws ApiError
attachRouted(noteId, item: RoutedFile): Promise<AttachResult>   // kind 'image' -> attachImage, else attachFile
removeFile(fileId): Promise<Note>                         // DELETE /api/files/:fileId (soft); owner note without it
class DuplicateFileError extends ApiError { readonly noteId: string }    // 409 duplicate_file
restoreFile(fileId): Promise<Note>                        // POST /api/files/:fileId/restore; throws DuplicateFileError
fileDownloadUrl(fileId): string                           // /api/files/:fileId/download (fallback when the wire file has no urls.download)
revealFile(fileId): Promise<void>                         // POST /api/files/:fileId/reveal -> 202, file selected
revealNote(noteId): Promise<void>                         // POST /api/notes/:id/reveal -> 202, files folder (or first image when no files)
```
Iteration 8 phase 9 (P1-NOTES-A042) keeps the history page's calls in `web/src/chatHistoryApi.ts`, not `api.ts`:
```ts
interface ChatPageQuery { before?: string | null; limit?: number; includeDeleted?: boolean }
fetchChatMessages(q = {}): Promise<ChatPage>    // GET /api/chat/messages?before&limit&include_deleted=1; normalises nullable fields, attachments default []; next_before '' -> null
interface StreamChatRequest { message; threadId?; imageIds?; signal }
streamChat(r): Promise<Response>                // POST /api/chat, thread_id / image_ids only when set; caller reads the SSE body
chatImageSrc(id, 'thumb' | 'display'): string   // /api/chat/images/<id>/<variant>
```
Since iteration 7 phase 6 (P1-NOTES-A028) every image the UI loads is addressed by image id through the iteration 7 phase 2 routes; the note-id builders `thumbUrl`/`displayUrl`/`originalUrl` are gone and the UI no longer uses the `/api/notes/:id/:variant` alias.

### Behaviour
- **Data**: `useNotes` loads notes and tags together on mount, then refetches on every `event: note` from `/api/events` (since iteration 8 phase 9 through `subscribeEvents`, the page's one shared `EventSource` in `lib/events.ts`, which opens on the first subscriber, fans each event type out to every subscriber and closes on the last unsubscribe; a no-op without `EventSource`), on SSE `open` (catches up after a daemon restart), and every 60 s. Refetches are debounced 250 ms and never overlap. A generation counter bumped by every local mutation discards a fetch that started before the mutation and schedules another, so optimistic edits are not overwritten by stale data.
- **Modes**: `text` (default; hides notes with any image, `hasImages`), `images` (renders `Gallery`), `all`. The rail button cycles text, images, all; the sidebar shows all three plus a photo count (`imageCount`: images across all notes, not image notes). Jumping to a note the current mode hides switches to `all` first.
- **Tag filter**: AND semantics over `tagsOf(body)`. Clicking a tag chip on a card or a sidebar row toggles it; active tags show as rail chips with a clear button. The heading becomes the active tags (`#a #b`), otherwise `Notes.` / `Everything.` / `Photos.`.
- **Header**: count line per mode, "Last edited <id> <when>" linking to the note (scrolls with a 140 px offset), the drop/paste hint, and a new-note sticker (hidden in images mode).
- **Cards**: font size by body length (26 / 17 / 13.5 px; 13 for image cards), tag chips, id with a copy button and a 1.4 s "copied" mark, relative created date (`just now`, `N min ago`, `Today`, `Yesterday`, `Oct 28`, `Oct 28, 2025`). Image cards show `images[0]` as the cover (`.card-cover` wrapping `NoteImage`, the thumb sized by its aspect ratio); a note with two or more images adds a `.card-count` badge with the count (`data-count`), bottom-right in mono with `mix-blend-mode: difference`, no pill. `NoteCard` is memoised.
- **Inline edit**: clicking the text opens a textarea (caret at end); blur commits. An empty draft on a note with no images and no files (`hasAttachments`, iteration 8 phase 5) deletes it (optimistic remove, then `DELETE`); an unchanged draft does nothing; otherwise an optimistic update (re-parsed tags, new `updated_at`) then `PATCH`. "New note" creates an empty note via `POST`, puts it on top in edit mode, and leaves images mode. The note being edited stays visible whatever the filters.
- **Big editor (iteration 7 phase 7, P1-NOTES-A029)**: every card's meta row has an `ArrowsOutSimple` icon (`Expand note`) that calls `onExpand(note, draft)` (threaded through `Wall`). Its `mousedown` is prevented so an open inline editor keeps focus (no blur commit, so an empty new note is not deleted); when the card was being edited, its unsaved draft (tracked in a `draftRef`) is handed over and saved first, never deleted. App sets `expanded`, ends inline edit for that note, and portals `NoteEditor` into `document.body` keyed by note id. `NoteEditor` shows the id with Copy ID and the `copied` mark, a `useNotice` label (`aria-live`), a Close button, a wide focused textarea (caret at end), live tag chips from the draft, and an image strip (`data-strip`, one thumb per image in order, each with a `Remove image` icon; since iteration 7 phase 8 that calls App's `removeImageWithUndo`, which replaced phase 7's `removeImg`, see Delete and undo). It saves on blur only when the draft differs from the last saved text (an empty body is saved, not deleted). It closes exactly once via X, a backdrop click, or Escape (capture-phase `keydown` on `window` with `preventDefault` + `stopPropagation`, PhotoModal's seam, so an open chat answer stays), reporting `dirty`. App's `closeEditor` applies the empty-note rule only on close, against the latest store copy (empty body and no images or files, `hasAttachments`: optimistic remove, then `DELETE`); otherwise text mode switches to `all` when the note now has images, and a dirty draft is saved. `commit` from the inline editor is a no-op for the expanded note. `visibleOnWall`'s fourth argument is now `keep: string | null | (string | null)[]`; App passes `[editing, expanded]` so both stay visible.
- **Delete and undo (iteration 7 phase 8, P1-NOTES-A030)**: a `Trash` icon (`Delete note`) sits on every wall card's meta row (after Expand note), in the big editor's toolbar (before Close) and in the photo modal's side panel; each is present only when its `onDelete` prop is passed (`Wall`/`Gallery` thread it through). Card and editor icons prevent `mousedown` so an inline editor does not blur-commit; the editor marks itself closed first so an unmount blur cannot save the note back. Deleting is soft and asks nothing. App's `removeNote(note, draft?)` clears `editing`/`expanded` for that note, removes it locally, then (when the editor's draft differs from the body) `PATCH`es the draft before `DELETE`, and pushes an undo entry `deleted <id>` whose `run` waits for that sequence and then `restoreNote` + `upsertLocal`. The editor strip's remove icon goes through `removeImageWithUndo(image)`: optimistic drop from the owner, `removeImage`, and an undo entry `removed image` that calls `restoreImage` (a `DuplicateImageError` is only `console.warn`ed). `useUndo` holds one entry for `UNDO_MS` (6 s); a new push replaces the old one (that action just stays done), `undo` runs the entry once and hides it, and a failed undo is logged, never shown. `UndoBar` renders it as a Geist Mono label plus an icon-only `ArrowCounterClockwise` (`Undo`) button, `role=status`, fixed at `right: 16px`, `bottom: calc(var(--chatbar-h, 54px) + 24px)`, z-index 65 (above the editor and photo modal at 60, below the drop overlay and tooltip), re-mounted per entry (`seq`) so it fades in again.
- **Recycle bin (iteration 7 phase 8)**: a `Trash` toggle on the rail (after the mode button) and after the sidebar's three mode buttons (before the photo count) switches App's `view` between `wall` and `bin` (`BIN_TIP`: `Recycle bin` / `Back to the wall`, `aria-pressed`). Picking a mode, adding a note or jumping to a note (`jump` scrolls after a 50 ms delay when leaving the bin) returns to the wall; the sidebar highlights a mode only on the wall. In the bin the header shows `BIN_HEADING` (`Deleted.`) and `binCountLine` (`N deleted notes, M images.`, plus `, tagged #a #b.` with active tags), no Last edited link, no sticker, and a hint about restore and delete forever. Active tag filters apply in the bin (`useBin` sends them as `GET /api/bin?tag=`); the sidebar's tag counts stay live-only. `useBin(active, enabled)` fetches only while the bin is showing, refetches (debounced 250 ms, never overlapping) on every SSE `note` event and `open` from its own `EventSource`, and uses a generation counter like `useNotes` so an optimistic `dropNote`/`dropImage` is not overwritten by a stale fetch. `Bin` shows the image grid on top (gallery-style `galleryTile` flex, `data-bin-image`, `data-kind`, the note id and kind) and the deleted notes below as read-only wall-style cards (`data-bin-note`, cover with count, inert tag chips, id, relative deleted date), both newest deleted first, or `Nothing deleted.`. Each entry has icon-only Restore (`ArrowCounterClockwise`) and Delete forever (`Trash`); a `'note'` tile acts on its note, an `'image'` tile on the image. Delete forever turns the pair into `Check` (`Delete forever`) + `X` (`Cancel`) inline, one entry at a time; confirming drops it optimistically and calls `purgeNote`/`purgeImage`. Restore calls `restoreNote`/`restoreImage` and hands the live note to App's `onRestored` (`upsertLocal(note, true)` + refetch); a `DuplicateImageError` shows `already in <id>` on that tile. Failures are logged; every action refetches the bin.
- **Show in Explorer (iteration 7 phase 9, P1-NOTES-A031)**: `RevealButton({ image: { id, available }, className = 'copybtn', style? })` is an icon-only `FolderOpen` button (`Show in Explorer`, `data-reveal=<imageId>`). It renders only when `useCapabilities().reveal` is true and `image.available` (the original is on this machine), otherwise nothing. A click stops propagation and calls `revealImage`; a failure is only `console.warn`ed. Mount points: the photo modal toolbar for the shown image (`pm-btn`, between Copy ID and Show full screen), and every editor strip thumb (`ed-rm ed-reveal`, placed 34 px from the right, left of the remove icon). `useCapabilities` is a module-level store read with `useSyncExternalStore`: the first mount starts the page's single `GET /api/capabilities` (`loadCapabilities`, later calls are no-ops) and every caller sees `NO_CAPABILITIES` (`{ reveal: false }`) until it answers and forever if it fails (older daemon, offline, non-2xx). Since iteration 8 phase 5 the wall card no longer mounts `RevealButton` for `images[0]`; it mounts the note-level `NoteRevealButton` in the same place (see Note files).
- **Note files (iteration 8 phase 5, P1-NOTES-A038)**: `NoteEditor` takes optional `onAttachFiles(files)` and `onRemoveFile(file)`. With `onAttachFiles` its top bar shows a `Paperclip` button (`Attach files`) that clicks a hidden `<input type="file" multiple data-picker>`; the picked list is copied before the input is cleared, so the same file can be picked again. App's `attachFiles(noteId, files)` runs `routeFiles` (types in `ATTACHABLE_IMAGE_TYPES` go to `attachImage`, everything else, including svg, bmp and an empty type, to `attachFile`; the server still stores bytes it sniffs as an image as an image) via `attachRouted`, each result to `onAttached`, each failure to `onAttachFailed`, which shows `already in <id>` for `DuplicateFileError`/`DuplicateImageError` and otherwise `could not attach <name>` (plus ` (too large)` on 413) in the editor notice. Under the editor text, `FileChips({ files, onRemove? })` lists `note.files ?? []` as `ul.fchips[data-files]`, one `li[data-file=<id>]` per file: a kind icon (`fileKind`: by extension, then mime family), the name (full name in `data-tip`), a meta line `formatBytes · typeLabel` plus `on <host>` when not local (`.fchip.away`, dimmed), then Download (`a[download]` to `urls.download` or `fileDownloadUrl`, local only), a per-file `FolderOpen` reveal (`data-reveal-file`, only with `reveal` capability and `available`, calls `revealFile`) and, with `onRemove`, `X` (`Remove file`). App's `removeFileWithUndo` drops the file optimistically, calls `removeFile`, and pushes a `removed file` undo entry whose `run` calls `restoreFile` (a `DuplicateFileError` is only `console.warn`ed). `NoteRevealButton({ note, className = 'copybtn' })` is the note-level `FolderOpen` (`Show in Explorer`, `data-reveal-note`), rendered only with the `reveal` capability and `noteRevealable(note)` (has live files: some file local; no files: some image local); a click calls `revealNote` and failures are `console.warn`ed. It sits on every wall card's meta row right after Copy ID (replacing the old `images[0]` `RevealButton`) and in the editor top bar (`ed-btn`, before the paperclip). A card whose note has live files (local or not) shows a `.card-files` `Paperclip` + count (`data-files`, tip `1 file` / `N files`). The empty-note rules count files through `hasAttachments`, so a note holding only files is kept.
- **Chat**: `ChatBar` is fixed at the bottom; submit calls `useChat.ask`, which aborts any previous request, clears `status` and `brain`, opens `AnswerPanel` expanded (`collapsed: false`) and appends `delta` text as it streams. `event: status` sets `ChatState.status` to its `text` (`""` clears it). `done` stores `thread_id` for the next question, clears `status` and sets `ChatState.brain` from `done.brain` (null when absent, as with the stub); `error` (or a non-OK response) appends `Chat failed: ...` and also clears `status` with no brain. The panel header shows a dim mono caption after the query (`.answer-status`, prefixed with `·`): the status caption while streaming, the brain label (`claude` / `glm`) once done, nothing when either is empty. A follow-up while the panel is open continues the thread. Dismissing the panel (`close`, via the dismiss button or Escape) aborts the stream and clears the thread id, so the next message starts a new thread; a late `done` from the aborted stream cannot restore it. A pinned panel is never dismissed by Escape, so it keeps its thread. The panel shows a cursor while streaming, pin and dismiss buttons, and, once done, chips for every loaded note id the answer mentions (`extractUsedIds`: case-insensitive, first-mention order, not inside longer tokens). While an answer with used ids is open, the wall dims other cards to .22 and rings the used ones. Escape closes an unpinned panel.
- **Answer panel collapse (iteration 7 R6)**: a caret button (`Collapse` / `Expand`, `aria-expanded`) sits beside pin and dismiss and calls `useChat.toggleCollapsed`. Collapsed (`.answer.collapsed`), the panel shows only its header line above the chat bar, with no body and no used-id chips; clicking anywhere on that line expands it, while the icon buttons keep their own action. Streaming continues while collapsed. Every new answer and every dismiss reset `collapsed` to false. The header shows the query through `oneLine` (one line, no breaks) with the full query in `data-tip`.
- **Chat bar input (iteration 7 R7)**: the bar is an auto-growing `<textarea rows={1}>` (styles in `ChatBar.css`). Enter sends; Shift+Enter inserts a newline; Enter during IME composition (`isComposing` or keyCode 229) does nothing. It grows one line at a time up to `CHAT_MAX_LINES` (6; `CHAT_LINE_PX` 20, `CHAT_PAD_Y_PX` 20) then scrolls inside, and shrinks back after sending. Its height is published as `--chatbar-h` on `document.documentElement` (removed on unmount). `useChat.ask` trims only the ends, so inner newlines reach `/api/chat`.
- **Chat bar images (iteration 8 phase 3, P1-NOTES-A036)**: `ChatBar` takes optional `images: ChatBarImage[]` (`{ key, label, state: 'uploading' | 'ready' | 'failed', thumbUrl, error }`), `onPasteFiles`, `onRemoveImage`, `sendBlocked` and `variant` (`'wall'` default: the fixed pill that publishes `--chatbar-h`; `'page'`: laid out by its parent, publishes nothing, for later phases). The form carries `data-chatbar=<variant>`. A paste in the textarea with image files calls `onPasteFiles` (and `preventDefault`s); text pastes are untouched. Pasted images show as a `.chatbar-thumbs` row inside the pill (a spinner while uploading, `WarningCircle` with the error as tooltip when failed, the thumb when ready), each with an `X` (`Remove <label>`) that refocuses the textarea; the row adds `CHAT_THUMBS_PX` (56) to `--chatbar-h`. `sendBlocked` disables the send button and Enter. App wires `useChatImages()`: `add` uploads each file at once via `uploadChatImage` (past `MAX_CHAT_IMAGES` a file shows as failed, `at most 4 images per message`), a late result for a removed image is dropped, `readyIds` are the uploaded ids in paste order without repeats, and `blocked` is true while any image is uploading or failed. App's `send` returns while `blocked`, needs text or a ready image, calls `chat.ask(q, readyIds)` and then `clear()`. `useChat` keeps the sent ids as `ChatState.images` (cleared on dismiss); `AnswerPanel` shows them as thumbs (`.answer-images`, `chatImageUrl(id, 'thumb')`) above the answer when not collapsed, and an image-only question's header reads `1 image` / `N images`. `DropOverlay`'s document-level paste returns early when `chatBarHasFocus()` (`document.activeElement` inside `[data-chatbar]`), so a paste in the bar never makes a note; pastes elsewhere still create or attach as before.
- **Chat history page (iteration 8 phase 9, P1-NOTES-A042)**: `View` gains `'history'`. A `ChatsCircle` icon (`HISTORY_TIP` `Chat history`, `aria-pressed`) sits directly above the recycle bin on the rail and directly before it among the sidebar buttons; `toggleHistory` clears the thread focus and toggles between `history` and `wall`. The answer panel gets an `ArrowsOut` button (`Chat in full screen`, shown when `onFullScreen` is passed) that opens the page on `useChat`'s `threadId` (set from `accepted.thread_id`, then `done.thread_id`; cleared on dismiss). On the page App renders `HistoryPage` in `.main`, the header shows `HISTORY_HEADING` (`History.`), `historyCountLine` (`N messages in M threads.`, `Latest N ...` while older pages exist) and `HISTORY_HINT`, no Last edited link or sticker, and hides the wall `AnswerPanel` and wall `ChatBar`; Escape does not dismiss the (hidden) wall conversation there.
  - **URL sync**: App is the single owner. Initial state comes from `routeFromLocation(window.location)`, so `/history` and `/history?thread=ID` load straight into the page (`staticRoutes` serves them through the SPA fallback). An effect pushes `hrefForView(view, historyThread, location)` when non-null: entering the page pushes `/history[?thread=]`; leaving it pushes `/` only when the path is `/history`; wall and bin never rewrite a non-history URL, so `/?note=ID` survives (phase 11's show-on-wall depends on this). A `popstate` listener maps back/forward onto `view`/`historyThread`; `/?note=` targets stay with `useDeepLink`'s own listener.
  - **Store**: `useHistory(view === 'history')` lives in App for the whole session so a reply keeps streaming after leaving the page; it fetches and listens only while enabled. It loads the latest page (`HISTORY_PAGE` 50) on enable, after each send, and (debounced 150 ms, one load in flight, a request during it reruns once) on every `event: chat` and `open` via `subscribeEvents`; `op: 'deleted'` drops that id at once unless `includeDeleted`. A latest page is authoritative for everything newer than its oldest row (`mergeMessages` with `authoritativeFrom`; `-Infinity` when `next_before` is null), so rows missing from it are treated as deleted; only the first load sets the paging cursor. `loadOlder()` pages back with `next_before`, shares an in-flight call and resolves to the page's messages (`[]` when nothing older). `mutate(fn)` is the optimistic seam for phase 10's edit/delete/restore; `includeDeleted` (never set in phase 9) refetches with `include_deleted=1`.
  - **Send**: `send(text, imageIds)` returns false (keep the draft) when empty or while a reply streams. The thread comes from `threadForSend`: the newest live, non-error message decides; a wall message continues its thread, a `claude_code` message (or nothing) starts a new one. It adds two `LocalBubble`s at once (the question with `chat_image` attachments, and a streaming reply), then `streamChat`: `accepted` sets the user bubble's `serverId` and thread, `delta` appends, `status` sets the caption, `done` sets both server ids, brain and thread; `error`, a non-OK response or a stream that ends without `done` makes the reply an error bubble (`Chat failed: ...`) and marks an unaccepted question `not sent`. `timelineOf` shows server rows then local bubbles the server does not hold yet; `pruneLocal` drops a local bubble once its server row arrives (never while streaming).
  - **Page**: `HistoryPage({ store, focusThread, now })` is a 760 px column that scrolls with the window: an `Earlier messages` button while `hasMore` (also auto-paged within 240 px of the top), a load error or empty note, an `<ol class="hist-list">` with a `ThreadDivider` (`wall chat` / `claude code` / `new thread` · time) wherever `thread_id` changes, and its own `HistoryComposer`: `ChatBar variant="page"` with its own draft and its own `useChatImages()`, so the wall bar's draft and pasted images are untouched. It stays pinned to the bottom when within 80 px of it, keeps the reading position when older pages prepend, and with `focusThread` scrolls the thread's newest bubble into view and outlines the thread's bubbles for 2.4 s, paging older up to 5 times to find it.
  - **Bubble**: `Bubble({ item, now, focused, onOpenImages })`: user bubbles right (`.mine`), answers left (`.theirs`), a `claude code` badge for `source: 'claude_code'`, chat-image thumbnails in fixed `THUMB_H` (96 px) square boxes with `object-fit: cover` (the phase 7 wire has no dimensions; `thumbWidth` honours dimensions if a later wire adds them), linkified paragraphs (`segmentLinks`), a streaming cursor or `thinking` placeholder, the error line, `note_image`/`note_file` attachments as `image <id>` / `file <id>` chips, and a meta row with `chatTime` (Jakarta, UTC+7: `HH:mm` today, `D Mon HH:mm` this year, `D Mon YYYY HH:mm` otherwise; tooltip `chatTimeTitle` full ISO with `+07:00`) plus the status caption while streaming or the brain once done. Rows carry `data-msg`, `data-msg-key`, `data-thread`.
  - **Lightbox**: a history thumbnail opens the phase 2 `Lightbox` on that message's images (`lightboxItemsOf`: display URL, label `upload:<id>`), arrows moving across them. The wall answer panel's sent thumbnails, inert since phase 3, are now `.answer-image` buttons that open the same `Lightbox` (display variant) over the panel.
- **Tooltips**: one document-level `mouseover` listener renders `[data-tip]` text above the element, or to its right with `data-tip-side="right"`. Buttons are icon-only with `data-tip` and `aria-label`.
- **Layout**: a 56 px rail, an optional 240 px sidebar (main margin 296 px when open), the chat bar and answer panel offset to match. The answer panel sits at `bottom: calc(var(--chatbar-h, 54px) + 32px)` with its max height reduced by the same variable, so it stays above a grown chat bar.

### Images (phase 8)
The four phase-7 stubs are now real. Since iteration 7 phase 6 (P1-NOTES-A028) they work per image: `NoteImage` takes one image, and `Gallery` and `PhotoModal` take the flattened `PhotoItem[]` from `photosOf` (`{ note, image, k, n }`, one per image, notes in wall order, images in position order, `k` 1-based of `n`).

```ts
// components/NoteImage.tsx
const FILM_FILTER = 'sepia(.14) saturate(1.12) contrast(1.05) brightness(.97)'
type ImageInfo = Pick<NoteImage, 'id' | 'width' | 'height' | 'available' | 'host'>   // any wire NoteImage is assignable
type ImageVariant = 'thumb' | 'display'                    // URLs come from api.ts imageUrl(image.id, variant)
function aspectOf(image): { w; h; ratio; css }             // 3:2 fallback for missing or zero dims
function ImagePlaceholder({ aspect, caption, host?, width?, onClick? })   // role=img, ImageBroken icon, Geist Mono caption
function NoteImage({ image, variant = 'thumb', className?, style?, onClick? })
// components/Gallery.tsx
const GALLERY_ROW_HEIGHT = 230
function galleryTile(image): { grow; basis; ar }           // flex grow = w/h, basis = round(w/h * 230)
// components/PhotoModal.tsx
function stepIndex(i, d, len): number                      // wraps both ways; -1 when empty
function stripTags(body): string                           // hashtags removed, whitespace collapsed
function metaLine(index, len, item: {k; n}, when): string  // `3 / 7  2/3  Today`; `k/n` only when n > 1
function PhotoModal({ items: PhotoItem[], index, onIndex, onClose, copiedId, onCopy })
// components/DropOverlay.tsx
type UploadResult = { note; created }
interface DropOverlayProps { onImageAdded(note); target?: string | null; onAttached?(result: AttachResult, target); onAttachFailed?(file, err) }   // target/onAttached: iteration 7 phase 7; onAttachFailed: iteration 8 phase 5
imageFiles(files), firstImageFile(files), hasFiles(dataTransfer)
uploadImage(file, fetchImpl?): Promise<UploadResult>       // POST /api/images multipart `file`; throws on non-2xx
flashNote(id, delayMs = 450)                               // scrolls [data-note=id] into view, pulses an outline
// fullscreen/view.ts
const DRAG_THRESHOLD = 4; viewReducer(View, down|move|up|leave); imgStyleFor(view, natural, dpr); cursorFor(view)
// fullscreen/FullscreenApp.tsx
idFromLocation(loc): string | null                         // image id from /full/<imageId>, else ?id=
describeMissing(imageId, fetchImpl?): Promise<{ caption; host; w; h }>
function FullscreenApp({ id })
```

- **NoteImage**: renders one image by its id. `thumb` (wall cover, gallery tile; lazy, full width, aspect-ratio height) or `display` (modal; capped at `100vh - 48px`). Both carry `FILM_FILTER`. `!image.available` renders the placeholder "not on this machine" with `image.host` on a second line; an `<img>` error renders "unavailable" (the error is keyed by `<imageId>/<variant>`). Callers decide whether a note has an image; there is no null case.
- **Gallery** (`items: PhotoItem[]`): a flex-wrap justified layout (gap 4, trailing `flex: 999` spacer), one tile per image keyed by image id with `data-photo=<imageId>` and `data-note=<noteId>` (so `flashNote` and jump-to-note find a note's tiles). It owns the open image by image id (so the modal closes if that image leaves the filtered list) and portals `PhotoModal` into `document.body`.
- **PhotoModal**: backdrop click closes; image and side panel clicks do not. A capture-phase `keydown` on `window` handles Escape (close), ArrowLeft/ArrowRight (wrap over the flattened list, so through a note's images first, then on to the next note) with `preventDefault` + `stopPropagation`, so App's Escape never closes the chat panel behind it. The side panel shows the body without tags, tag chips, the note id with "copied" (App's `copiedId`; Copy ID copies the note id), the `metaLine` (`i / len` over all images, then `k/n` within the note when it has several, then the note's relative date), and icon buttons Copy ID, Show full screen (`window.open('/full/<imageId>', '_blank', 'noopener')`) and Close. Since iteration 7 phase 8 an optional `onDelete(note)` adds a `Delete note` trash icon that soft-deletes the shown photo's note and closes the modal. Since iteration 7 phase 9 a `RevealButton` (Show in Explorer) for the shown image sits between Copy ID and Show full screen when the daemon can reveal and the image is local. `PhotoModal.css` only adds the `.pm-btn:hover` background.
- **DropOverlay**: document-level `dragover`/`dragleave`/`drop`/`paste`. The dashed overlay shows only for drags that carry `Files`. A drop uploads every image file; a paste uploads only the first and is otherwise left alone (text paste keeps working). Uploads run one at a time on a promise queue; each result goes to `onImageAdded(note)`, and a dedupe hit (`created: false`) also gets `flashNote`. Failures are `console.error`ed only. Since iteration 7 phase 7, when `target` is set (App passes the note open in the big editor) each file instead goes `attachImage(target, file)` and the result to `onAttached`; the target is captured when files are enqueued. The overlay then shows a `Paperclip` icon with `data-drop-overlay="attach"` (`"new"` and `ImageSquare` otherwise). App's `onAttached` upserts the returned note (the holder, maybe restored) and, on a dedupe hit (`attached: false`), shows `already in <id>` in the editor's notice label for 2.4 s. Since iteration 8 phase 5, with a target set, a drop or paste routes every file through `routeFiles` (supported images to `attachImage`, everything else to `attachFile` via `attachRouted`) and a paste attaches every pasted file (`pastedFiles(files, true)`); a failed attach goes to `onAttachFailed`. Without a target the old rules hold: a drop uploads only image files and a paste only the first image, so a pasted PDF on the wall is ignored.
- **Full-screen tab** (`/full/<imageId>`, `fullscreen.html`): the path segment is an image id (a legacy first image's id equals its note id, so old links still work). Sets `document.title` to the id, shows the `display` variant on black with no film filter. It starts in fit mode; a click (movement within 4 px) toggles fit and 1:1, where 1:1 is natural size divided by `devicePixelRatio` and a drag pans. On image error `describeMissing` re-fetches the display URL (`/api/images/:imageId/display`; 404 `not_on_this_machine` gives the caption plus host, other 404s give "not found", anything else "unavailable") and `GET /api/images/:imageId` (the wire `NoteImage`) for the aspect ratio.

## Deployment (phase 3)

Full guide: `docs/INSTALL.md`. Nothing in `src/` changed for this phase.

### deploy/notesd.service
systemd **user** unit template. `Type=simple`, `ExecStart="@NODE_BIN@" "@REPO_DIR@/dist/main.js"`, `WorkingDirectory=@REPO_DIR@`, `NODE_ENV=production`, `NOTES_DATA_DIR=@DATA_DIR@`, `PATH=@NODE_DIR@:/usr/local/bin:/usr/bin:/bin`, `HOME=@HOME_DIR@` (where the Agent SDK child finds `~/.claude/.credentials.json` and keeps sessions), `NOTESD_CLAUDE_BIN=@CLAUDE_BIN@` (absolute real path of `claude`), `Restart=on-failure` (5 s), `StartLimitIntervalSec=0`, `TimeoutStopSec=15`, `WantedBy=default.target`. Edit the template, not the rendered copy in `~/.config/systemd/user/notesd.service`.

### scripts/install.sh
Idempotent; re-run after every pull. Flags: `--skip-hooks` (leave `~/.claude/settings.json` alone), `-h`/`--help`; any other argument is an error. Env overrides: `NODE_BIN` (Node >= 22; default `node` on PATH, then `~/tools/node-v22.23.1-linux-x64/bin/node`), `CLAUDE_BIN` (default `claude` on PATH, then next to node), `NOTES_DATA_DIR` (default `~/mcp-notes-data`), `SKIP_CHAT_CHECK=1` (skips the chat smoke check, for offline runs), `NOTES_SKIP_HOOKS=1` (same as `--skip-hooks`), `NOTES_PASTE_STRATEGY` (`updatedInput` default, or `deny`). Since iteration 8 phase 8 `main` runs only when the script is executed, so tests can `source` it. Steps, in order:
1. Resolve node (absolute, `readlink -f`) and npm next to it; resolve the `claude` CLI and its real path (`readlink -f`, must be an executable file), which the unit gets as `NOTESD_CLAUDE_BIN`.
2. Preconditions: curl, a reachable `systemctl --user`, the unit template, `SKILL.md`, `package-lock.json`; paths (including the real claude path and `$HOME`) free of `| & \` (sed renderer); refuses if `~/.claude/skills/n` exists and is not a symlink. Then warn-only checks: `~/.claude/.credentials.json` missing (Claude login), `.env.local` missing or lacking a complete `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (GLM fallback off).
3. `npm ci` only when `node_modules` is missing or older than `package-lock.json`; then `npm run build` (must produce `dist/main.js`).
4. `mkdir -p` the data dir.
5. Render the unit with sed (fails on any leftover `@X@`), install it only if changed, `daemon-reload`, `enable`, `restart`.
6. `loginctl enable-linger $USER` (tries plain, then `sudo -n`; otherwise warns with the command to run).
7. Poll `GET http://127.0.0.1:7317/health` for up to 30 s; on timeout dumps `journalctl` and fails.
8. `claude mcp remove --scope user notes` (ignored), then `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
9. `ln -sfn <checkout>/claude/skills/n ~/.claude/skills/n`.
10. `register_hooks` (iteration 8 phase 8, unless skipped): `node scripts/claude-hooks.mjs install` merges the `notes-capture` (Stop) and `notes-paste` (PreToolUse) entries into `~/.claude/settings.json`, pointing at this checkout's `claude/hooks/` and the resolved node. A failure only warns; the daemon install is not undone. Preconditions also check both hook scripts and the helper exist and that `NOTES_PASTE_STRATEGY` is valid.
11. Verify: unit `active`, `/health` answers, `claude mcp list` shows `notes:` as Connected, the skill links, `claude hook:` lines from `claude-hooks.mjs status` (or `claude hooks: skipped`), prints the chat claude path and version, and a chat smoke check: one read-only message (`POST /api/chat`, 200 s curl limit) whose SSE stream must end in `event: done`; it prints the answering brain and warns if it is not `claude`. Exits non-zero otherwise. Warns when the checkout (unit, skill and hooks) is under `~/.worktrees/`.

### scripts/uninstall.sh
Disables and stops the unit, deletes the unit file, `daemon-reload`, `reset-failed`; `claude mcp remove --scope user notes`; removes `~/.claude/skills/n` only if it is a symlink; `unregister_hooks` (iteration 8 phase 8) runs `claude-hooks.mjs uninstall` on `~/.claude/settings.json` when it exists (node from `NODE_BIN`, PATH or the default tools path; otherwise warns to remove the entries by hand), keeping every other setting and hook. Keeps the data dir, linger, the hooks' outbox and logs (`~/.local/state/notes-capture`) and `settings.json.bak-notes-hooks`, and prints the Windows `-Uninstall` command. Split into functions with `main` run only when executed.

### scripts/windows/install-wsl-keepalive.ps1
Registers a Task Scheduler task (default name `mcp-notes WSL keepalive`) at logon of the current user, `RunLevel Limited` (runs as the user, no elevation), action `conhost.exe --headless wsl.exe -d <Distro> -- sleep infinity` (no console window). Settings: no execution time limit, runs on battery, `StartWhenAvailable`, `MultipleInstances IgnoreNew`, restarts 3 times at 1 min, hidden. Params: `-Distro` (default `Ubuntu`, validated against `wsl --list --quiet`), `-TaskName`, `-NoStart`, `-Uninstall`. Starts the task immediately unless `-NoStart`. Registration normally needs no admin; on "Access is denied" it tells you to re-run elevated. Why it exists: WSL shuts an idle distro down (`instanceIdleTimeout` 15 s default) once no Windows-side `wsl.exe` is attached, and systemd services and linger do not count as activity. The `.wslconfig` `instanceIdleTimeout=-1` alternative is documented but not chosen because nothing would boot WSL at logon.

### claude/skills/n/SKILL.md
Claude Code skill `n` (`/n <request>`, also triggered by note save/find/edit/compare requests). Tells Claude to use only the `mcp__notes__*` tools, and sets conventions: pass `origin` (`cwd`, `repo` = git top-level basename, `claude_session` only if known) on every `create`/`update`; plain-text bodies with no markdown, hashtags on the last line, reuse existing tags (`tags` first), never secrets; how to route ids to `get`, tags to `list`, topics to `search`; edits via `get` then full-body `update`, `append`, `revisions`/`revert`; comparisons as two filtered calls analysed by Claude, in Asia/Jakarta time with Monday-start weeks, citing ids; images (iteration 7 phase 10): a note holds an ordered `images` list with per-image ids, `create_image`/`attach_image`/`remove_image`/`restore_image`/`view_images` (at most 8 per call, follow the overflow line), remove by image id picked from `get`, a missing image tool means an outdated `notesd` (re-run `install.sh`); soft deletes of notes or images only on request, with no permanent delete from Claude ("delete forever" lives only in the wall's recycle bin); a `Spending, runs and Seer` section (iteration 5 phase 5) that routes spending/expense, run/training and Seer/Sera questions to the connector tools instead of the notes, curated tools first with per-tool guidance (`expenses_spending`/`_months`/`_get`, `runs_list`/`_get`/`_review`, `seer_leaderboard`/`_positions`/`_sera_best`), `_schema` before `_sql`, read-only; and a troubleshooting order (`systemctl --user status notesd`, `/health`, `journalctl`, re-run `install.sh`) with no fallback to writing files. Since iteration 8 phase 8: a pasted image shows as `[Image #N]` with no file path, so "find similar" calls `similar_images` with `pasted_image: N` (the hook turns it into `upload_id`), then `view_images` on the top hits; an unresolved paste gets a one-line ask to paste again with the request, never a request for a file path; and a `Chat history` section says every `/n` exchange is saved to the wall's chat history by a hook (badged "claude code"), so Claude does not save it itself.

## Data Flow

Startup (`src/main.ts`): `loadConfig()` feeds `startDaemon()`, which creates the data dirs, builds the embedder (null without `OPENROUTER_API_KEY`) and calls `createDb()`. It then builds `NoteEvents` and `NotesService`, picks the chat backend (injected, or the Agent SDK backend), then `createApp()`, and serves Hono on 127.0.0.1.

MCP call: Claude Code POSTs to `/mcp`, `loopbackOnly` checks the host, and `handleMcpRequest` builds a fresh server. The tool handler calls `NotesService`, which calls `repo` (Drizzle), which queries Postgres. The result goes back through `rowToNote` as a `Note` JSON text result.

Hybrid search (iteration 6 phase 4): MCP `search` calls `NotesService.search(query, filter, { mode })`. Unless `mode` is `text`, the service embeds the query (cache hit, or one OpenRouter call capped at 5 s), runs `repo.searchCandidates` (full-text matches, nearest current vectors via HNSW, ids named in the query; all filtered first), scores them with `rankCandidates` and returns the page with `mode: 'hybrid'`. No embedder, or a failed or slow embedding, returns `repo.searchNotes`' ranking with `mode: 'text'` and a `fallback` sentence. `/api/notes` does not expose search, so the web UI is unaffected.

Write path: `requireId` and `parseTags(body)`, then one transaction: lock the row, insert the previous body into `note_revisions`, update `notes`. After commit, `NoteEvents.emit(op, id)`. With an embedder configured, `created`/`updated` events kick the embedding worker (iteration 6 phase 3): after a 500 ms debounce it runs `runBackfill`, which lists pending notes, embeds them in batches of 16 through OpenRouter (1 s apart) and saves each vector only if the body still hashes the same; failures go to `recordFailure` and come back on a later 60 s sweep once due. The write itself never waits. `npm run embed:backfill` runs the same loop once against the configured database. Shutdown (signal) runs `stop()`: background jobs, then server close, then `closeDb()`.

Inbox ingest (phase 4): a file lands in `<dataDir>/inbox`. chokidar reports it, and the watcher waits for its size to settle and sniffs the magic bytes. `ingestImage` then hashes it and looks up `ImageRecords.bySha256Live`. A live image's holder note is returned, restored first if deleted. Otherwise the file is probed, moved to `images/YYYY/MM/<id>.<ext>`, and `NotesService.create` inserts the note and its first `note_images` row in one transaction with `origin.source = 'inbox'`, which emits `created`. Any failure moves the file to `inbox/failed/`. Before the watcher starts, `startBackground` runs `reconcileLegacyImages` so legacy images are dedupe targets. Derivatives (`cache/<imageId>/...`) are not made at ingest. They are generated on first read.

Images over HTTP and MCP (phase 5): `POST /api/images` and `create_image` both end in `ingestImage` (bytes from the multipart file, or a copy of the local path), so they share dedupe and `NotesService.create`, which emits `created`. Image reads go `resolveImageFile` (image id; `/api/images/:imageId/:variant` and `view_images`) or `resolveNoteImageFile` (the `/api/notes/:id/:variant` alias), then `locateImage` / `locateNoteImage`, then the derive getter for the variant (generated and cached on first read under `cache/<imageId>/`), then a streamed file for HTTP or a base64 `image` block for `view_images`. Note reads attach `images[]` through one `imagesForNotes` query per page. If the original is not on this machine the answer is 404 `not_on_this_machine` (HTTP) or a text line (MCP).

Attach / remove / restore one image (iteration 7 phase 3): `POST /api/notes/:id/images` and `attach_image` go `attachFromUpload` / `attachFromPath` -> `ingest.attachImage` (dedupe under the sha lock, place the file) -> `NotesService.attachImage` (note locked, row at `nextPosition`, `touchNote`) -> `updated`. `DELETE /api/images/:imageId` / `remove_image` and `POST /api/images/:imageId/restore` / `restore_image` call `NotesService.removeImage` / `restoreImage` directly (`lockImage`, `setImageDeleted`, `touchNote`), which emit `updated` (or `restored` when a deleted note came back) with the note id; files on disk are never touched.

Recycle bin (iteration 7 phase 4): `GET /api/bin` -> `NotesService.listBin` -> `binRepo` reads -> `Bin`. `POST /api/notes/:id/restore` -> `NotesService.restore` -> `restored`. Delete forever is HTTP only: `DELETE /api/bin/notes/:id` and `DELETE /api/bin/images/:imageId` pass `sameOriginOnly`, then `purgeNote` / `purgeImage` lock and check the row (`not_deleted` for live items), hard-delete it in one transaction, remove originals under `images/` and derived files under `cache/<imageId>/` with `removeImageFiles` after commit, and emit `purged`. No MCP tool and no chat-allowed tool can purge.

Web UI (phase 6): the browser loads the SPA through `staticRoutes`, then calls `/api/notes` and friends. Those handlers call `NotesService` like MCP does and map `NoteError` to a status. The UI holds `/api/events` open: a write from any source (MCP, web, inbox) goes `NotesService`, then `NoteEvents.emit`, then the SSE listener, then `event: note`, and the UI refetches. Chat: `POST /api/chat` goes to `ChatBackend.reply`, whose `delta`/`status` events stream back as SSE, ending with `done { thread_id, brain? }`. With the default backend (iteration 4 phase 2), `reply` spawns a Claude Code child through the Agent SDK in `<dataDir>/chat`; the child calls the notes tools over this daemon's own `POST /mcp` (so its reads and writes go through `NotesService` and emit `NoteEvents` like any MCP client), streams text and tool use back. Since iteration 8 phase 7 the turn is persisted and stateless: validate -> `ChatService.addUserMessage` (user row, attachments, `created` chat event) -> `event: accepted` -> `composeWallTurn` (`loadTurnContext` -> `buildTurnContext` -> reply-target images) -> `backend.reply({ turn, signal })` (no `resume`, `persistSession: false`) -> deltas through `CitationFilter` -> on a clean finish `addAssistantMessage` (with the cited `reply_to`, `created` chat event) -> `event: done { thread_id, user_message_id, assistant_message_id, reply_to, brain? }`. The next message passes our `thread_id`. Edits, deletes and restores go `chatHistoryRoutes` -> `ChatService` -> `ChatEvents` -> `/api/events` `event: chat`.

Web UI client (phase 7): `useNotes` fetches `/api/notes?limit=2000` and `/api/tags`, keeps `EventSource('/api/events')` open and refetches (debounced 250 ms) on each `note` event, on reconnect and every 60 s. `App` derives the wall from `notes`, `mode` and active tags with the pure `lib/filter` helpers. An edit is applied locally first (`upsertLocal`/`removeLocal`), then sent with `PATCH`/`DELETE`/`POST`, then followed by a refetch; the server's resulting `NoteEvents` emit triggers another refetch through SSE. Chat reads the `POST /api/chat` response body with `readSSE`, since `EventSource` cannot POST.

Web UI images (phase 8): a drop or paste in the SPA goes `DropOverlay`, then `POST /api/images` (one file at a time), then `onImageAdded` inserts the note locally; the server's `created` event refetches through SSE as usual. Since iteration 7 phase 6, tiles and card covers load `/api/images/:imageId/thumb`, the modal loads `/api/images/:imageId/display`, and the full-screen tab (served `fullscreen.html` for `/full/:imageId`) loads `display` and, on error, reads the 404 body to tell "not on this machine" from "not found". While the big editor is open (iteration 7 phase 7), a drop or paste goes `DropOverlay` -> `POST /api/notes/:id/images` for the edited note -> `onAttached`, and the strip's remove icon goes `DELETE /api/images/:imageId`; both refetch, and the server's note event reaches other tabs through SSE. Iteration 7 phase 8: a trash icon goes `DELETE /api/notes/:id` (after a `PATCH` of a changed editor draft) and its undo `POST /api/notes/:id/restore`; the strip's undo goes `POST /api/images/:imageId/restore`. The bin view reads `GET /api/bin?tag=` through `useBin` (its own `EventSource` refetches on note events), restores through the same restore routes and purges through `DELETE /api/bin/notes/:id` / `DELETE /api/bin/images/:imageId`, which the page's own Origin header lets past `sameOriginOnly`; purges emit `purged`, so other tabs' walls and bins refetch.

Connector call (iteration 5 phase 1): Claude calls e.g. `runs_sql` on `/mcp`. The handler runs `guardSelect` (`<id>_sql` only), then `connector.query`: settings and the sibling repo's `.env.local` are read now, a new read-only `pg.Client` connects to the direct host, runs the wrapped SELECT inside `BEGIN READ ONLY`, rolls back and closes. The capped rows return as compact JSON. Seer `source: "lab"` instead spawns a `node -e` child that opens `<seer>/lab/lab.sqlite` read-only and replies on stdout. Any failure becomes a `ConnectorError` whose bare message is the tool's `isError` text; nothing touches `NotesService` or emits `NoteEvents`.

Curated expenses call (iteration 5 phase 2): `expenses_spending` validates the range in JS, then runs the by-day, by-category and largest-items queries in parallel (three read-only connections), each with `$3::text[]` as the category filter (NULL = all). The rows are shaped in JS: day totals, zero-filled ISO weeks, merged categories with share percentages, and `today_wib` from the wall clock. `expenses_get` and `expenses_months` work the same way with their own queries.

Note files (iteration 8 phase 4): `POST /api/notes/:id/files` -> `attachUpload` (image sniff -> `attachImage`, else `files/ingest.attachFile`: dedupe under the sha lock, write `files/<noteId>/<safeName>`) -> `NotesService.attachFile` (note locked, row at `nextFilePosition`, `touchNote`) -> `updated`. `DELETE /api/files/:id` / `POST /api/files/:id/restore` -> `removeFile` / `restoreFile` -> `updated` (or `restored`). Reads: every `toNotes` call loads live files with `filesForNotes`, so MCP JSON, `/api/notes` and SSE refetches all carry `files`; `GET /api/files/:id/download` streams the bytes via `locateFile`. Reveal: `POST /api/files/:id/reveal` selects the file, `POST /api/notes/:id/reveal` opens the note's folder (or selects its first image). `purgeNote` deletes the rows by cascade and the bytes and folder after commit.

Claude Code capture (iteration 8 phase 8): a Claude Code turn ends -> `notes-capture.mjs` (async Stop hook) reads the transcript -> `/n` turn? -> spool `<stateDir>/outbox/<user uuid>.json` -> retry older outbox files -> `POST /api/capture/claude-code` (`captureGuard`, zod, base64 decode) -> `captureClaudeCodeExchange`: `ingestChatImage` per pasted image (`chat_images`, `source claude_code`) -> `ChatService.recordExchange` (one transaction: `claude_code` thread keyed `<session>:<user uuid>`, user row with `chat_image` attachments, assistant row) -> `ChatEvents` -> `/api/events` `event: chat` -> the wall's chat history. 2xx removes the spool file; a down daemon leaves it for the next turn's hook run.

Pasted-image search (iteration 8 phase 8): the model calls `mcp__notes__similar_images({ pasted_image: N })` -> `notes-paste.mjs` (PreToolUse) reads the transcript, picks `[Image #N]` from the latest image-carrying prompt -> `POST /api/chat/images` (`source=claude_code`) -> `upload_id` -> `updatedInput` (or a deny with the exact retry arguments) -> `/mcp` `similar_images` with `upload_id` -> embedded on the fly, never stored, as for wall-chat uploads.

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
- `embeddings/repo` uses `db/schema` (`notes`, `noteEmbeddings`), the `Executor` type from `notes/repo`, `embeddings/constants` and `embeddings/state`. `embeddings/state` uses only `embeddings/constants`. `embeddings/openrouter` uses `embeddings/{constants,embedder,state}` and the `EmbeddingsConfig` type; `embeddings/embedder` depends on nothing internal. `daemon` imports `embedderFromConfig`; `deps` and `notes/service` import only the `Embedder` type. `tests/helpers/fakeEmbedder.ts` uses `embeddings/{constants,embedder}`.
- `notes/service` uses `notes/{repo,ids,tags,types,events}`. `notes/repo` uses `db/schema`, `notes/dates` and `notes/types`.
- `mcp/tools` uses `NotesService`, `NoteFilter` and `NoteError`. `mcp/server` uses `tools`, `imageTools` and `instructions`.
- `http/api` uses `chat/{backend,stub}`, `notes/{events,ids,repo,types}` and `AppDeps`. `http/static` uses only the filesystem. `http/imageAccess` uses `images/{derive,ingest,probe,records}`, `notes/ids` and `ToolDeps`; `http/images` uses `imageAccess` and `images/ingest`; `mcp/imageTools` uses `imageAccess`, `notes/ids` and `ToolDeps`.
- `http/app` uses `mcp/server` and the `http/{api,images,static}` routers. `daemon` wires `config`, `db/client`, `embeddings/openrouter`, `notes/{events,service}`, `chat/agent`, `http/app` and `background`.
- `chat/agent` uses `chat/{backend,env,prompt,status}` and the `Config` type. `chat/prompt` uses `localTimeZone` from `mcp/instructions` and `OMITTED_LINE` from `chat/context`.
- (iteration 8 phase 7) `chat/service` uses `chat/{repo,ids,types,events,context}` and `db/client`; `chat/repo` uses `db/schema`; `chat/ids` uses `ID_ALPHABET` from `notes/ids`; `chat/turn` uses `chat/{context,images,service}`; `http/chatApi` uses `chat/{service,types}` and `sameOrigin`; `http/api` additionally uses `chat/{citation,events,ids,service,turn}` and `chatApi.chatErrorResponse`; `http/app` mounts `chatHistoryRoutes`; `deps` and `daemon` use `chat/service`. `chat/status` and `chat/env` depend on nothing internal (status mirrors the tool names in `mcp/tools` and `mcp/imageTools`).
- `tests/integration/setup.ts` imports `createDb`, `closeDb`, `isNeonUrl`.
- `connectors/*` depend only on each other plus `config` (`REPO_ROOT`, `isPooledUrl`) and `mcp/tools` (`run`, in `schema` and `sql`). `mcp/server` uses `connectors/register`; `mcp/tools` imports `ConnectorError`/`Connectors` from `connectors/types`; `mcp/instructions` imports `connectors/names`.
- `images/ingest` uses `images/{probe,store,records}`, `NotesService` (as `ImageNotes`), `NoteError` and `AppDeps`. `images/derive` uses `probe` and `store`. `images/inbox` uses `probe` and `store`. `images/records` uses `db/schema` and `notes/ids`. `background` wires `images/{ingest,inbox,store}`.

### Standard library
`node:crypto` (`randomInt`, `randomUUID`, `createHash` in `embeddings/state`), `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`, `node:events`, `node:net` (type only), `node:child_process` (the lab reader), `node:sqlite` (inside the lab child only; needs Node 22.5+).

## Reverse Dependencies

`src/main.ts` is the production entry (`npm run dev` / `npm start`), and Claude Code connects to `http://127.0.0.1:7317/mcp`. Phases 4-6 plug in through `startBackground`, `registerImageTools` and `imageRoutes`, plus `NoteFilter`/`noteFilterShape`/`buildInstructions` sections. The web UI reads images from `/api/notes/:id/{thumb,display,original}` and uploads to `/api/images`; the `/n` skill drives `create_image` / `view_images`. The web UI consumes `/api/*`, `/api/events` and `/api/chat`; since iteration 4 phase 2 the chat brain is itself an MCP client of `/mcp`, so any change to the notes tool names must also update `NOTES_TOOL_NAMES` in `src/chat/status.ts`. Connector phases 2-4 replaced the expenses, runs and Seer `curated.ts` stubs on the phase 1 harness (`tests/integration/connectors/harness.ts`); phase 5 added `ALL_CONNECTOR_TOOL_NAMES` to the chat bar's allow list. Tests: `tests/unit/{ids,tags,config,db-client,notes.helpers,mcp.instructions}.test.ts` and `tests/integration/{schema,notes.service,mcp.tools,daemon}.int.test.ts`, plus phase 6's `tests/unit/{chat-stub,static}.test.ts` and `tests/integration/{api,events}.int.test.ts`, and phase 5's `tests/unit/{takenFilter,imageAccess}.test.ts` and `tests/integration/images.{http,mcp}.int.test.ts`.

## Concurrency

The only global state is `neonConfig.webSocketConstructor`, set in `createDb`. A `Db` wraps a connection pool and is safe for concurrent queries. Concurrent writes to one note serialise on the `SELECT ... FOR UPDATE` row lock inside each service transaction. Inserts do not lock: an id clash returns null and is retried. `NoteEvents` listeners run synchronously on emit, after commit. MCP requests share nothing: each gets its own server and transport. Each `/api/events` connection adds one `NoteEvents` listener and one heartbeat interval, both removed on abort. SSE writes from listeners are fire-and-forget and swallow write errors after the client goes away. Integration test files run one at a time (`fileParallelism: false`) because they share and truncate one database.

Image ingest keeps a per-process promise chain per sha256, so two ingests of the same bytes in one daemon run in sequence. Across hosts, the unique live-sha256 index decides, and the loser gets `duplicate_image` and returns the winner. Derivative generation shares one in-flight promise per output path and writes through a temp file and rename. The inbox watcher handles one file at a time on a single promise queue.

The embedding worker runs at most one drain at a time per daemon; events during a drain set a flag for one more pass, and all embed calls share one `RateLimiter`. Two daemons (two laptops) may embed the same note: `saveEmbedding` upserts only for the current body hash and `recordFailure` never overwrites a current vector, so the race is harmless.

The agent chat backend allows one run in flight per daemon: a new `reply()` aborts the previous run (`superseded`) before starting. Each run owns an `AbortController` that the client signal, the timeout timer and `close()` all trigger; each SDK attempt gets its own child controller relayed from it and aborted when the attempt is not drained.

## Error Handling

- `ConfigError` (config), `InvalidIdError` (ids, carries `input`), `RangeError` (generateId with a bad injected RNG).
- `NoteError` with `code` is the service's only deliberate error. Its codes: `invalid_id`, `invalid_input` (bad date, cursor or empty search), `not_found`, `deleted`, `not_deleted` (purge of a live note or a non-removed image, iteration 7 phase 4), `empty_body`, `conflict`, `duplicate_image` (Postgres 23505 on the live-sha256 index), `duplicate_file` (the same for `note_files`, iteration 8 phase 4), `invalid_revision` and `not_embedded` (`related` on a source with no current vector that cannot be embedded now, iteration 6 phase 5).
- MCP handlers never throw. `run()` turns errors into `isError` results with text `"<code>: <message>"`, the bare message for a `ConnectorError`, or `"error: <message>"` for anything else.
- `ConnectorError` (connectors) has exactly two message shapes: `"<label> is not reachable: <reason>"` (no repo dir, no `.env.local`, no `DATABASE_URL`/`DATABASE_URL_UNPOOLED`, connect/auth/network failure, missing lab file) and `"<label> query failed: <reason>"` (SQL error, statement timeout, read-only violation, guard refusal, lab timeout). The URL, user, password and host are scrubbed to `***`. A failure in one system never affects another system or the notes tools. `SqlRefused` (guard) is always rewrapped as `query failed`.
- `EmbeddingError` (embeddings, carries optional `detail`) is every embedder failure; callers record and retry (worker) or fall back to text (search). `embeddingErrorText` renders it with its detail. A blank `OPENROUTER_API_KEY` passed to `createOpenRouterEmbedder` throws it at daemon start.
- `/mcp` returns JSON-RPC-shaped errors: 403 for a non-loopback host or Origin, 405 for GET/DELETE.
- `/api` errors are `{ error: string }`. One mapping turns `NoteError` into a status: `not_found` and `deleted` are 404 `not_found`, `conflict`, `duplicate_image` and `not_deleted` are 409 with the code, `invalid_id` is 400 `invalid_id`, and any other code is 400 `"<code>: <message>"`. Bad JSON is 400 `invalid_json`, and zod failures are 400 with `"<path>: <message>"` joined by `; `. Non-`NoteError` exceptions are rethrown (Hono 500).
- `/api/chat` errors after streaming starts arrive as `event: error`, not as an HTTP status. Since iteration 8 phase 7 the user row is already written by then and stays; only the assistant row is skipped.
- `ChatError` (iteration 8 phase 7) carries a `ChatErrorCode`; `chatErrorResponse` maps it to JSON `{ error: code }` with 404 (`not_found`, `thread_not_found`, `reply_not_found`), 409 (`conflict`) or 400 (the rest), and rethrows anything else.
- Agent chat backend errors (thrown from `events`, so they reach the UI as `event: error`): `Chat stopped: the request was closed.` / `a newer message replaced this one.` / `no answer within N s.` / `notesd is shutting down.`, the turn-cap message, the agent's own result or error text, `The agent ended without an answer.`, and the `CHAT_BRAIN=glm needs ...` message. `end()` throws if called before `events` finished cleanly.
- Image routes answer `{ error }` JSON: 404 `not_found` (bad, unknown or deleted id), 404 `no_image` with `id` (text note), 404 `not_on_this_machine` with `host`, 400 `bad_multipart` / `file_required`, 413 `too_large` (from `bodyLimit`, with `max_bytes`, or from the size check), and 415 for any other `ImageInputError` (`not_an_image`). Other exceptions go to Hono (500).
- `ImageInputError` (`src/http/imageAccess.ts`) carries `not_absolute`, `not_found`, `not_a_file`, `not_an_image` or `too_large`. MCP `create_image` returns it as an `isError` result. `view_images` never errors per id; it reports problems as text lines.
- Static: 503 `web UI not built: run npm run build` when `web/dist/index.html` is missing.
- Driver errors are not wrapped, except the unique violation in `insertNote`.
- Images: `UnsupportedImageError` (probe; carries `detectedMime`), `OriginalMissingError` (derive; carries `id`), `DestinationExistsError` (store; never overwrites), and a plain `Error` when a path escapes the data dir, when no free id is found in 5 attempts, or when a preview cannot fit 3.75 MB. The inbox watcher never throws. It logs the failure and moves the file to `inbox/failed/`.
- Only `src/main.ts` calls `process.exit`: on startup failure, and on shutdown (forced after 10 s).

## Testing

- `npm test`: unit tests in `tests/unit/**/*.test.ts` (node) plus `web/src/**/*.test.tsx` (jsdom via a per-file `// @vitest-environment jsdom` pragma).
- `npm run test:int`: `scripts/test-int.sh` creates, starts or reuses the Docker container `mcp-notes-pg-test` (`pgvector/pgvector:pg16`, `127.0.0.1:55433`, db `mcp_notes_test`) and, unless `CHAT_LIVE_TEST=1`, `mcp-notes-pg-connectors` (`pgvector/pgvector:pg16`, `127.0.0.1:55435`, db `postgres`), waiting on `pg_isready` for each. A container created from another image (e.g. an old `postgres:16` `mcp-notes-pg-test`) is removed and recreated; both hold test data only. It then exports `TEST_DATABASE_URL`, `TEST_CONNECTORS_URL` and `VITEST_INTEGRATION=1` and runs `tests/integration/**/*.int.test.ts`. `globalSetup` applies `drizzle/*.sql` once, and `tests/integration/connectors/globalSetup.ts` rebuilds `connectors_expenses`, `connectors_runs` and `connectors_seer` from the sibling repos' own migrations.
- Connector harness (`tests/integration/connectors/harness.ts`, non-vitest half in `siblings.ts`), used by phases 2-4: `connectorsAdminUrl()` (refuses Neon), `siblingRepo(id)` and `describeWithRepo(id, name, fn)` (skips with a reason when the sibling repo's migrations are absent), `systemDbName`/`systemDbUrl` (writable admin URL), `truncateSystem`, `seedSystem`, `withAdmin`, `connectorFor(id, overrides?)` (a real read-only connector over a temp repo with a generated `.env.local`), `makeLab(rows?)` (temp `lab.sqlite` with `meta`, `methods`, `trials`, `trial_funding`, `insights`), `connectorClient(connectors)` (in-memory MCP client over `registerConnectorTools`) and `cleanupHarness()`. Only `truncateSystem`, `seedSystem`, `withAdmin` and `connectorClient` are async.
- Connector suites (P1-NOTES-A012): unit `tests/unit/connectors/{names,rows,guard,env,failsoft}.test.ts` (15 names, row cap, guard accepts/refuses per dialect and masking, direct-URL pick, `prepareUrl`, `loadDatabaseTarget`, per-call settings, scrubbing, fail-soft messages and the lab runner) and `mcp.instructions` (the Connectors paragraph); integration `core.int` (read-only at the database even outside `BEGIN READ ONLY`, Jakarta session, guard vs database refusals, row caps, type parsing, statement timeout, fail-soft per system, lab reads and write refusals), `generic.int` (`_schema`/`_sql` per system on the migrated schemas) and `mcp.int` (six generic tools listed on the real `/mcp` next to the notes tools; an unreachable system leaves the notes tools working).
- Expenses curated suites (P1-NOTES-A013): unit `tests/unit/connectors/expenses.{dates,categories,queries}.test.ts` (calendar math and ISO weeks, the 17 slugs and the `other` fallback, row builders and fetchers over a fake `ReadOnlySource`) and integration `tests/integration/connectors/expenses.curated.int.test.ts` (`describeWithRepo('expenses', ...)`: exactly three read-only tools; October totals, categories, days, weeks and largest items; the meals-worst-week case; several categories and an empty range; reversed range and unknown id as tool errors; `expenses_get` order, photos and raw text; zero-filled `expenses_months` with and without a category filter).
- `npm run test:live:connectors`: `CONNECTORS_LIVE_TEST=1 vitest run`, no Docker, only `tests/live/connectors.live.test.ts` (60 s timeout). It calls each `<system>_schema` against the owner's real databases and Seer's real `lab.sqlite`, prints table counts only and asserts no password reaches a result. Opt-in.
- `npm run test:live:embeddings`: `EMBEDDINGS_LIVE_TEST=1 vitest run`, no Docker and no database, only `tests/live/embeddings.live.test.ts`. It needs `OPENROUTER_API_KEY` in `.env.local` and makes one real, billed OpenRouter request that embeds every labelled note and query (`tests/fixtures/semantic/labelled.ts`). It checks one finite 1536-dim vector per input, the raw cosine ordering, that every relevant note appears on the default page (`MCP_DEFAULT_LIMIT`) of the in-memory `rankCandidates` blend, and that `BLEND.minSimilarity` keeps every relevant note sharing no word with its query. The 0.3 -> 0.22 retune came from this run: one such positive scored 0.240 and was dropped at 0.3; live blend MRR went 0.708 -> 0.733. Opt-in.
- Integration helpers in `tests/integration/setup.ts`: `testDatabaseUrl()` (refuses a Neon URL), `openTestDb()`, `closeTestDb()`, `migrateTestDb()`, `truncateAll(db)` (truncates `chat_message_attachments`, `chat_message_revisions`, `chat_messages`, `chat_threads` (iteration 8 phase 7), `note_image_embeddings` (iteration 8 phase 6), `chat_images`, `note_files` (iteration 8 phase 4), `note_images`, `note_embeddings`, `note_revisions`, `notes`; call in `beforeEach` of any file that writes).
- `npm run test:live`: `CHAT_LIVE_TEST=1` on top of `scripts/test-int.sh`, so only `tests/live/chat.live.test.ts` runs (300 s test timeout), against the notes Docker Postgres (the connectors container is not started). `chat.live.test.ts` starts an in-process daemon on port 0 with the stub chat backend (only its `/mcp` is used), builds the Agent backend itself, and sends one real Claude and one real GLM message. Needs a logged-in `claude` and `LLM_*` in `.env.local`. Opt-in, slow and billed; never part of `npm test` or `test:int`.
- There is one `vitest.config.ts`. Do not add a second.
- Phase 6 suites: `chat-stub` (delta splitting, thread id, abort), `static` (503 fallback, reserved prefixes, assets cache, `/full/:id`, SPA fallback, traversal), `api.int` (all `/api` routes, filters, paging, error mapping, chat SSE) and `events.int` (connect comment, note events, heartbeat, unsubscribe on abort). Helpers: `tests/integration/helpers/api-harness.ts` (`createApiHarness` mounts `apiRoutes` over the Docker DB with a zero-delay stub, or `options.chat`; `uniqueTag()`), `tests/integration/helpers/scripted-chat.ts` (iteration 4: `createScriptedChatBackend()`, a fake `ChatBackend` that replays queued `ChatScript`s of `delta`/`status`/`throw`/`hang` steps, an optional `end` and `rejectWith`, and records every `ChatRequest`) and `tests/integration/helpers/sse.ts` (`parseSse`, `readUntil`, `waitFor`).
- Iteration 4 phase 2 (P1-NOTES-A009) suites: `chat-agent` (a fake `QueryFn` replaying `SDKMessage`s: delta streaming and session-as-thread, captions and paragraph breaks, run options isolation, resume, run-time MCP url, client abort, supersede, timeout, `close()`, the turn cap, GLM fallback on limit/auth errors before text and none after text, on other errors, without GLM or after a stop, and `CHAT_BRAIN=glm`), `chat-env` (key/marker stripping, `CLAUDE_CONFIG_DIR` kept, GLM env, `resolveExecutable`), `chat-prompt` (date/time/tz, id rule, plain prose, no self-saving) and `chat-status` (exact tool surface, captions). Iteration 5 phase 5 (P1-NOTES-A016) extended both: `chat-prompt` checks the three apps, curated-first and `_schema` before `_sql`, the data-answer/opinion rule, the apps' units and no guessing on app errors; `chat-status` pins the 13 + 15 + 2 tool surface and a caption for every connector tool. `daemon.int` now injects the zero-delay stub (tests must never spawn `claude`) and adds a start/stop check with the default Agent SDK backend that posts nothing.
- Phase 2 suites: `notes.helpers` (dates, cursor, limit, tag input, origin, rowToNote, NoteEvents), `mcp.instructions` (unit), `notes.service.int` (service against Docker Postgres), `mcp.tools.int` (all 11 tools through an MCP client on the real `/mcp` route, plus the 403/405 guards and `/health`) and `daemon.int` (data dirs, loopback listen, `/health`, MCP initialize over real HTTP, non-loopback host refused).
- Phase 5 suites: `tests/unit/takenFilter.test.ts` (taken bounds as UTC ISO text compares, `invalid_input` on garbage), `tests/unit/imageAccess.test.ts` (`expandHome`, `etagMatches`), `images.http.int` (upload and dedupe, byte-exact original with immutable cache and sha256 ETag, id spellings, thumb/preview sizes, display for PNG vs TIFF, 400/413/415 refusals, `not_found`/`no_image`, `not_on_this_machine`, no cached derivative once the original is gone) and `images.mcp.int` (tool and filter listing, `create_image` copies and dedupes, refusals, `view_images` content, text/unknown/missing explanations, the 8-id cap, `has_image` and taken-range filters on list and search). Harness: `tests/integration/imageHarness.ts` (`startHarness` builds real `createApp` over the Docker DB and a temp data dir, with `listen()`, `reset()`, `close()`; `makeImage` makes solid-colour PNG/JPEG/TIFF bytes; `insertTextNote`).
- Phase 7 suites (jsdom, colocated in `web/src`): `lib/{text,filter,usedIds,dates,sse}.test.tsx` (font sizing, tag parsing and segmenting, AND filter, mode cycle, heading and count line, used-id extraction, relative dates, SSE parsing across chunks and CRLF), `components/NoteCard.test.tsx` (font size, tag chip vs edit click, copy, blur commit, thumb aspect ratio) and `App.test.tsx` (text mode hides image notes, mode cycle, tag filter rail chip, streamed chat with used-note chips and dimming, status caption while streaming then the brain label). Iteration 4 phase 3 (P1-NOTES-A010) added `hooks/useChat.test.tsx` (status captions and `""` clearing, brain from `done` or null, error clears status, follow-up continues the thread, pinned keeps it, dismiss starts a new thread, a late `done` after dismiss does not restore it, a new ask resets brain and status). `npm run typecheck` checks both the server and web tsconfigs.
- Phase 8 suites (jsdom): `components/NoteImage.test.tsx` (film filter, display variant, placeholder with and without host, error fallback), `Gallery.test.tsx` (tile flex math, modal open, close when the photo leaves the list), `PhotoModal.test.tsx` (wraparound, Escape not reaching document listeners, backdrop vs inner clicks, copy, `/full/<id>` open), `DropOverlay.test.tsx` (first-image paste, text paste ignored, dedupe hit, Files-only overlay, serial drop uploads) and `fullscreen/FullscreenApp.test.tsx` (view reducer click vs drag threshold, `idFromLocation`, title and unfiltered image, `not_on_this_machine` placeholder).
- Iteration 6 phase 1 (P1-NOTES-A017) suites: unit `tests/unit/embeddings.state.test.ts` (constants match run-insights and the column width, `bodySha256`, `embedInput` trim/clamp/surrogates, every `embeddingState` case, `retryDelayMs`, `clampError`, `toVectorLiteral`); integration `embeddings.repo.int` (SQL hash equals JS hash, `listPending` order/limit/backoff/deleted notes, `saveEmbedding` race and idempotence, `recordFailure` counting, reset and no-ops, `isCurrentEmbeddingSql`, `embeddingStats`) and `schema.int` (now migrations 0000 + 0001: pgvector >= 0.8, HNSW cosine index, re-migrate is a no-op with 2 journal rows, defaults, vector width error 22000, cascade).
- Iteration 6 phase 2 (P1-NOTES-A018) suites: unit `tests/unit/embeddings/openrouter.test.ts` (a fake `fetch`: request shape, clamp, index ordering and position fallback, batching and chunk failure, transport/timeout/per-call timeout, non-2xx snippet, 401 without the key, non-JSON, missing data, count/index/width/finite checks, `embedderFromConfig`, `embeddingErrorText`), `tests/unit/embeddings/fakeEmbedder.test.ts` and the `loadConfig embeddings` block in `config.test.ts`; `daemon.int` checks a null embedder without a key and an injected one. Every hand-built `Config` and `AppDeps` in the integration harnesses (`api-harness`, `imageHarness`, `images.int`, `mcp.tools.int`, `connectors/mcp.int`, `chat.live`) now sets `embeddings: DEFAULT_EMBEDDINGS_CONFIG` and `embedder: null`.
- Iteration 6 phase 3 (P1-NOTES-A019) suites: unit `tests/unit/embeddings/backfill.test.ts` (batching and progress, per-note fallback recording only the bad note, backoff and once-per-run `ignoreBackoff`, abort and resume without re-embedding, changed body skipped then re-embedded, rate limit on a fake clock, `RateLimiter` abort), `tests/unit/embeddings/worker.test.ts` (start drain and per-batch log, idle silence, which events kick, coalescing, failure logs, store errors, close waits and bounded close grace) and `tests/unit/embeddings/embedBackfillCli.test.ts` (usage, unknown argument, missing key, config error); integration `tests/integration/embeddings.worker.int.test.ts` (create/update/append/revert and image notes end current, textless photos skipped, failing and slow embedders never affect the write, retry after backoff, sweep picks up event-less writes, delete/restore keeps the vector, resumable `runBackfill`, `startBackground` with and without an embedder, the CLI end to end and `--retry-failed`). `tests/helpers/memoryEmbeddingStore.ts` provides `MemoryEmbeddingStore` (an in-memory `EmbeddingStore` with the repo's rules) and `ScriptedEmbedder` for the unit suites.
- Iteration 6 phase 4 (P1-NOTES-A020) suites: unit `tests/unit/search.blend.test.ts` (the two `BLEND` invariants and ranges, `queryTerms` hashtags/words/ids/exclusions, `tagMatch`, `recencyScore`, `similarityScore`, `isEligible`, `blendScore`, `rankCandidates` ordering, rank normalization, minSimilarity cut and tie-break), `tests/unit/search.queryVector.test.ts` (LRU eviction, cache keyed by model, failures not cached, timeout, wrong width, empty query, fallback texts and clipping) and a new `mcp.instructions` case (the `Reading.` paragraph mentions meaning, both modes and the fallback); integration `tests/integration/search.hybrid.int.test.ts` (hybrid beats text-only on MRR and recall@3 over the labelled set, every usage example ranks a relevant note first, literal queries stay first, exact id and rare code tokens beat perfect meaning matches, no-vector stores still answer, `-exclusions` on the meaning side, filters before ranking for tags/dates/`has_image`/`deleted`, fallback on embed failure, timeout and no embedder, `mode: 'text'` makes no embedding call, paging embeds once, and the MCP `search` tool's description, `mode` and `fallback`). The labelled set lives in `tests/fixtures/semantic/labelled.ts`: `LABELLED_NOTES` (16 notes with `ageDays` backdating), `LABELLED_QUERIES` (10 queries with relevant keys, `usage` flags for the brief's examples, and a `why`), `SEMANTIC_LEXICON` for the fake embedder, and `evaluateRanking` (MRR, recall@k). Phase 6's live test reuses it against the real model.
- Iteration 6 phase 5 (P1-NOTES-A021) suites: integration `tests/integration/related.int.test.ts` (`NotesService.related`: meaning order, self excluded, similarity = 1 - distance; limit and its 1..50 clamp; deleted notes never returned; stale and other-model vectors ignored; on-demand embed of an unembedded or changed source, once; no embedder answers from existing vectors and gives `not_embedded` otherwise; a failing embed stores nothing; bad, unknown, deleted ids and a textless photo. The MCP `related` tool: listed, read-only, result shape, limit outside 1-50 refused, service errors as `code: message`), plus updated unit cases in `tests/unit/chat-status.test.ts` (14 notes tools) and `tests/unit/mcp.instructions.test.ts` (one `Related.` paragraph).
- Iteration 7 phase 1 (P1-NOTES-A023) suites: integration `schema.int` (now migrations 0000 + 0001 + 0002: live-sha256 uniqueness on `note_images`, unique paths, cascade on note removal), `migration0002.int` (builds an iteration-6 database, then applies only 0002: one identical row per legacy image, none for text notes, at most one live row per sha256 with live notes first, `notes` rows, legacy columns, indexes and image files untouched, the migration ends with exactly `LEGACY_COPY_SQL`; `reconcileLegacyImages` inserts nothing after the migration, picks up a late legacy image once, and bins a late image whose bytes already live) and `imageRepo.int` (insert and lookup, `duplicate_image` across notes, a removed image releasing its sha256, taken path or id rethrown as is, live lookup with the note's deleted time, `nextPosition` counting removed rows, `imageIdTaken`, idempotent remove and restore, restore refused when bytes live elsewhere, per-note ordering with a key per id, cascade).
- Iteration 7 phase 2 (P1-NOTES-A024) suites: new unit `tests/unit/sameOrigin.test.ts` (loopback detection, same-origin match, 403 on a missing, foreign or `null` Origin); `takenFilter.test.ts` rewritten to assert the `exists` subqueries for `hasImage` and the one-image taken range; `notes.helpers.test.ts` covers 3-arg `rowToNote` and `toNoteImage`; `images/ingest.test.ts` and `images/inbox.test.ts` read through `byImageId` and add a removed-image dedupe case. Integration: `notes.service.int` gains an `images[]` block, `images.int` covers create rollback on a sha clash, removed-image dedupe and the startup reconcile, `images.http.int` covers the image-id routes, any-state serving, the note-id alias fallback and a reconciled legacy image being served, and `images.mcp.int` covers `view_images` over every image of a note, image ids, the 8-image cap with its overflow line and removed images. Helpers: `tests/helpers/fakeNotes.ts` keeps a separate image map and implements the new `ImageRecords` (`seed`, `removeImage`, `images`); `imageHarness.ts` gained `addImage` and sets `taken_at` on `note_images`; `api-harness.ts` `insertImageNote` writes a `note_images` row.
- Iteration 7 phase 3 (P1-NOTES-A025) suites: new integration `tests/integration/images.attach.int.test.ts` (HTTP: attach in order as new files, attach to a text note with any id spelling, dedupe across and within notes, a deleted holder restored, removed images not counting for dedupe, 400/404/413/415 refusals, remove keeping file and slot then restore at the old position, 409 `duplicate_image` naming the holder, restore of a deleted note's image restoring the note, one `updated` event per change and none for a no-op, two concurrent attaches of the same bytes leaving one live image; MCP: the three tools listed and none that deletes permanently, `attach_image` copies and dedupes and leaves the source, remove/restore round-trip, tool errors). Unit `chat-status.test.ts` asserts 17 notes tools, the three new captions and no purge-like tool name; `mcp.instructions.test.ts` asserts exactly one `Attaching.` paragraph and its key phrases.
- Iteration 7 phase 4 (P1-NOTES-A026) suites: new integration `tests/integration/bin.int.test.ts` (bin listing newest-deleted first with each image once, tag AND filter, sidebar tags still live-only, empty bin; restore with images, 404/400; purge of a deleted note removing rows, originals and derived files and nothing else; purge of a removed image keeping its note; legacy image purge clearing `notes.image_path`/`image_meta` so the reconcile cannot bring it back; 409 `not_deleted` touching nothing; 404/400; 403 without or with a foreign Origin and 200 from the page; no MCP or chat-allowed tool can purge). New unit `tests/unit/images/removeImageFiles.test.ts` (removes original and every derived file only, missing files count 0, never unlinks outside `images/`, never removes the cache root or outside it for a malformed id). `tests/unit/embeddings/worker.test.ts` asserts `purged` triggers no drain.
- Iteration 7 phase 6 (P1-NOTES-A028) suites (jsdom): every web suite now builds wire notes from the shared `web/src/testing/fixtures.ts` (`makeImage(id, over?)`: a 600x400 available JPEG on host `lenovo` with `/api/images/<id>/*` urls and `note_id` defaulting to `id`; `makeNote(id, body, { images?, tags?, created?, updated? })`: string image ids become images of that note at positions 0..n-1, tags default to the body's hashtags). New cases: `filter` (`hasImages`, `imageCount`, `photosOf` flattening order and `k/n`, count line over items), `NoteCard` (cover is `images[0]`, count badge only for 2+), `NoteImage` (src by image id; a failed image does not hide the next one rendered in its place), `Gallery` (one tile per image, open/close by image id), `PhotoModal` (stepping within then across notes, `metaLine`, copy gives the note id, `/full/<imageId>`), `FullscreenApp` (`describeMissing` reads `/api/images/:id` dims) and `App` (photo count counts images, one gallery tile per image, modal steps within a note, count on the cover).
- Iteration 7 phase 7 (P1-NOTES-A029) suites (jsdom): new `components/NoteEditor.test.tsx` (opens focused with id and copy-id, live tag chips, blur saves only on change and once per change, an emptied note is saved empty and never closed while open, capture-phase Escape not reaching a chat handler, close fires once with `dirty`, backdrop vs panel click, image strip with remove icons, no strip for a text note, the dedupe notice). New cases: `NoteCard` (Expand note icon; expanding mid-edit keeps focus and hands over the draft), `DropOverlay` (with a target, paste and drop attach one at a time and pass dedupe results through; attach vs new-note icon), `filter` (`visibleOnWall` keep list) and an `App big editor` block (expand + Esc saves only if changed, blur save reflected on the card, "+" then expand survives while open and is deleted on close, the empty rule on close only, paste attaches and Notes. -> Everything. on close, an emptied note with a new image is kept, attach overlay state, quiet dedupe notice, strip soft remove, Esc leaves the chat answer open).
- Iteration 7 phase 8 (P1-NOTES-A030) suites (jsdom): new `components/UndoBar.test.tsx` (`UndoBar` + `useUndo`: nothing until a push, mono label and icon-only Undo placed by `.undo`, runs once and hides, gone after 6 s without running, a new push replaces the entry and restarts the clock, a failed undo is logged), `components/Bin.test.tsx` (grid on top and note cards below in server order, restore of a note and of a removed image, the quiet `already in <id>` on a 409 `duplicate_image`, inline Check + X confirm with cancel sending nothing, purge of a note and of only the image, one entry confirming at a time, tag filters sent to `GET /api/bin` and refetch on change, refetch on SSE note events and `EventSource` closed on unmount), `components/PhotoModal.delete.test.tsx` (no trash icon without `onDelete`), `lib/binFilter.test.tsx` (`BIN_HEADING`, `binCountLine` counts and tags) and `App.bin.test.tsx` (card delete with no prompt and undo, the rail trash opens `Deleted.` and restore puts the note back on the wall, the sidebar trash toggles too while sidebar counts stay live, active tags passed to the bin). New cases: `NoteCard` (trash deletes without entering edit; no trash without `onDelete`) and `NoteEditor` (trash deletes with the current draft; no trash without `onDelete`). 752 unit tests pass (720 before).
- Iteration 7 phase 9 (P1-NOTES-A031) suites (jsdom): new `hooks/useCapabilities.test.tsx` (one `GET /api/capabilities` for the whole page however many components ask, stays `{ reveal: false }` on a failed request, a non-2xx answer or a payload without `reveal: true`, a primed store does not fetch), `components/RevealButton.test.tsx` (nothing when `caps.reveal` is false or the image is not on this machine, the `FolderOpen` icon with its tooltip and no text, click POSTs `/api/images/<id>/reveal` without reaching the parent, a failed reveal only logs) and `components/RevealMounts.test.tsx` (wall card: one icon for the cover, placed right after Copy ID and before the `copied` mark since P1-NOTES-A034, none for text notes, with `reveal` false or a remote cover; photo modal reveals the current image, not the cover; editor strip: one icon per local image, none for remote images or with `reveal` false).
- Iteration 8 phase 3 (P1-NOTES-A036) suites: new unit `chat-compose.test.ts` (text-only unchanged, one `[image upload:ID]` line per image, image-only turns, preview count check, image blocks before text, plain string vs a fresh one-message stream) and `chat-images.test.ts` (`chat-images/YYYY/MM` paths, `c_<id>` cache key, variant urls, wire shape); new integration `chat.images.int.test.ts` (schema uniqueness and source check; upload 201 never a note, 200 for known bytes with a healed original, concurrent same-bytes uploads making one row, `source`, 415/413/400; metadata and every variant with derivatives under `cache/c_<id>/`, 404 and `not_on_this_machine`; `POST /api/chat` with `image_ids` handing resolved images to the backend, image-only and deduped ids, JSON refusals before any stream; the agent backend composing one user message with the preview image block then the text). `chat-agent` and `chat-stub` pass `images`, `schema.int`/`migration0002.int`/`setup.ts`/`daemon.int` account for 0003 and `chat-images/`, and `chat.live` gains an image turn. Web (jsdom): new `hooks/useChatImages.test.tsx`; new cases in `ChatBar`, `AnswerPanel`, `DropOverlay` (paste in the bar is left to the bar), `useChat` and `App`.
- Iteration 8 phase 4 (P1-NOTES-A037) suites: new unit `files.name.test.ts` (`sanitizeFileName` Windows rules, reserved names, length caps keeping the extension; `withNameSuffix`, `displayFileName`, `isSafeFileName`), `files.store.test.ts` (path helpers, `removeNoteFile` / `removeNoteFolderIfEmpty` refusing anything outside `files/<noteId>/`, `detectFileMime`, download headers via `attachmentDisposition`) and `mcp.describe.test.ts` (`filesLine` in `describeNote` / `describeImage`); new integration `migration0004.int` (exactly one migration on top of 0000-0003, notes and images untouched, columns/defaults/indexes, extraction check, live-sha uniqueness, cascade), `files.int` (HTTP attach under `files/<noteId>/`, shared id space, Windows-safe names with clash suffixes, dedupe and heal on a host lacking the bytes, concurrent same-bytes uploads stored once, sniffed images delegated to the image store, refusals, remove/restore at the old position and 409 `duplicate_file`, attachment-only downloads, purge removing the files folder and tolerating a leftover), `files.mcp.int` (`get`/`list` return files; `view_images` names the files) and `files.reveal.int` (file and note-level reveal, `sameOriginOnly`). Updated: `notes.helpers` (`rowToNote` with files, `toNoteFile`), `mcp.instructions` (`Files.` paragraph), `chat-prompt` (files sentence), `reveal` (`explorerArgs` modes, `noteRevealPlan`), `daemon.int` (`files` data dir), `tests/helpers/fakeNotes.ts` and `imageHarness.ts` (`files: []`).
- Iteration 8 phase 6 (P1-NOTES-A039) suites: new unit `tests/unit/embeddings/{imageConstants,openrouterImage,imageBackfill,fakeImageEmbedder}.test.ts` (column width and token estimate, request shapes, `fitVector`, PNG and size refusals, response validation, the per-image drain loop with unavailable images, limit and abort) and `tests/unit/similarTools.test.ts`; new integration `imageEmbeddings.repo.int` (`note_image_embeddings` queries and `nearestImages`), `imageEmbeddings.worker.int` (worker and backfill against Docker Postgres) and `similarImages.mcp.int` (the `similar_images` tool over `/mcp`). Updated: `chat-status` (18 notes tools, `finding similar photos`), `chat-prompt`, `mcp.instructions` (`Similar images.` paragraph), `daemon.int` (image embedder injection), and every hand-built `AppDeps` (`imageEmbedder: null`). `npm run test:live:imageEmbeddings` (`IMAGE_EMBEDDINGS_LIVE_TEST=1 vitest run`, no Docker, no database) runs only `tests/live/imageEmbeddings.live.test.ts`: a few real, billed `google/gemini-embedding-2` calls documenting the request shapes and checking the width. Opt-in. `tests/helpers/fakeImageEmbedder.ts` is a deterministic offline `ImageEmbedder` whose colour axes (`COLOUR_WORDS`) make solid-colour test images and colour words land near each other.
- Iteration 8 phase 7 (P1-NOTES-A040) suites: new unit `chat-ids.test.ts` (id shape, normalisation, label), `chat-context.test.ts` (layout, WIB times, budget and omitted line, line cap, reply target in or out of history, tag neutralising, image order and dedupe) and `chat-citation.test.ts` (leading marker, split across deltas, flush on status, end, no marker passthrough); updated `chat-agent` (no `resume`, `persistSession: false`, identical prompt on GLM), `chat-compose` (`imageLabel`, `composeLabelledText`), `chat-prompt` (layout and reply paragraphs) and `chat-stub`. New integration `chat.service.int.test.ts` (threads, id retry, reply validation, attachments, events after commit, edit/delete/restore, turn context, restart, timeline paging and ordering, bad cursor, `recordExchange` replay and concurrent race, FK cascade / set null) and `chat.api.int.test.ts` (two-turn persistence and rebuilt prompt, restart, unknown thread id, deleted/edited context, cross-thread `reply_to`, disconnect persists no answer, GLM fallback sees the same prompt, citation strip / drop / passthrough, validation before writes, history routes with same-origin, `event: chat` on `/api/events`, chat images as attachments). `tests/integration/helpers/{api-harness,scripted-chat}.ts` and the other harnesses build `AppDeps.chat`.
- Iteration 8 phase 9 (P1-NOTES-A042) suites (jsdom unless noted): new `lib/route.test.tsx` (`/history` with and without thread, other paths, encoded href, push only on disagreement, `/?note=` never rewritten), `lib/events.test.tsx` (one shared connection fanned out, closes on last unsubscribe and reopens fresh, no-op without `EventSource`), `lib/timeline.test.tsx` (ascending order with question before answer, authoritative latest page vs additive older page, local bubble pruning, thread rule incl. error and deleted skips, count line), `lib/chatTime.test.tsx` (Jakarta date boundaries at 16:59/17:30 UTC, midnight as 00, new year, tooltip), `hooks/useHistory.test.tsx` (disabled does nothing, paging with the cursor, `event: chat` refresh on one connection and delete drop, `loadOlder` sharing, `mutate` and `includeDeleted`, optimistic send and thread choice, image ids, error bubble and refused second send), `pages/HistoryPage.test.tsx` (bubble sides and timestamps, badge and dividers, square thumb boxes and chips, lightbox navigation, streaming and error bubbles, earlier messages, thread focus and paging to find it, page-variant composer), `components/Rail.test.tsx` (icon position above/before the bin, pressed state), `App.history.test.tsx` (rail toggle and `/` on leave, deep load from `/history?thread=`, back/forward, `/?note=` after back, full-screen button, bin never rewriting `/?note=`, page-only composer); additions to `AnswerPanel.test.tsx` (full-screen button, thumbnails open the lightbox) and `useChat.test.tsx` (`threadId` from `accepted`/`done`, cleared on dismiss); node `tests/unit/static.test.ts` serves `index.html` (`no-cache`) for `/history`, `/history/` and `/history?thread=T-1`. Chat fixtures come from `web/src/testing/chatFixtures.ts`.
- `tests/helpers/fakeEmbedder.ts`: `FakeEmbedder` / `createFakeEmbedder(opts?)`, a deterministic offline `Embedder` with the real model id and width by default. Tokens matching a synonym group of the `Lexicon` (`DEFAULT_LEXICON`, prefix entries end in `*`) add to that group's concept axis; other tokens hash (FNV-1a) into tail axes at `DEFAULT_TAIL_WEIGHT`; stopwords are dropped; vectors are unit length and never zero. It validates like the real client, records each batch in `calls`, and offers `failNext(n, err?)`, `failWhen(pred, err?)`, `delayMs`, `reset()` and synchronous `vectorFor(text)`. Also exports `tokenize` and `cosine`.
- Phase 4 suites: `tests/unit/images/{probe,store,derive,ingest,inbox}.test.ts` and `tests/integration/images.int.test.ts` (byte-exact storage, dedupe, restore of a deleted duplicate, the sha256 unique index, HEIC display/thumb/preview, missing original, and an inbox drop through `startBackground`).
- Iteration 8 phase 8 (P1-NOTES-A041) suites: new unit `tests/unit/hooks/transcript.test.ts` (string and array prompts, `/n` detection, meta/tool-result/sidechain exclusion, images by `imagePasteIds`, `findTurn`, torn lines), `hooks/notesCapture.test.ts` (payload building, settle polling, deliver outcomes by status, spool + outbox drain bounds and age drop, never throws), `hooks/notesPaste.test.ts` (`pasted_image` parsing, image pick, upload id parsing, `updatedInput` vs `deny` output, allow-unchanged on failure, other tools ignored), shared `hooks/fixtures.ts`, `tests/unit/scripts/claudeHooks.test.ts` (merge keeps everything else, idempotent and replaces another checkout's entry, `removeHooks` restores exactly, deny env prefix on the paste command only, quoting, 0600 new file, one-time backup, invalid JSON refused, `status`, and `install.sh` / `uninstall.sh` sourced with `register_hooks` / `--skip-hooks` / `NOTES_SKIP_HOOKS=1`) and `tests/unit/captureGuard.test.ts`; new integration `capture.int.test.ts` (single-turn `claude_code` thread with the given timestamps, replay 200 duplicate, concurrent posts write one thread, images in the chat store deduped and attached, empty answer stores the question only, answer timestamp clamp, timeline order by timestamp, validation, 415 unreadable image writes nothing, guard refusals) and `capture.hook.int.test.ts` (the real hook script against the real endpoint: string- and array-form `/n` turns, daemon down spools then a later run delivers). `similarImages.mcp.int` follows the new `PASTED_IMAGE_NEEDS_HOOK` text. `npm run verify:paste-hook` (`scripts/verify-paste-hook.mjs`, flags `--port`, `--strategy`, `--model`, `--claude`) is opt-in and never part of `npm test` / `test:int`: it needs a running notesd and a logged-in `claude`, bills one small model call, and exits 0 when the tool received an `upload_id`, 1 when not (switch to the `deny` strategy), 2 when it could not run.
- Image fixtures in `tests/fixtures/images/`: `exif.jpg` (64x48, EXIF 2024:10:30 14:05:09), `plain.png` (40x30, no EXIF), `photo.heic` (64x48 HEVC with EXIF). They are committed because Node cannot encode HEVC. `make-fixtures.py` (Pillow + pillow-heif) regenerates them, possibly with different bytes. Helpers: `tests/helpers/fixtures.ts` (`FIXTURES_DIR`, `JPEG_EXIF`, `PNG_PLAIN`, `HEIC_PHOTO`, `fixtureBytes`, `tempDir`) and `tests/helpers/fakeNotes.ts` (`FakeNotes`, an in-memory `ImageNotes` + `ImageRecords` with the schema's id and live-sha256 uniqueness rules, plus `beforeInsert` / `failNextCreate` hooks for race and failure tests).

## Gotchas

- In `.env.local`, `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are swapped. Runtime and drizzle-kit both choose by host (`-pooler`), never by key name.
- Runtime uses the pooled host. Migrations must use the direct host.
- `src/embeddings/repo.ts` SQL fragments render columns as `"notes"."body"` / `"note_embeddings"."embedding"`, so any query that embeds them must not alias those two tables. `repo.searchCandidates` relies on this.
- Hybrid search weights live only in `BLEND` (`src/search/blend.ts`). Retune the numbers freely, but keep the two invariants its unit test asserts, or literal hits and named ids stop ranking first. A hybrid page's cursor is an offset into the blended list and a fallback page's cursor is an offset into the text ranking, so a cursor from one is not meaningful in the other. Hybrid considers at most `textCandidates` (500) full-text matches; `mode: "text"` is still the exhaustive option.
- `hnsw.iterative_scan` needs pgvector >= 0.8 (`schema.int` asserts this on the Docker image); without it a selective filter can starve the vector side of `searchCandidates`.
- Every note-table Postgres (Neon, the Docker test container) must have pgvector: migration 0001 runs `CREATE EXTENSION IF NOT EXISTS vector`. A plain `postgres:16` container fails it.
- The vector column is never selected except by callers that rank by it; it must not enter `NoteRow`, the wire `Note` or a log line.
- `startDaemon` without `options.embedder` builds the real OpenRouter client whenever `OPENROUTER_API_KEY` is set. Tests must inject `FakeEmbedder` or `null` (from phase 3 the worker would call the network). Passing `embedder: null` explicitly means off; only `undefined` falls back to config. The same holds for `options.imageEmbedder` (iteration 8 phase 6): the image worker would otherwise send real, billed Gemini requests.
- Image vectors (`note_image_embeddings`, Gemini) and note text vectors (`note_embeddings`, OpenAI) live in different spaces and must never be compared. `IMAGE_EMBEDDING_DIMENSIONS` cannot exceed 2000 while the column is a plain `vector` with an HNSW index.
- An image is only embedded by the machine holding its original; on the other laptop it is `unavailable`, never a failure, and `similar_images` with that `image_id` refuses until its owner embeds it.
- `OPENROUTER_API_KEY` must never reach a log, an error or `last_error`: `createOpenRouterEmbedder` keeps it out of messages and `clampError` redacts `sk-or-...`/`Bearer` as a backstop.
- The daemon binds 127.0.0.1 only. A different `NOTESD_HOST` is a hard error, not a warning.
- `dataDir` is resolved but not created by `loadConfig`. `startDaemon` creates it, along with `images`, `cache`, `inbox`, `inbox/failed`, `chat`, `chat-images` and `files`.
- `YYYY-MM-DD` date filters use the daemon process's local timezone, which the MCP instructions name. Tests that depend on day boundaries must account for TZ.
- The cursor is an offset, so inserts between pages can shift results. It is opaque to clients, who must pass `next_cursor` back unchanged.
- MCP caps `limit` at 200. The repo allows up to 5000 (for the HTTP/UI).
- `from`/`to` filter on the saved date (`created_at`); `taken_from`/`taken_to` filter on the EXIF date and match a note only when one live image meets both bounds; images without an EXIF date never match.
- An image note whose original is on another host gives 404 `not_on_this_machine` on every variant, even when a derivative is cached locally.
- `create_image` copies; only the inbox moves files. `view_images` always sends the preview, never the original.
- Image mime comes from magic bytes only. The stored extension comes from the original filename when it is safe, so a `.jpeg` keeps `.jpeg`. Do not infer mime from the stored path.
- `images/YYYY/MM` is the ingest time in local time, not the EXIF `taken_at`.
- An image ingested on another host has `available = false` here until the same bytes are ingested locally, which puts them back at the stored `note_images.path`.
- Delete forever (iteration 7 phase 4) is UI-only and guarded by `sameOriginOnly`: a request without notesd's own page Origin gets 403. It refuses live items with 409 `not_deleted`. Files are removed after the transaction commits, so a file that cannot be removed is left behind (logged), never a row pointing at a missing file.
- Note files (iteration 8 phase 4) share that id space too (`imageIdTaken` checks all three tables). A file whose bytes sniff as an image is stored as an image, so `POST /api/notes/:id/files` may answer `kind: 'image'`. Downloads are always `attachment` with a sandbox CSP, never inline. The stored name (`files/<noteId>/<safeName>`) may differ from `original_name`. MCP and the chat brain can only see files; no tool attaches, removes or reads them, and `extraction_status` stays `none` until an extraction phase exists. `web/src/types.ts` keeps `Note.files` optional, so web code must read `note.files ?? []`.
- Image ids share the note-id space: a note's first image has the note's id, and `newId` / `create` refuse an id used in either table. `/api/images/:imageId/*` serves removed images and images of deleted notes (for the bin); only the `/api/notes/:id/*` alias hides deleted notes. The web UI still builds `/api/notes/:id/*` URLs until a later phase moves it to `images[].urls`.
- Inbox files that are not images stay in `inbox/` and are logged, not moved to `failed/`. Subdirectories, dotfiles and partial downloads are ignored.
- `/mcp` is stateless POST-only. There is no SSE stream and no `Mcp-Session-Id`.
- Do not edit `src/http/app.ts` mount order in later phases. Fill the routers instead, and keep `staticRoutes` last. (Iteration 8 phase 8 added one router, `captureRoutes`, just before `staticRoutes`.)
- The Claude Code hooks run from the checkout `install.sh` was run in (absolute paths in `~/.claude/settings.json`); run from a worktree they break once it is removed, so re-run `install.sh` from `~/mcp-notes` after the set lands. Restart Claude Code to pick up hook changes.
- The capture hook depends on Claude Code's transcript JSONL shape (verified on 2.1.x: `<command-name>/n</command-name>` prompts, `imagePasteIds`, `isMeta` skill bodies). A format change makes it silently capture nothing; check `~/.local/state/notes-capture/capture.log`.
- Whether Claude Code honours `updatedInput` for MCP tools is checked only by `npm run verify:paste-hook`; if it stops, reinstall with `NOTES_PASTE_STRATEGY=deny scripts/install.sh`.
- Capture idempotency is on `<claude_session>:<user_uuid>`: a replayed outbox file is a 200 duplicate, never a second thread. The outbox can hold base64 images (up to ~48 MB per file); files older than 14 days are dropped.
- `POST /api/capture/claude-code` refuses a browser: it needs `X-Notes-Capture: 1` and a loopback (or absent) Origin. The paste hook sends the same header to `POST /api/chat/images`, which does not require it.
- `isNeonUrl` throws on an unparseable URL, while `isPooledUrl` returns false.
- `/api/notes` defaults to 2000 rows (the UI loads everything), MCP to 50.
- `DELETE /api/notes/:id` checks liveness first and returns 404 for an already-deleted note, unlike the idempotent service and MCP `delete`.
- `/api/tags` returns a bare array, while MCP `tags` returns `{ tags }`.
- `startDaemon` without `options.chat` builds the real Agent SDK backend: any test that posts to `/api/chat` through `startDaemon` must inject a stub or scripted backend, or it spawns `claude` on the owner's login.
- The chat brain needs the `claude` CLI logged in for the user running `notesd` (the systemd unit's PATH lacks `~/tools/...`, so `install.sh` renders the absolute real path into the unit as `NOTESD_CLAUDE_BIN`, and sets `HOME` so the login is found). The child env never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, model overrides or any `CLAUDE_CODE_*` / `CLAUDECODE` marker, so a daemon started from inside a Claude Code terminal does not leak its session into the child.
- Since iteration 8 phase 7 chat threads are `chat_threads` rows, not SDK sessions: the run uses `persistSession: false` and never `resume`. A `thread_id` the server does not know (including a pre-phase-7 SDK session id still held by an open page) silently starts a new thread. Any AppDeps built by hand (tests, harnesses) must include `chat: new ChatService({ db })`.
- The model sees only the text of earlier answers (no tool results), trimmed to `CONTEXT_CHAR_BUDGET`; a long thread loses its oldest lines first.
- Chat message ids are only 4 characters and are not note ids: always write them as `[msg:K7F2]`. A `[msg:ID]` anywhere but the start of an answer is kept as plain text.
- The agent's allowed tools are hard-coded in `src/chat/status.ts`; a new notes MCP tool is invisible to the chat brain until it is added to `NOTES_TOOL_NAMES` (and given a caption). Connector tools are taken from `ALL_CONNECTOR_TOOL_NAMES` and captioned from `SYSTEM_META`, so a connector tool added to `CONNECTOR_TOOL_NAMES` is allowed and captioned automatically.
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
- Only `useNotes` and `useHistory` share the `lib/events.ts` connection; `useBin` still opens its own `EventSource('/api/events')` while the bin is showing. New subscribers should use `subscribeEvents`, not a fresh `EventSource`.
- App is the only place that writes the URL for views (`hrefForView`); do not add a second `pushState` owner. Wall and bin must never rewrite a non-`/history` URL, or `/?note=` deep links break.
- `useHistory` is mounted in App even off the page so a streaming reply survives navigation; it only fetches and subscribes while enabled, so the history store goes stale off-page and catches up on re-enable.
- `fullscreen.html` must stay a Vite input, or `/full/:id` falls back to `index.html` and opens the SPA instead of the image.
- Connectors must use the direct (non-pooler) Neon host: poolers reject the `options` startup parameter that sets `default_transaction_read_only`. `pickDirectUrl` chooses by host, like the notes config, and `prepareUrl` drops any `options` query param from the URL because it would override the client's own.
- Connectors cache nothing. Repo dirs, `CONNECTOR_TIMEOUT_MS` and each sibling `.env.local` are read on every call, so rotated credentials work without restarting `notesd`, and every call pays one fresh connection (and a lab call one process start, about 40-60 ms).
- Connector dates, times and timestamps come back as Postgres text in `Asia/Jakarta`, not ISO UTC; `int8` above 2^53 comes back as a string. Curated SQL must stay valid inside `SELECT * FROM (<sql>) AS q LIMIT n`; trailing `;` is stripped.
- `guardSelect` is a keyword guard, not a parser: any query containing a forbidden word outside literals, comments and quoted identifiers (even an unquoted column named `update`) is refused. The database's read-only session is what actually prevents writes, which `core.int` proves by bypassing the guard.
- The lab child runs with an empty env and `process.execPath`, so `node:sqlite` must exist in the daemon's Node.
- `truncateSystem('seer')` wipes the roster rows Seer's migrations insert into `strategies`; connector tests must seed their own. The connectors container (55435) avoids `seer-pg` (55432), `mcp-notes-pg-test` (55433) and `mcp-notes-pg-demo` (55434).
- `CONNECTOR_TOOL_NAMES` is the single source of the 15 names (instructions, chat allow list, curated phases). Add a system by adding entries there and a directory under `src/connectors/`.
- Expense categories are a copy of `~/expense-tracking/lib/categories.ts`, not an import. When the app adds a category, add it to `EXPENSE_CATEGORIES` and `EXPENSE_CATEGORY_LABELS`; until then its items read as `other`, and the tools' `categories` input (a zod enum) cannot filter on it.
- `expenses_spending` caps ranges at 366 days so `by_day` fits its `maxRows`; longer spans go through `expenses_months`. `meals` is everyday meals only; "all food" is `EATING_CATEGORIES`.

## Notes

Plan set: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (8 phases, iterations 1-3: spine, images, web UI). Phase 1 (P1-NOTES-A000) landed the scaffold. Phase 2 (P1-NOTES-A001, plan `.workflows/plan/P1-NOTES-A001.md`) landed the notes service, the MCP server and tools, and the `notesd` daemon. Phase 3 (P1-NOTES-A002) landed deployment: `deploy/notesd.service`, `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/windows/install-wsl-keepalive.ps1`, the `/n` skill in `claude/skills/n/` and `docs/INSTALL.md`. Phase 4 (P1-NOTES-A003) landed the image store, derivatives, ingest service and inbox watcher. Phase 6 (P1-NOTES-A005) landed the `/api` JSON routes, `/api/events` SSE, the `/api/chat` stub behind `ChatBackend`, and static SPA serving. Phase 7 (P1-NOTES-A006) landed the web UI core in `web/` and the `build:web`/`dev:web` scripts. Phase 5 (P1-NOTES-A004) landed the image HTTP routes and upload, `create_image`/`view_images`, the `has_image` and taken-date filters, and the images section of the MCP instructions. Phase 8 (P1-NOTES-A007) landed the web UI images: `NoteImage`, `Gallery`, `PhotoModal`, `DropOverlay` and the `/full/<id>` tab (`web/fullscreen.html`, `web/src/fullscreen/`).

Iteration 4 plan: `docs/plans/CHAT_BAR_BRAIN_PLAN.md` (4 phases, the chat bar brain). Phase 1 (P1-NOTES-A008) landed the chat seam v2 (status events, brain label, `Config.chat`, daemon injection). Phase 2 (P1-NOTES-A009) landed the Agent SDK backend in `src/chat/{agent,env,prompt,status}.ts`, the two `@anthropic-ai/*` dependencies, and made it the daemon default. Phase 3 (P1-NOTES-A010) landed the web panel status caption, brain label and thread reset on dismiss. Phase 4 (P1-NOTES-A011) landed the daemon fit: `HOME`/`NOTESD_CLAUDE_BIN` in the unit, install.sh login/env warnings and chat smoke check, `npm run test:live` with `tests/live/chat.live.test.ts`, and the `docs/INSTALL.md` updates.

Iteration 5 plan: `docs/plans/CONNECTORS_PLAN.md` (6 phases, read-only connectors to expense-tracking, run-insights and Seer). Phase 1 (P1-NOTES-A012, plan `.workflows/plan/P1-NOTES-A012.md`) landed the connector core in `src/connectors/`, the six generic `<system>_schema`/`<system>_sql` tools, the single-SELECT guard, the instructions paragraph, the compact/`ConnectorError` changes in `src/mcp/tools.ts`, the `mcp-notes-pg-connectors` Docker harness and `npm run test:live:connectors`. Phase 2 (P1-NOTES-A013, plan `.workflows/plan/P1-NOTES-A013.md`) filled the expenses curated tools (`src/connectors/expenses/{curated,categories,dates,queries}.ts`). Phase 3 (P1-NOTES-A014, plan `.workflows/plan/P1-NOTES-A014.md`) filled the runs curated tools (`src/connectors/runs/{curated,format,periods,queries}.ts`). Phase 4 (P1-NOTES-A015, plan `.workflows/plan/P1-NOTES-A015.md`) filled the Seer curated tools (`src/connectors/seer/{curated,rows,ranking,leaderboard,positions,sera}.ts`). Phase 5 (P1-NOTES-A016, plan `.workflows/plan/P1-NOTES-A016.md`) landed the chat bar side: `allowedChatTools()` adds the 15 connector tools, `captionForToolUse` captions them per system, the chat system prompt covers the three apps, and the `/n` skill routes spending, runs and Seer questions to the connector tools. Phase 6 (P2-NOTES-C506) landed readable links in the web answer panel.
