# Plan: Chat history, note files, image similarity search

**Slug:** chat-history-files-image-search
**Date:** 2026-10-31 08:15 (WIB)
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search`
**Branch:** `feature/chat-history-files-image-search` (base: `main` @ `d3ef659`)
**Phases:** 11
**Status:** complete
**Coordinator:** —

---

## Why

The agreed design, verbatim in `docs/plans/2026-10-31-chat-history-files-image-search-design.md` ("agreed in discussion 2026-10-31, ready for `/analyze`. Robustness over speed; phases ordered by dependency."). The user's instruction: "do not re-litigate decisions. Produce the full phased implementation plan for it. Robustness over speed." Scope as written in the design:

1. Paste an image into the chat query bar (wall chat, and `/n` in Claude Code).
2. Note files: attach any file to a note from the bigger-note-view modal; ctrl-v in that modal attaches to that note.
3. Chat history: persisted, own page, reply_to, edit/delete, note-id links, image thumbnails.
4. Image lightbox shared by chat and the note modal gallery.
5. Real image similarity search ("find similar photos as this").
6. UI fix: "Show in explorer" is centered in the note card footer; move it left.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Paste an image into the chat query bar (wall chat and `/n`) | 3, 8 |
| R2 | Note files: attach any file from the note modal, sha256 store, extraction-ready schema, agent visibility, per-file and note-level reveal | 4, 5 |
| R3 | Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button | 7, 8, 9, 10, 11 |
| R4 | One shared image lightbox (chat + note modal strip) | 2 |
| R5 | Image similarity search (Gemini Embedding 2 via OpenRouter, table, worker, backfill, `similar_images`, text→image) | 6 |
| R6 | "Show in explorer" aligned left in the note card footer | 1 |

Couplings that are real facts about the work: P3 serves R1 only for the wall chat; its `/n` half is P8 (needs the hook). P7 (R3 backend) is a prerequisite of P8-P11 but serves only R3. P6 serves R5 only; the `pasted_image` plumbing for `/n` belongs to P8 (R1, R3), not P6.

## Scope

**In scope:** everything in the design, plus the mechanisms it left as open items (decided under Decisions).
**Out of scope:** text extraction from files (schema only); importing old Agent SDK sessions; regenerating an answer after an edit; purge-forever of chat messages or files; files in the recycle-bin view; MCP tools that write files (`attach_file`); image similarity UI beyond the agent tool; auth beyond loopback.

## Invariants

1. At the end of every phase: `npm run typecheck`, `npm test` and `npm run test:int` pass and `npm run build` succeeds. No phase leaves the tree broken for the next.
2. Every new table has a drizzle migration generated with `npm run db:generate` (never hand-edited after apply), a `truncateAll` entry in `tests/integration/setup.ts`, and a schema header comment like the existing ones. Migrations are strictly chained: phases 3, 4, 6, 7 are sequential through `Depends on` and use migrations 0003, 0004, 0005, 0006 in that order.
3. All note/file/image writes keep the notes-service pattern: transaction, `lockNote` first, one `NoteEvents` op after commit. New writers for chat go through `ChatService`; routes never write rows directly.
4. Deletes stay soft and restorable; nothing in this plan adds a way to delete data for good except `purgeNote`'s existing path, which must also remove a purged note's files.
5. Paths received from clients are never trusted: stored paths are data-dir-relative and resolved with `resolveInDataDir`; ids, not paths, cross the HTTP boundary (as with reveal today).
6. Ids: note, image and file ids share the `A-B32` space (`newId()` checks all three tables). Chat message ids are 4 chars `[0-9A-Z]`, always written `[msg:K7F2]`; chat image ids are `A-B32` in their own table and always written `upload:ID`. No bare-id ambiguity.
7. Every user-visible time in chat UI is rendered in `Asia/Jakarta` (UTC+7) from UTC storage.
8. Network calls to OpenRouter in tests go through an injected fake; live (billed) tests are opt-in files under `tests/live` and never part of `npm test`/`test:int`.
9. Each phase updates the docs it makes stale: `claude/skills/n/SKILL.md`, `src/mcp/instructions.ts`, `README.md` sections, `CHANGELOG.md` (one line per phase under `## [Unreleased]`, creating the heading or subsection only if missing; see Shared files), and tool-count assertions.
10. Worktree setup for every phase session: `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing. Never run `scripts/install.sh` or touch `~/.claude/settings.json` from a phase except P8's install script tests against a temp `HOME`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Card footer: reveal button left | R6 | `web` | 4 | — | EASY | `.workflows/plan/chat-history-files-image-search/phase-1.md` | P1-NOTES-A034 | — |
| 2 | Shared Lightbox + note modal strip | R4 | `web` | 8 | — | NORMAL | `.workflows/plan/chat-history-files-image-search/phase-2.md` | P1-NOTES-A035 | — |
| 3 | Chat image store, paste into the bar, wall chat sends images | R1 | `src/chat`, `src/http`, `src/db`, `web` | 40 | — | HARD | `.workflows/plan/chat-history-files-image-search/phase-3.md` | P1-NOTES-A036 | — |
| 4 | Note files backend: schema, store, service, API, reveal, MCP visibility | R2 | `src/notes`, `src/files`, `src/http`, `src/db`, `src/mcp` | 38 | 3 | HARD | `.workflows/plan/chat-history-files-image-search/phase-4.md` | P1-NOTES-A037 | — |
| 5 | Note files UI: paperclip, chips, paste/drop routing, reveal | R2 | `web` | 21 | 1, 2, 3, 4 | NORMAL | `.workflows/plan/chat-history-files-image-search/phase-5.md` | P1-NOTES-A038 | — |
| 6 | Image embeddings and `similar_images` | R5 | `src/embeddings`, `src/mcp`, `src/db`, `src/cli`, `src/chat` | 52 | 3, 4 | HARD | `.workflows/plan/chat-history-files-image-search/phase-6.md` | P1-NOTES-A039 | — |
| 7 | Chat persistence: schema, context rebuild, reply_to, edit/delete API | R3 | `src/chat`, `src/http`, `src/db` | 46 | 3, 6 | HARD | `.workflows/plan/chat-history-files-image-search/phase-7.md` | P1-NOTES-A040 | — |
| 8 | Claude Code capture: hook, ingest endpoint, install, `/n` pasted images | R1, R3 | `claude/hooks`, `src/http`, `src/chat`, `scripts`, `src/mcp` | 30 | 6, 7 | HARD | `.workflows/plan/chat-history-files-image-search/phase-8.md` | P1-NOTES-A041 | — |
| 9 | History page, sidebar icon, full-screen button, timeline, thumbnails | R3 | `web` | 32 | 2, 3, 5, 7 | HARD | `.workflows/plan/chat-history-files-image-search/phase-9.md` | P1-NOTES-A042 | — |
| 10 | Bubble actions: reply_to, edit, delete, restore | R3 | `web` | 24 | 9 | NORMAL | `.workflows/plan/chat-history-files-image-search/phase-10.md` | P1-NOTES-A043 | — |
| 11 | Note-id links open the note modal in place; "show on wall" button | R3 | `web` | 18 | 10 | NORMAL | `.workflows/plan/chat-history-files-image-search/phase-11.md` | P1-NOTES-A044 | — |

File counts are individual files from each plan's Files table after reconciliation (generated drizzle files included). Phase 9 moved from NORMAL to HARD: 32 files, a shared `/api/events` connection that `useNotes` now goes through, URL sync and streaming sends.

Wave shape implied by the edges: W1 {1, 2, 3} → W2 {4} → W3 {5, 6} → W4 {7} → W5 {8, 9} → W6 {10} → W7 {11}. Edges are real: P4/P6/P7 chain through migration numbering; P5 edits files P1, P2 and P3 edit (`NoteCard`, `NoteEditor`, `DropOverlay`/`App`); P9 edits `App.tsx` after P5; P10 and P11 edit the bubble component P9 creates. No edge was added or removed in reconciliation: P11 edits `NoteEditor.tsx`/`App.tsx` after P5, which it already reaches through 10 → 9 → 5; P9-P11 do not need P8; P8 needs P6 (`similar_images`) and P7 (`recordExchange`) and reaches P3 through both.

### Shared files: who edits them, in order

Every later phase quotes these files as the earlier phases leave them (fixed in the plan code blocks during reconciliation).

| File | Sequence |
|---|---|
| `src/db/schema.ts` (header comment, imports, tables) | 3 → 4 → 6 → 7 |
| `drizzle/meta/_journal.json` | 3 (0003) → 4 (0004) → 6 (0005) → 7 (0006) |
| `src/deps.ts` | 6 (`imageEmbedder`) → 7 (`chat`) |
| `src/daemon.ts` | 3 (`chat-images` subdir) → 4 (`files` subdir) → 6 (image embedder) → 7 (`ChatService`) |
| `src/http/app.ts` | 3 (`chatImageRoutes`) → 4 (`fileRoutes`, reveal) → 6 (`mcpToolDeps`) → 7 (`chatHistoryRoutes`) → 8 (`captureRoutes`) |
| `src/http/api.ts` | 3 (`chatSchema`, image ids) → 7 (route rewrite, `event: chat`) |
| `src/http/chatImages.ts` | 3 only (owns the optional `source` field; P8 only sends it) |
| `src/chat/backend.ts`, `src/chat/agent.ts`, `src/chat/compose.ts` | 3 → 7 (extends `compose.ts`, keeps `readPreview`/`userTurn()`, drops `resume`) |
| `src/chat/prompt.ts` | 4 (files sentence) → 6 (pasted images + `similar_images`, P4 sentence kept) → 7 (context layout, `[msg:ID]`) |
| `src/chat/status.ts` | 6 only |
| `src/mcp/instructions.ts` | 4 (`Files.`) → 6 (`Similar images.` after `Files.`) |
| `src/mcp/similarTools.ts` | 6 (provisional `pasted_image` text) → 8 (final text, same constant name) |
| `claude/skills/n/SKILL.md` | 4 → 6 → 8 |
| `tests/integration/setup.ts` `truncateAll` | 3 → 4 → 6 → 7 |
| `tests/integration/imageHarness.ts` | 3 (`startHarness({chat})`) → 4 (`files/`) → 6 (`{chat, imageEmbedder}`) → 7 (`chat: new ChatService`) |
| `tests/integration/helpers/api-harness.ts` | 6 (`imageEmbedder: null`) → 7 (whole file, keeps it) |
| `tests/integration/chat.images.int.test.ts` | 3 (creates) → 7 (chat-turn cases follow the new contract) |
| `tests/unit/chat-agent.test.ts`, `chat-stub.test.ts`, `tests/live/chat.live.test.ts` | 3 → (6 live literal) → 7 |
| `web/src/types.ts` | 3 (`ChatImage`) → 4 (`NoteFile`, `Note.files?`) → 9 (`View`, chat types) |
| `web/src/api.ts` | 3 → 5 |
| `web/src/chatHistoryApi.ts` | 9 (creates) → 10 (`replyTo`, edit/delete/restore) |
| `web/src/components/DropOverlay.tsx` | 3 (`chatBarHasFocus` guard) → 5 (routing after the guard) |
| `web/src/components/NoteEditor.tsx` | 2 (Lightbox, Esc yield, `.ed-open`) → 5 (paperclip, chips, note reveal) → 11 (show on wall, after P5's buttons) |
| `web/src/components/NoteCard.tsx` + tests | 1 (slot after Copy ID) → 5 (`NoteRevealButton` in that slot, paperclip count) |
| `web/src/components/AnswerPanel.tsx` | 3 (thumbnails) → 9 (full-screen button, thumbnails open the Lightbox) → 11 (`ChatInline`) |
| `web/src/hooks/useChat.ts` | 3 → 9 |
| `web/src/components/ChatBar.css` | 3 → 9 (`.chatbar-page`) |
| `web/src/App.tsx` | 3 → 5 → 9 → 10 → 11 |
| `web/src/components/Bubble.tsx`, `HistoryPage.tsx`, `useHistory.ts`, `lib/timeline.ts` | 9 (creates) → 10 (slots, `send(…, replyTo)`, `pushUndo?`) → 11 (`Bubble` text through `ChatInline`) |
| `README.md` | every phase, each in its own section |
| `CHANGELOG.md` | every phase: one bullet under `## [Unreleased]` → `### Added`/`### Fixed`, creating either heading only if missing. P1, P2 and P3 run concurrently in W1 and may each create `## [Unreleased]`; the wave integrator keeps exactly one `## [Unreleased]` with one `### Added` and one `### Fixed`. Later phases append. |

### Phase 1 — Card footer: reveal button left
**Satisfies:** R6
**Owns:** moving the card-footer "Show in Explorer" button so it sits immediately after the copy-ID button, left side; tests (`footerSequence` order tests in `NoteCard.test.tsx`, a position check in `RevealMounts.test.tsx`).
**Does not touch:** what the button does (note-level behavior is P5), the PhotoModal and editor reveal buttons, `styles.css` (no change needed: `.card-date { margin-left: auto }` still pushes the right group).
**Exit criteria:** footer order is id, copy, reveal, (copied label), date-right; `.copied` label no longer pushes the reveal button; existing `NoteCard`/`RevealButton` tests updated and a new test asserts DOM order.

### Phase 2 — Shared Lightbox + note modal strip
**Satisfies:** R4
**Owns:** a standalone `Lightbox` component (`LightboxItem {id, src, label?, width?, height?, film?}`, `isLightboxOpen()` Esc seam, prev/next buttons and ArrowLeft/ArrowRight, Esc closes only itself, no wrap at ends), its CSS and tests; wiring it into the note editor's thumbnail strip (`.ed-open` buttons, the editor's Esc listener yields while a lightbox is open).
**Does not touch:** `PhotoModal`/`Gallery` (own viewer, stays), chat UI (P9 consumes the component), file chips.
**Exit criteria:** clicking a strip thumbnail opens the lightbox on it; arrows/keys move between the note's available images without closing; Esc closes the lightbox but not the editor; component accepts a generic item list so chat can reuse it.

### Phase 3 — Chat image store, paste into the bar, wall chat sends images
**Satisfies:** R1
**Owns:** migration 0003 `chat_images`; chat-image store `src/chat/images.ts` (sha256 dedupe, derivatives under `cache/c_<id>/`, `chat-images/YYYY/MM/`, `ingestChatImage`, `locateChatImage`, `resolveTurnImages`); `src/chat/compose.ts` (`composeUserTurn`, `toSdkPrompt`); `POST /api/chat/images` (multipart `file`, optional `source` = `wall` | `claude_code`, else 400 `invalid_source`; answers `{image, created}`) + `GET /api/chat/images/:id[/:variant]`; `chatSchema` gains `image_ids` (message may be empty when images are present; lookup errors 400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`); agent sends images as content blocks of one SDK user message and tags them `[image upload:ID]`; `useChatImages` hook; ChatBar paste handling with removable thumbnails and `variant: 'wall' | 'page'`; `DropOverlay` global paste yields when the ChatBar is focused (`chatBarHasFocus`); `AnswerPanel` shows the sent thumbnails; `useChat.ask(message, imageIds)`.
**Does not touch:** `similar_images` (P6), history tables and context rebuild (P7), `resume` removal (P7), the `/n` hook (P8), the Lightbox wiring of thumbnails (P9).
**Exit criteria:** pasting an image into the focused bar uploads it and shows a removable thumbnail; sending references it by id; the model receives the image; pasting elsewhere still creates a note and inside the open editor still attaches; integration tests cover upload (413/415/dedupe/`source`), chat request validation and prompt composition with a fake `query`.

### Phase 4 — Note files backend
**Satisfies:** R2
**Owns:** migration 0004 `note_files` (extracted_text + extraction_status, no extraction); `files/<noteId>/<safeName>` store with sha256 dedupe (stored name sanitised; `NoteFile.name` is the display name); `NotesService.attachFile/removeFile/restoreFile`; `Note.files` on the wire (required server-side, optional `files?` in `web/src/types.ts`); `POST /api/notes/:id/files` (`{note, attached, kind}`), `DELETE /api/files/:id`, `POST /api/files/:id/restore` (409 `duplicate_file`), `GET /api/files/:id`, `GET /api/files/:id/download`; reveal routes (`POST /api/files/:id/reveal` selects the file, `POST /api/notes/:id/reveal` opens the note's files folder, or selects the first image when the note has no files, 404 when it has neither); `purgeNote` removes the files folder; MCP `describeNote`/note JSON expose name, size, type; instructions, chat prompt sentence and `/n` skill text.
**Does not touch:** any web file except `web/src/types.ts` (type only); no file-writing MCP tool; no bin-view changes.
**Exit criteria:** attach/remove/restore/purge covered by integration tests; same bytes in two notes → holder returned; download is `attachment` with `nosniff`; `get`/`list` MCP results include `files`; migration chain intact.

### Phase 5 — Note files UI
**Satisfies:** R2
**Owns:** paperclip button + hidden picker in `NoteEditor`; `FileChips` (name, size, type, download, per-file reveal, remove with 6 s undo); ctrl-v and drop of non-image files into the open modal attach to that note (images keep the image path); `NoteRevealButton` (card footer slot from P1 and editor top bar) calling the note-level route, visible by the same rule as the route; empty-note rules count files (`hasAttachments`); card paperclip count; `web/src/api.ts` file calls with `DuplicateFileError`; `makeNote` always sets `files: []` (the only phase that touches that fixture).
**Does not touch:** server code, `web/src/types.ts`, the chat UI, the bin view, P2's Lightbox/Esc seam.
**Exit criteria:** component tests for picker, paste, drop, chips, undo, dedupe notice, reveal calls; a text-only note holding only files is not auto-deleted on close.

### Phase 6 — Image embeddings and `similar_images`
**Satisfies:** R5
**Owns:** `ImageEmbedder` (Gemini Embedding 2 over OpenRouter, 1536 dims, PNG data URL, client-side truncate + renormalise guard) and its fake; migration 0005 `note_image_embeddings`; repo (pending, save, failure, nearest); worker + backfill reusing `RateLimiter`/`Clock`; `npm run embed:images:backfill` with `--dry-run`/`--limit`/`--retry-failed`; MCP `similar_images` (`image_id` | `upload_id` (resolved through P3's `locateChatImage`) | `query`, `limit`; `pasted_image` accepted and answered with a provisional "needs the notes-paste hook" error until P8); `startHarness({chat, imageEmbedder})`; chat allowlist, captions, prompt, instructions, `/n` skill; opt-in live test.
**Does not touch:** the Claude Code hooks (P8), chat persistence, any web file.
**Exit criteria:** worker embeds new images and skips images whose file is not on this machine without recording failures; nearest search excludes the source image and deleted notes; text query works through the same space; live probe test documents the verified request shape.

### Phase 7 — Chat persistence
**Satisfies:** R3
**Owns:** migration 0006 (`chat_threads`, `chat_messages`, `chat_message_revisions`, `chat_message_attachments`); `ChatService` (create thread/messages, short ids, edit with revision, soft delete/restore, timeline, `recordExchange` for P8); context builder (history + reply targets, char budget, `[msg:ID]` labels, image placeholders); `composeWallTurn` extending P3's `compose.ts` (`ChatTurnImage.messageId?`, `[image upload:ID] from [msg:ID]`); leading-`[msg:ID]` citation parser → `reply_to`; backend contract change (`ChatRequest {turn, signal}`, no `resume`, `persistSession` off; preview bytes still read by P3's `readPreview`); `POST /api/chat` persists the user row first, sends `event: accepted {thread_id, user_message_id}`, the assistant row on success, `done {thread_id, user_message_id, assistant_message_id, reply_to, brain?}`; `GET /api/chat/messages` (`{messages, next_before}`, `include_deleted`), `GET /api/chat/threads/:id`, `PATCH`, `DELETE` (`{deleted: [ids]}`), `restore` (one id, idempotent); `event: chat {op: created|updated|deleted|restored, thread_id, id}` on `/api/events`; system prompt teaches `[msg:ID]`.
**Does not touch:** the Claude Code ingest (P8), any web file.
**Exit criteria:** a two-turn wall conversation survives a daemon restart and brain fallback with identical context; reply_to to a bubble in another thread is injected; edit keeps a revision; deleted messages leave context; integration tests with the scripted backend.

### Phase 8 — Claude Code capture
**Satisfies:** R1, R3
**Owns:** `claude/hooks/notes-capture.mjs` (Stop, async, outbox retry, idempotent), `claude/hooks/notes-paste.mjs` (PreToolUse on `mcp__notes__similar_images`, uploads the pasted image with `source=claude_code` and rewrites `pasted_image` to `upload_id`; `updatedInput` default, `deny` fallback); `src/chat/capture.ts` + `POST /api/capture/claude-code` (loopback + custom-header guard, idempotent on external key through P7's `recordExchange`, images copied into P3's store with `ingestChatImage`); `scripts/install.sh`/`uninstall.sh` merge and remove the hooks in `~/.claude/settings.json` idempotently; final `pasted_image` text in `similar_images`; `/n` skill text; `npm run verify:paste-hook`.
**Does not touch:** history UI (P9), persistence internals beyond calling `ChatService`, `src/http/chatImages.ts` (P3 owns the `source` field).
**Exit criteria:** feeding a synthetic transcript (string-form and array-form user entries, image blocks, `imagePasteIds`) produces one single-turn `claude_code` thread with the images stored; replay is a no-op; daemon-down spools to the outbox and a later run delivers; install/uninstall tested against a temp `HOME`.

### Phase 9 — History page
**Satisfies:** R3
**Owns:** `View` gains `history` with `/history[?thread=ID]` URL sync (back/forward), including the pathname guard that keeps `/?note=ID` when switching to the wall; chat wire types mirroring P7 (`ChatMessage`, `ChatAttachment {kind,id,url,thumb_url}`, `ChatReplyPreview`, `ChatPage`, `ChatOp`); `chatHistoryApi.ts`; `useHistory(enabled, {includeDeleted})` (`messages`, `mutate`, `loadOlder`, `send`); `HistoryPage` timeline (unified, ascending, thread dividers, "claude code" badge, UTC+7 timestamps on every bubble, thumbnails opening the Lightbox) with its own `HistoryComposer` (`<ChatBar variant="page">` + its own `useChatImages()`); `Bubble`; live refresh from `event: chat` on one shared `/api/events` connection; chat-history icon above the recycle bin in `Rail` and `Sidebar`; "chat in full screen" button and Lightbox-opening thumbnails in `AnswerPanel`; `makeMessage` fixture (only creator).
**Does not touch:** reply/edit/delete UI (P10), note-id links (P11), server code.
**Exit criteria:** component and hook tests; new wall exchanges and captured `/n` exchanges appear without reload; navigation keeps the notes store; `/?note=ID` survives a switch to the wall.

### Phase 10 — Bubble actions
**Satisfies:** R3
**Owns:** reply action → quote chip inside P9's `HistoryComposer` → `reply_to` in the request (`streamChat` `replyTo`, `send(text, imageIds, replyTo?)`; a reply to a wall bubble continues its thread, to a claude_code bubble starts a new one); `MessageItem` rendering P9's `Bubble` through new optional `slots` (one `li` per message, no wrapper); reply bubbles show a quoted header (`reply_to.text`, role or "message"), click scrolls to and highlights the target, deleted target reads "message deleted"; edit user bubbles in place with "edited" mark; delete any bubble with "delete the answer too?" prompt for questions; undo bar restores each id from `deleted[]`; "show deleted" toggle filtering client-side (App fetches with `includeDeleted: true`); `HistoryPage` `pushUndo?`.
**Does not touch:** server (P7 contract), note-id links (P11), `web/src/api.ts`, `web/src/types.ts`.
**Exit criteria:** tests for each action against mocked API; keyboard accessible.

### Phase 11 — Note-id links and show-on-wall
**Satisfies:** R3
**Owns:** note-id segmenting in chat text (`segmentChat`, `ChatInline`) in `Bubble` (as P10 leaves it) and `AnswerPanel` (as P9 leaves it); clicking opens the bigger-note-view modal in place (loaded or fetched note; deleted/unknown handled quietly); wall deep links in chat text become in-place links too, keeping `href="/?note=ID"` so modified/middle clicks and new tabs navigate normally; `NoteEditor` icon button (after P5's buttons in `.ed-top`) that goes to `/?note=ID` and flashes the note on the wall.
**Does not touch:** server, URL sync (P9), `useDeepLink`.
**Exit criteria:** ids inside code-ish tokens and longer words are not linked; opening from the history page does not navigate; ctrl/middle click keeps the real link; the modal button switches to the wall view and flashes the card.

## Reconciliation Log

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | P9 coded against an assumed `usePastedImages` (`readyIds()`, `busy`) | Unmet assumption | P9 uses P3's `useChatImages` (`readyIds` array, `blocked`), `<ChatBar variant="page" sendBlocked>` |
| 2 | P7 coded against assumed P3 names (`TurnImage`, `loadTurnImages`, `ChatImageError`, `composeUserTurn(text, images)`, `MAX_CHAT_IMAGES`, upload `{id}`) | Unmet assumption | P7 uses `ChatTurnImage`, `resolveTurnImages`, `ChatImageLookupError`, `MAX_CHAT_IMAGES_PER_MESSAGE`, P3's `compose.ts`/`readPreview`/`userTurn()`, upload `{image, created}` |
| 3 | P7 planned to edit P3's `src/chat/images.ts` for message-labelled images | File collision | P7 extends `compose.ts` (`imageLabel`, `composeLabelledText`, `ComposeInput.images[].messageId`) and `ChatTurnImage.messageId?`; P3 output byte-identical without it |
| 4 | P7 mapped chat image lookup errors to 400/404, P3 to 400/409/422 | Contract drift | P3's mapping and helper kept; P7's `chatImageErrorResponse` and `promptFor` dropped |
| 5 | P7 would break P3's `chat.images.int.test.ts`, `chat-agent.test.ts`, live test (old `ChatRequest`) | Broken-build phase | P7 updates those files (new Steps 21f/21g/22c/22d) |
| 6 | P7's `chatSchema` dropped P3's `message` default `''` | Contract drift | P3's default and id cap kept |
| 7 | P6's `upload_id` adapter queried `chatImages.path` directly | Duplicate work | adapter wraps P3's `locateChatImage` |
| 8 | P6 replaced `startHarness({chat})` with `startHarness({imageEmbedder})` | File collision | merged `startHarness({ chat?, imageEmbedder? })`; P7, P8 quote it |
| 9 | P6 prompt edit dropped P4's files sentence | File collision | P6 keeps P4's sentence; P4's test holds |
| 10 | P6 `Similar images.` paragraph placed before P4's `Files.` (breaks P4's order test) | File collision | placed after `Files.` |
| 11 | P6 `truncateAll` order, schema header, SKILL.md anchors written against main | File collision | quote post-P3/P4 text |
| 12 | P4 hedged on P3's `DATA_SUBDIRS`, `truncateAll`, schema header, `imageHarness`, `app.ts` | File collision | exact post-P3 text quoted |
| 13 | P7 `deps.ts`, daemon literal, schema header, `truncateAll`, `api-harness.ts`, AppDeps test literals written without P6's `imageEmbedder` | File collision | quote post-P3/P4/P6 text; `imageEmbedder: null` kept |
| 14 | P6 texts named the `notes-capture` hook for `pasted_image` | Contract drift | renamed `notes-paste` |
| 15 | P8 Step 14b edited P3's `src/http/chatImages.ts` (`source` field) | File collision | moved into P3 Step 7 + P3 test; P8 rows and step removed |
| 16 | P8 replaced P6 text located by wrong wording | File collision | P8 anchors on the constant name, bullet opening words, test title, README row sentence |
| 17 | P8's `app.ts` mount quoted main | File collision | quotes post-P3/P4/P6/P7 |
| 18 | P5 assumed P4's wire loosely (no `kind`, attach 409 unhandled, `extraction_status` vague) | Unmet assumption | P5 types `kind`, maps attach 409 to `DuplicateFileError`/`DuplicateImageError`, real union |
| 19 | P5 `noteRevealable` disagreed with P4's note-reveal 404 rule | Contract drift | mirrors the route (files decide when present, else images) |
| 20 | `makeNote` `files` possibly added by both P4 and P5; web `Note.files` required-or-optional undecided | Duplicate work | optional; only P5 adds `files: []` |
| 21 | P5's NoteEditor.test import dropped P2's `screen` | Broken-build phase | restored; P5 tests append after P2's block |
| 22 | P5 DropOverlay/App/api.ts anchors quoted main line numbers | File collision | post-P3 text anchors |
| 23 | P5 RevealMounts/NoteCard edits vs P1's footer tests | File collision | P5 quotes P1's post-change text; `footerSequence` cases stay valid; position check moves to `[data-reveal-note]` |
| 24 | P9 assumed P7 wire (`create` ops, `next_cursor`, attachments with dimensions/name, `role` non-null) | Unmet assumption | P9 mirrors P7: past-tense ops, `next_before`, `{kind,id,url,thumb_url}`, nullable `role`, `include_deleted=1` |
| 25 | P9 App/useChat/AnswerPanel/types anchors quoted main | File collision | post-P3/P5 text |
| 26 | P3 handed AnswerPanel thumbnail → Lightbox wiring to P9; P9 did not own it | Gap | P9 owns it (+ `ChatBar.css`) |
| 27 | `chatFixtures.ts` `makeMessage` created by P9 and P10 | Duplicate work | P9 only; P10, P11 import it |
| 28 | P10 asked P7 to add `role` to `reply_to` | Unmet assumption | already present (nullable); P10 Step 1 removed, no P7 edit |
| 29 | P10 used `snippet`, `formatChatTime`, `ChatReplyRef`, helpers in `api.ts`, `postChat(replyTo)` | Unmet assumption | `reply_to.text`, `chatTimeTitle`, `ChatReplyPreview`, helpers in `chatHistoryApi.ts`, `streamChat({replyTo})` |
| 30 | P10 `MessageItem` wrapped P9's `<li>` in a `div` inside `<ol>` | Contract drift | `Bubble` gets optional `slots`; `MessageItem` renders `Bubble` |
| 31 | P10 hedged PATCH/restore shapes | Contract drift | bare message; restore idempotent; undo restores each id of `deleted[]` |
| 32 | P10 assumed `HistoryPage` composer and a fixed reply chip | Unmet assumption | chip is the first row of P9's `HistoryComposer` |
| 33 | `pushUndo` required prop would break P9's direct `HistoryPage` renders | Broken-build phase | optional, default no-op |
| 34 | `historyCountLine` would count deleted rows once P10 fetches them | Contract drift | skips deleted rows (P10 edits P9's `timeline.ts`) |
| 35 | URL-sync pathname guard claimed by P9 and (fallback) P11 | Duplicate work | P9 owns it with a test; P11's fallback removed |
| 36 | P11 assumed Bubble/AnswerPanel/NoteEditor/App shapes | Unmet assumption | quotes post-P9/P10 Bubble, post-P9 AnswerPanel, post-P5 NoteEditor (`Crosshair` after P5's buttons), App after 3/5/9/10 |
| 37 | P11's wall-deep-link conversion could hijack real `/?note=ID` navigation | Contract drift | kept with `href` intact, plain left click only intercepted, ChatText test for ctrl/middle click |
| 38 | P2 handoff told P9 to read `original_name`, `width`, `height` from chat images | Contract drift | handoff now uses P7 attachments `{id, src: url}` |
| 39 | CHANGELOG `## [Unreleased]` created unconditionally by P1, P3 | File collision | every phase creates headings only if missing; W1 integrator keeps one |
| 40 | Index file counts underestimated | — | recounted from Files tables; P9 → HARD |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Image embedding width: model default 3072 vs HNSW cap 2000 | `dimensions: 1536` requested, plus client-side truncate and L2-renormalise if 3072 comes back; `vector(1536)` + HNSW cosine | 5 (pgvector limit, model's recommended size, matches existing column width) |
| Image bytes sent to Gemini | the `preview` derivative re-encoded to PNG, long edge ≤ 1024 (PNG is the verified type; bounds token cost) | 5 |
| Transport for pasted chat images (design open item) | separate upload endpoint `POST /api/chat/images` → `chat_images` table, referenced by id; not note images (a query image must not become a note) | 5 |
| How `/n` passes a pasted image to a tool (no file path exists) | `similar_images({pasted_image: N})`; PreToolUse hook uploads the Nth image of the latest user entry and rewrites to `upload_id` via `updatedInput` | 5 |
| Hook install location and auth (design open item) | user-scope `~/.claude/settings.json`, merged idempotently by `scripts/install.sh`; Stop hook is `async` with an outbox; endpoint is loopback-only and demands header `X-Notes-Capture: 1` (forces a CORS preflight the daemon never answers) | 5 |
| Where note files live | `files/<noteId>/<safeName>` (original name, collision-suffixed, Windows-safe), so "folder containing all of the note's files" exists | 5 (design sentence needs a per-note folder; images keep `images/YYYY/MM`) |
| Note-level "Show in explorer" semantics with images and files | note has files → open the files folder; no files → select the first image (today's behavior); neither → 404, and the button is hidden by the same rule | 5 |
| Client routing of attached files | client sends images to `/images`, everything else to `/files`; `/files` delegates anything the sniffer says is a supported image (`kind: 'image'`) | 5 |
| History page as a separate HTML entry vs an App view | `View = 'wall' \| 'bin' \| 'history'` with pushState; SPA fallback already serves `/history`; keeps the note store and lets note links open the modal in place | 5 |
| Message id and citation syntax | 4-char `[0-9A-Z]` shown as `[msg:K7F2]`; the model replies to a bubble by *starting* its answer with `[msg:ID]`, which the server strips into `reply_to` (a mid-text `[msg:ID]` is just text) | 5 |
| Deleted chat messages: bin or not | soft delete + 6 s undo + "show deleted" toggle on the history page; no purge, no bin-view section | 5 (design says "same pattern", not "same view") |
| Which thread a history-page message joins | latest wall thread if it is the newest exchange of the timeline, else a new thread; replying to a bubble in a wall thread continues that thread, replying to a claude_code bubble starts a new one with `reply_to` | 5 |
| Images from earlier turns in rebuilt context | placeholders `[image upload:ID]` only; current-turn and reply-target images are sent as image blocks (cost bound); context char budget with oldest-first drop and a visible "earlier messages omitted" line | 5 |
| Partial assistant text when the client aborts | not persisted (user row stays, unanswered) | 5 |
| Lightbox at the ends | arrows disable at first/last, no wrap ("adjacent images") | 1: design wording |
| Text→image search model | queries embed with the Gemini text path, never `text-embedding-3-small` (different space) | 1: design ("text and images share one vector space") |
| Image-embedding worker scope | embeds every pending image, not only new ones (cost ≈ cents per thousand); `embed:images:backfill` exists for explicit/retry runs | 5 (reversible by one constant) |
| Migrations in parallel branches | phases 3, 4, 6, 7 chained by `Depends on`; migrations 0003-0006 in that order | 2: phase exit criteria (drizzle snapshot chain) |
| Files in the recycle-bin view | not in v1; removed files are undoable for 6 s and removed with their note's purge | 5 (design silent) |
| Web `Note.files` required or optional | optional `files?: NoteFile[]` on the web type (server always sends it); UI reads `note.files ?? []`; only P5 adds `files: []` to `makeNote` | 3: plan code blocks (P4 Step 18 + handoff) |
| Who owns the `source` field of `POST /api/chat/images` | P3 (route owner); P8's hook only sends `source=claude_code` | Rule 3 (one owner per file region); P8's own handoff offered the move |
| `upload_id` lookup in `similar_images` | wraps P3's `locateChatImage`, no second query of `chat_images` | 3: plan code blocks (P3 handoff names the helper) |
| `startHarness` options after P3 and P6 | `startHarness({ chat?: ChatBackend; imageEmbedder?: ImageEmbedder \| null })` | 1: build-green, then plan code blocks |
| Chat image lookup errors on `POST /api/chat` | P3's codes: 400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`, `{error, id, message}` | 3: plan code blocks (P3), P7's own "keep phase 3's" note |
| Where preview bytes are read after P7 | stays in the agent (`readPreview` in `ChatRun.userTurn()`); `composeWallTurn` only selects images and sets `messageId` | 3: plan code blocks (P3 Step 6), least churn |
| P10's request for `role` in `reply_to` | already in P7's `ChatReplyPreview` (`role: 'user'\|'assistant'\|null`); no server change | 3: plan code blocks (P7 Step 5) |
| History composer placement | rendered by `HistoryPage` (`HistoryComposer`, own draft and `useChatImages()`); App renders no ChatBar in the history view; the reply chip sits inside it | 3: plan code blocks (P3 `variant: 'page'` = laid out by its parent; P3 handoff) |
| P10 actions vs P9's `<li>` bubble root | `Bubble` gains optional `slots`; `MessageItem` renders `Bubble`, no wrapper element | 3: plan code blocks (P9 Bubble + its `[data-msg]` tests) |
| "Show deleted" mechanics | App always fetches with `includeDeleted: true`; the toggle (sessionStorage) filters client-side | 3: plan code blocks (P10 over P9's option) |
| `HistoryPageProps.pushUndo` | optional, default no-op | 1: build-green |
| URL-sync pathname guard owner | P9 (`hrefForView`), with a test that `/?note=ID` survives a switch to the wall; P11 adds none | Rule 3 (one owner) |
| P11 converting wall deep links in chat text into in-place links | kept; `href` stays `/?note=ID`, only a plain unmodified left click is intercepted, `useDeepLink` untouched | 4: index R3 / design ("every note id in chat text renders as a link that opens the modal in place, no navigation") |
| AnswerPanel sent thumbnails | open the shared Lightbox; owned by P9 | 4: R4 (one shared lightbox) + P3 handoff |
| `similar_images` provisional text between P6 and P8 | P6 ships a "needs the notes-paste hook" error; P8 replaces it under the same constant name | 3: plan code blocks |
| CHANGELOG with no `[Unreleased]` on main and three concurrent W1 phases | each phase creates `## [Unreleased]` / `### Added|Fixed` only if missing; the W1 integrator keeps one heading | 6: convention (Keep a Changelog) |

## Open Questions

None. Every fork above has a reversible branch, and every requirement has an owner: R1 → 3, 8; R2 → 4, 5; R3 → 7, 8, 9, 10, 11; R4 → 2; R5 → 6; R6 → 1.

## Pre-merge checks (manual, not blockers)

- **P3 image prompt path:** the AsyncIterable-prompt (streaming input) path that carries image blocks is proven only by the opt-in billed live chat test. Run the image case of `npm run test:live` once before merging the set. GLM's acceptance of image blocks is unverified (surfaces as a normal `event: error`).
- **Production migrations:** migrations 0003-0006 must be applied to Neon with `npm run db:migrate` at merge time, from the main checkout. Phases never run `db:migrate` from the worktree.
- **P8 paste hook:** `updatedInput` for MCP tools is not confirmed by the Claude Code docs. Default strategy `updatedInput`, with `NOTES_PASTE_STRATEGY=deny` as fallback; run `npm run verify:paste-hook` (opt-in, billed, one call) once before merge and switch to `deny` if it fails.

## Rollback

Per phase: each phase is one commit series on the feature branch; revert the phase's commits. DB: migrations 0003-0006 only add tables, so a revert that leaves the tables in place is harmless; to drop them run the inverse DROP statements by hand (documented in each phase plan's Rollback). Whole set: do not merge `feature/chat-history-files-image-search`, or revert the merge commit; drop tables `chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, note_files, chat_images` and remove `files/`, `chat-images/` under the data dir. P8 additionally: `scripts/uninstall.sh` removes the hook entries from `~/.claude/settings.json`. Migrations reach Neon only through `npm run db:migrate` at merge time (see Pre-merge checks).

## Next

Before merging the set, run the three Pre-merge checks above.

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f docs/plans/CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md
