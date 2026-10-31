# Todos: mcp-notes

**Package Path**: `.`
**Package Code**: NOTES
**Last Updated**: 2026-10-31
**Total Active Tasks**: 1

## Quick Stats
- P0 Critical: 0
- P1 High: 1
- P2 Medium: 0
- P3 Low: 0
- P4 Backlog: 0
- Blocked: 0
- Completed: 46

---

## Active Tasks

### [P0] Critical

### [P1] High

- [ ] **P1-NOTES-A044** Phase 11: Note-id links open the note modal in place; "show on wall" button
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns note-id segmenting in chat text (`segmentChat`, `ChatInline`) in `Bubble` (as P10 leaves it) and `AnswerPanel` (as P9 leaves it); clicking opens the bigger-note-view modal in place (loaded or fetched note; deleted/unknown handled quietly); wall deep links in chat text become in-place links too, keeping `href="/?note=ID"` so modified/middle clicks and new tabs navigate normally; `NoteEditor` icon button (after P5's buttons in `.ed-top`) that goes to `/?note=ID` and flashes the note on the wall. Exit: ids inside code-ish tokens and longer words are not linked; opening from the history page does not navigate; ctrl/middle click keeps the real link; the modal button switches to the wall view and flashes the card.
  - **Status**: open
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 11 of 11)
  - **Satisfies**: R3 — Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button
  - **Depends on**: P1-NOTES-A043 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A044.md`

### [P2] Medium

### [P3] Low

### [P4] Backlog

---

## Completed Tasks

- [x] **P1-NOTES-A043** Phase 10: Bubble actions: reply_to, edit, delete, restore
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns reply action → quote chip inside P9's `HistoryComposer` → `reply_to` in the request (`streamChat` `replyTo`, `send(text, imageIds, replyTo?)`; a reply to a wall bubble continues its thread, to a claude_code bubble starts a new one); `MessageItem` rendering P9's `Bubble` through new optional `slots` (one `li` per message, no wrapper); reply bubbles show a quoted header (`reply_to.text`, role or "message"), click scrolls to and highlights the target, deleted target reads "message deleted"; edit user bubbles in place with "edited" mark; delete any bubble with "delete the answer too?" prompt for questions; undo bar restores each id from `deleted[]`; "show deleted" toggle filtering client-side (App fetches with `includeDeleted: true`); `HistoryPage` `pushUndo?`. Exit: tests for each action against mocked API; keyboard accessible.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 10 of 11)
  - **Satisfies**: R3 — Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button
  - **Depends on**: P1-NOTES-A042 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A043.md`
  - **Completed**: 2026-10-31 11:30
  - **Method**: /do
  - **Files**: .workflows/todos.md, .workflows/orchestration/chat-history-files-image-search/PLAN.md, CHANGELOG.md, README.md, web/src/App.tsx, web/src/api.chatActions.test.tsx, web/src/chatHistoryApi.ts, web/src/components/Bubble.tsx, web/src/components/BubbleActions.flow.test.tsx, web/src/components/HistoryTools.tsx, web/src/components/MessageItem.css, web/src/components/MessageItem.test.tsx, web/src/components/MessageItem.tsx, web/src/components/ReplyChip.tsx, web/src/hooks/useHistory.reply.test.tsx, web/src/hooks/useHistory.ts, web/src/hooks/useHistoryActions.ts, web/src/hooks/useJumpToMessage.test.tsx, web/src/hooks/useJumpToMessage.ts, web/src/hooks/useMessageActions.ts, web/src/hooks/useShowDeleted.ts, web/src/lib/chatReply.test.tsx, web/src/lib/chatReply.ts, web/src/lib/timeline.test.tsx, web/src/lib/timeline.ts, web/src/pages/HistoryPage.tsx
  - **Drift**:
    - Plan's HistoryComposer called store.send(draft, ids, replyTo ?? undefined), which broke P9's HistoryPage.test (expects send called with exactly 2 args); changed to call with 2 args when not replying.
  - **Decided**:
    - HistoryComposer send arity: P9 test asserts toHaveBeenCalledWith('and now?', []) vs plan code block passing undefined third arg → call send(draft, ids) when no reply target (rung 2: exit criteria 'P9 tests still pass' over rung 3 code block)

- [x] **P1-NOTES-A041** Phase 8: Claude Code capture: hook, ingest endpoint, install, `/n` pasted images
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `claude/hooks/notes-capture.mjs` (Stop, async, outbox retry, idempotent), `claude/hooks/notes-paste.mjs` (PreToolUse on `mcp__notes__similar_images`, uploads the pasted image with `source=claude_code` and rewrites `pasted_image` to `upload_id`; `updatedInput` default, `deny` fallback); `src/chat/capture.ts` + `POST /api/capture/claude-code` (loopback + custom-header guard, idempotent on external key through P7's `recordExchange`, images copied into P3's store with `ingestChatImage`); `scripts/install.sh`/`uninstall.sh` merge and remove the hooks in `~/.claude/settings.json` idempotently; final `pasted_image` text in `similar_images`; `/n` skill text; `npm run verify:paste-hook`. Exit: feeding a synthetic transcript (string-form and array-form user entries, image blocks, `imagePasteIds`) produces one single-turn `claude_code` thread with the images stored; replay is a no-op; daemon-down spools to the outbox and a later run delivers; install/uninstall tested against a temp `HOME`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 8 of 11)
  - **Satisfies**: R1, R3 — Paste an image into the chat query bar (wall chat and `/n`); Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button
  - **Depends on**: P1-NOTES-A039 (satisfied), P1-NOTES-A040 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A041.md`
  - **Completed**: 2026-10-31 11:02
  - **Method**: /do
  - **Files**: CHANGELOG.md, README.md, claude/skills/n/SKILL.md, package.json, scripts/install.sh, scripts/uninstall.sh, src/http/app.ts, src/mcp/similarTools.ts, tests/integration/similarImages.mcp.int.test.ts, claude/hooks/lib/transcript.mjs, claude/hooks/lib/transcript.d.mts, claude/hooks/lib/state.mjs, claude/hooks/lib/state.d.mts, claude/hooks/notes-capture.mjs, claude/hooks/notes-capture.d.mts, claude/hooks/notes-paste.mjs, claude/hooks/notes-paste.d.mts, scripts/claude-hooks.mjs, scripts/claude-hooks.d.mts, scripts/verify-paste-hook.mjs, src/chat/capture.ts, src/http/capture.ts, tests/unit/hooks/fixtures.ts, tests/unit/hooks/transcript.test.ts, tests/unit/hooks/notesCapture.test.ts, tests/unit/hooks/notesPaste.test.ts, tests/unit/scripts/claudeHooks.test.ts, tests/unit/captureGuard.test.ts, tests/integration/capture.int.test.ts, tests/integration/capture.hook.int.test.ts
  - **Drift**:
    - none; branch had no remote counterpart so nothing to rebase onto
  - **Decided**:
    - Completion bookkeeping: no task unblocked. Phases 9-11 do not depend on phase 8 (swarm coordinator owns ordering).

- [x] **P1-NOTES-A042** Phase 9: History page, sidebar icon, full-screen button, timeline, thumbnails
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `View` gains `history` with `/history[?thread=ID]` URL sync (back/forward), including the pathname guard that keeps `/?note=ID` when switching to the wall; chat wire types mirroring P7 (`ChatMessage`, `ChatAttachment {kind,id,url,thumb_url}`, `ChatReplyPreview`, `ChatPage`, `ChatOp`); `chatHistoryApi.ts`; `useHistory(enabled, {includeDeleted})` (`messages`, `mutate`, `loadOlder`, `send`); `HistoryPage` timeline (unified, ascending, thread dividers, "claude code" badge, UTC+7 timestamps on every bubble, thumbnails opening the Lightbox) with its own `HistoryComposer` (`<ChatBar variant="page">` + its own `useChatImages()`); `Bubble`; live refresh from `event: chat` on one shared `/api/events` connection; chat-history icon above the recycle bin in `Rail` and `Sidebar`; "chat in full screen" button and Lightbox-opening thumbnails in `AnswerPanel`; `makeMessage` fixture (only creator). Exit: component and hook tests; new wall exchanges and captured `/n` exchanges appear without reload; navigation keeps the notes store; `/?note=ID` survives a switch to the wall.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 9 of 11)
  - **Satisfies**: R3 — Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button
  - **Depends on**: P1-NOTES-A035 (satisfied), P1-NOTES-A036 (satisfied), P1-NOTES-A038 (satisfied), P1-NOTES-A040 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A042.md`
  - **Completed**: 2026-10-31 10:55
  - **Method**: /do
  - **Files**: .workflows/todos.md, .workflows/orchestration/chat-history-files-image-search/PLAN.md, CHANGELOG.md, README.md, tests/unit/static.test.ts, web/src/App.test.tsx, web/src/App.tsx, web/src/App.history.test.tsx, web/src/chatHistoryApi.ts, web/src/components/AnswerPanel.test.tsx, web/src/components/AnswerPanel.tsx, web/src/components/Bubble.tsx, web/src/components/ChatBar.css, web/src/components/Header.tsx, web/src/components/Rail.test.tsx, web/src/components/Rail.tsx, web/src/components/Sidebar.tsx, web/src/hooks/useChat.test.tsx, web/src/hooks/useChat.ts, web/src/hooks/useHistory.test.tsx, web/src/hooks/useHistory.ts, web/src/hooks/useNotes.ts, web/src/lib/chatTime.test.tsx, web/src/lib/chatTime.ts, web/src/lib/events.test.tsx, web/src/lib/events.ts, web/src/lib/route.test.tsx, web/src/lib/route.ts, web/src/lib/timeline.test.tsx, web/src/lib/timeline.ts, web/src/pages/HistoryPage.css, web/src/pages/HistoryPage.test.tsx, web/src/pages/HistoryPage.tsx, web/src/testing/chatFixtures.ts, web/src/types.ts
  - **Decided**:
    - Bubble.thumbWidth param type {width?,height?} → `object` with internal cast (TS weak-type check rejects ChatAttachment) (rung 1: invariant 1, typecheck green)
    - App.test.tsx answer-head button count 3 → 4 (new Chat in full screen button is intended by the plan; plan's Impact omitted this existing assertion) (rung 2: exit criteria / plan code blocks)
    - Completion bookkeeping: corrected the stale "(pending)" markers for P1-NOTES-A035 and P1-NOTES-A036 in this task's Depends on (both landed). Phase 8 (P1-NOTES-A041) is still open in this tree, so the plan index Status reads phases 1-7 and 9 complete.

- [x] **P1-NOTES-A040** Phase 7: Chat persistence: schema, context rebuild, reply_to, edit/delete API
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns migration 0006 (`chat_threads`, `chat_messages`, `chat_message_revisions`, `chat_message_attachments`); `ChatService` (create thread/messages, short ids, edit with revision, soft delete/restore, timeline, `recordExchange` for P8); context builder (history + reply targets, char budget, `[msg:ID]` labels, image placeholders); `composeWallTurn` extending P3's `compose.ts` (`ChatTurnImage.messageId?`, `[image upload:ID] from [msg:ID]`); leading-`[msg:ID]` citation parser → `reply_to`; backend contract change (`ChatRequest {turn, signal}`, no `resume`, `persistSession` off; preview bytes still read by P3's `readPreview`); `POST /api/chat` persists the user row first, sends `event: accepted {thread_id, user_message_id}`, the assistant row on success, `done {thread_id, user_message_id, assistant_message_id, reply_to, brain?}`; `GET /api/chat/messages` (`{messages, next_before}`, `include_deleted`), `GET /api/chat/threads/:id`, `PATCH`, `DELETE` (`{deleted: [ids]}`), `restore` (one id, idempotent); `event: chat {op: created|updated|deleted|restored, thread_id, id}` on `/api/events`; system prompt teaches `[msg:ID]`. Exit: a two-turn wall conversation survives a daemon restart and brain fallback with identical context; reply_to to a bubble in another thread is injected; edit keeps a revision; deleted messages leave context; integration tests with the scripted backend.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 7 of 11)
  - **Satisfies**: R3 — Chat history: own DB, own page, reply_to, edit/delete, note-id links, thumbnails, Claude Code capture, sidebar icon, full-screen button
  - **Depends on**: P1-NOTES-A036 (satisfied), P1-NOTES-A039 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A040.md`
  - **Completed**: 2026-10-31 10:24
  - **Method**: /do
  - **Files**: CHANGELOG.md, README.md, drizzle/0006_chat_history.sql, drizzle/meta/0006_snapshot.json, drizzle/meta/_journal.json, src/chat/agent.ts, src/chat/backend.ts, src/chat/citation.ts, src/chat/compose.ts, src/chat/context.ts, src/chat/events.ts, src/chat/ids.ts, src/chat/prompt.ts, src/chat/repo.ts, src/chat/service.ts, src/chat/stub.ts, src/chat/turn.ts, src/chat/types.ts, src/daemon.ts, src/db/schema.ts, src/deps.ts, src/http/api.ts, src/http/app.ts, src/http/chatApi.ts, tests/integration/api.int.test.ts, tests/integration/chat.api.int.test.ts, tests/integration/chat.images.int.test.ts, tests/integration/chat.service.int.test.ts, tests/integration/connectors/mcp.int.test.ts, tests/integration/daemon.int.test.ts, tests/integration/embeddings.worker.int.test.ts, tests/integration/helpers/api-harness.ts, tests/integration/helpers/scripted-chat.ts, tests/integration/imageHarness.ts, tests/integration/images.int.test.ts, tests/integration/mcp.tools.int.test.ts, tests/integration/related.int.test.ts, tests/integration/setup.ts, tests/live/chat.live.test.ts, tests/unit/chat-agent.test.ts, tests/unit/chat-citation.test.ts, tests/unit/chat-compose.test.ts, tests/unit/chat-context.test.ts, tests/unit/chat-ids.test.ts, tests/unit/chat-prompt.test.ts, tests/unit/chat-stub.test.ts
  - **Drift**:
    - schema.ts header comment quoted by the plan differed slightly (P6 sentence was joined); merged the 0006 sentence into the existing text.
    - api.ts chatSchema from P3 had image_ids optional; replaced with the plan's default([]).

- [x] **P1-NOTES-A038** Phase 5: Note files UI: paperclip, chips, paste/drop routing, reveal
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns paperclip button + hidden picker in `NoteEditor`; `FileChips` (name, size, type, download, per-file reveal, remove with 6 s undo); ctrl-v and drop of non-image files into the open modal attach to that note (images keep the image path); `NoteRevealButton` (card footer slot from P1 and editor top bar) calling the note-level route, visible by the same rule as the route; empty-note rules count files (`hasAttachments`); card paperclip count; `web/src/api.ts` file calls with `DuplicateFileError`; `makeNote` always sets `files: []` (the only phase that touches that fixture). Exit: component tests for picker, paste, drop, chips, undo, dedupe notice, reveal calls; a text-only note holding only files is not auto-deleted on close.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 5 of 11)
  - **Satisfies**: R2 — Note files: attach any file from the note modal, sha256 store, extraction-ready schema, agent visibility, per-file and note-level reveal
  - **Depends on**: P1-NOTES-A034 (satisfied), P1-NOTES-A035 (satisfied), P1-NOTES-A036 (satisfied), P1-NOTES-A037 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A038.md`
  - **Completed**: 2026-10-31 10:06
  - **Method**: /do
  - **Files**: .workflows/todos.md, .workflows/orchestration/chat-history-files-image-search/PLAN.md, CHANGELOG.md, README.md, web/src/App.test.tsx, web/src/App.tsx, web/src/api.ts, web/src/components/DropOverlay.test.tsx, web/src/components/DropOverlay.tsx, web/src/components/FileChips.css, web/src/components/FileChips.test.tsx, web/src/components/FileChips.tsx, web/src/components/NoteCard.test.tsx, web/src/components/NoteCard.tsx, web/src/components/NoteEditor.test.tsx, web/src/components/NoteEditor.tsx, web/src/components/NoteRevealButton.test.tsx, web/src/components/NoteRevealButton.tsx, web/src/components/RevealMounts.test.tsx, web/src/lib/files.test.tsx, web/src/lib/files.ts, web/src/styles.css, web/src/testing/fixtures.ts
  - **Drift**:
    - tests/integration/schema.int.test.ts 're-applying the migrations is a no-op' fails here (expects 6 applied rows vs journal 5): the shared test DB already holds a peer phase's migration 0005. Environmental, this phase changes no server/db code; all other test:int tests pass (340/342 on the last full run, the 2nd failure was a transient concurrent-run flake).
  - **Decided**:
    - Completion bookkeeping: P1-NOTES-A040 (phase 7, the plan's next task) stays blocked: it depends on P1-NOTES-A039 (phase 6), which is still pending in this tree, not on this phase. Only marked P1-NOTES-A038 satisfied in P1-NOTES-A042's Depends on.

- [x] **P1-NOTES-A039** Phase 6: Image embeddings and `similar_images`
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `ImageEmbedder` (Gemini Embedding 2 over OpenRouter, 1536 dims, PNG data URL, client-side truncate + renormalise guard) and its fake; migration 0005 `note_image_embeddings`; repo (pending, save, failure, nearest); worker + backfill reusing `RateLimiter`/`Clock`; `npm run embed:images:backfill` with `--dry-run`/`--limit`/`--retry-failed`; MCP `similar_images` (`image_id` | `upload_id` (resolved through P3's `locateChatImage`) | `query`, `limit`; `pasted_image` accepted and answered with a provisional "needs the notes-paste hook" error until P8); `startHarness({chat, imageEmbedder})`; chat allowlist, captions, prompt, instructions, `/n` skill; opt-in live test. Exit: worker embeds new images and skips images whose file is not on this machine without recording failures; nearest search excludes the source image and deleted notes; text query works through the same space; live probe test documents the verified request shape.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 6 of 11)
  - **Satisfies**: R5 — Image similarity search (Gemini Embedding 2 via OpenRouter, table, worker, backfill, `similar_images`, text→image)
  - **Depends on**: P1-NOTES-A036 (satisfied), P1-NOTES-A037 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A039.md`
  - **Completed**: 2026-10-31 10:05
  - **Method**: /do
  - **Files**: CHANGELOG.md, README.md, claude/skills/n/SKILL.md, drizzle/0005_note_image_embeddings.sql, drizzle/meta/0005_snapshot.json, drizzle/meta/_journal.json, package.json, src/background.ts, src/chat/prompt.ts, src/chat/status.ts, src/cli/embedImagesBackfill.ts, src/daemon.ts, src/db/schema.ts, src/deps.ts, src/embeddings/chatUploads.ts, src/embeddings/imageBackfill.ts, src/embeddings/imageConstants.ts, src/embeddings/imageEmbedder.ts, src/embeddings/imageInput.ts, src/embeddings/imageRepo.ts, src/embeddings/imageWorker.ts, src/embeddings/openrouter.ts, src/embeddings/openrouterImage.ts, src/http/app.ts, src/mcp/instructions.ts, src/mcp/server.ts, src/mcp/similarTools.ts, src/mcp/tools.ts, tests/helpers/fakeImageEmbedder.ts, tests/integration/connectors/mcp.int.test.ts, tests/integration/daemon.int.test.ts, tests/integration/embeddings.worker.int.test.ts, tests/integration/helpers/api-harness.ts, tests/integration/imageEmbeddings.repo.int.test.ts, tests/integration/imageEmbeddings.worker.int.test.ts, tests/integration/imageHarness.ts, tests/integration/images.int.test.ts, tests/integration/mcp.tools.int.test.ts, tests/integration/related.int.test.ts, tests/integration/setup.ts, tests/integration/similarImages.mcp.int.test.ts, tests/live/chat.live.test.ts, tests/live/imageEmbeddings.live.test.ts, tests/unit/chat-prompt.test.ts, tests/unit/chat-status.test.ts, tests/unit/embeddings/fakeImageEmbedder.test.ts, tests/unit/embeddings/imageBackfill.test.ts, tests/unit/embeddings/imageConstants.test.ts, tests/unit/embeddings/openrouterImage.test.ts, tests/unit/mcp.instructions.test.ts, tests/unit/similarTools.test.ts, vitest.config.ts
  - **Decided**:
    - Completion bookkeeping: unblocked P1-NOTES-A040 (phase 7; depends on phases 3 and 6, both satisfied). P1-NOTES-A041 (phase 8) stays blocked on phase 7.

- [x] **P1-NOTES-A037** Phase 4: Note files backend: schema, store, service, API, reveal, MCP visibility
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns migration 0004 `note_files` (extracted_text + extraction_status, no extraction); `files/<noteId>/<safeName>` store with sha256 dedupe (stored name sanitised; `NoteFile.name` is the display name); `NotesService.attachFile/removeFile/restoreFile`; `Note.files` on the wire (required server-side, optional `files?` in `web/src/types.ts`); `POST /api/notes/:id/files` (`{note, attached, kind}`), `DELETE /api/files/:id`, `POST /api/files/:id/restore` (409 `duplicate_file`), `GET /api/files/:id`, `GET /api/files/:id/download`; reveal routes (`POST /api/files/:id/reveal` selects the file, `POST /api/notes/:id/reveal` opens the note's files folder, or selects the first image when the note has no files, 404 when it has neither); `purgeNote` removes the files folder; MCP `describeNote`/note JSON expose name, size, type; instructions, chat prompt sentence and `/n` skill text. Exit: attach/remove/restore/purge covered by integration tests; same bytes in two notes → holder returned; download is `attachment` with `nosniff`; `get`/`list` MCP results include `files`; migration chain intact.
  - **Status**: completed
  - **Plan Set**: `.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 4 of 11)
  - **Satisfies**: R2 — Note files: attach any file from the note modal, sha256 store, extraction-ready schema, agent visibility, per-file and note-level reveal
  - **Depends on**: P1-NOTES-A036 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A037.md`
  - **Completed**: 2026-10-31 09:41
  - **Method**: /do
  - **Files**: .workflows/todos.md, .workflows/orchestration/chat-history-files-image-search/PLAN.md, CHANGELOG.md, README.md, claude/skills/n/SKILL.md, drizzle/0004_note_files.sql, drizzle/meta/0004_snapshot.json, drizzle/meta/_journal.json, src/chat/prompt.ts, src/daemon.ts, src/db/schema.ts, src/files/ingest.ts, src/files/mime.ts, src/files/name.ts, src/files/records.ts, src/files/store.ts, src/http/app.ts, src/http/files.ts, src/http/reveal.ts, src/mcp/imageTools.ts, src/mcp/instructions.ts, src/notes/fileRepo.ts, src/notes/imageRepo.ts, src/notes/service.ts, src/notes/types.ts, tests/helpers/fakeNotes.ts, tests/integration/daemon.int.test.ts, tests/integration/files.int.test.ts, tests/integration/files.mcp.int.test.ts, tests/integration/files.reveal.int.test.ts, tests/integration/imageHarness.ts, tests/integration/migration0004.int.test.ts, tests/integration/setup.ts, tests/unit/chat-prompt.test.ts, tests/unit/files.name.test.ts, tests/unit/files.store.test.ts, tests/unit/mcp.describe.test.ts, tests/unit/mcp.instructions.test.ts, tests/unit/notes.helpers.test.ts, tests/unit/reveal.test.ts, web/src/types.ts
  - **Drift**:
    - None of substance; two plan test bugs fixed (not relaxed): files.reveal.int.test.ts helper post() used a default param so passing undefined still sent an Origin header (now null = no header); files.int.test.ts used '/api/files/nope' as a malformed id but normalizeId('nope') is the valid id N-OPE (now 'not-an-id'). Also added 'files' to the DATA_SUBDIRS assertion in tests/integration/daemon.int.test.ts.
  - **Decided**:
    - Plan test used malformed id 'nope' which is a valid dash-less id -> use 'not-an-id' (rung 2: exit criteria / test intent is a malformed id -> 400)
    - Reveal test 'no Origin header' case never sent no header (default-param bug) -> null sentinel (rung 2)
    - Completion bookkeeping: unblocked both P1-NOTES-A038 (phase 5) and P1-NOTES-A039 (phase 6); every dependency of each is now satisfied (wave W3 = {5, 6}).

- [x] **P1-NOTES-A036** Phase 3: Chat image store, paste into the bar, wall chat sends images
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns migration 0003 chat_images, src/chat/images.ts + compose.ts, POST/GET /api/chat/images, image_ids on POST /api/chat, agent sends images as SDK content blocks, useChatImages, ChatBar paste handling, DropOverlay chatBarHasFocus guard, AnswerPanel thumbnails. Exit: paste into focused bar uploads + removable thumbnail; send posts image_ids; SDK receives image blocks named [image upload:ID]; paste elsewhere still makes a note; typecheck/unit/integration/build green.
  - **Status**: completed
  - **Plan Set**: `.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 3 of 11)
  - **Satisfies**: R1 — Paste an image into the chat query bar (wall chat and /n)
  - **Depends on**: none
  - **Plan**: `.workflows/plan/P1-NOTES-A036.md`
  - **Completed**: 2026-10-31 09:24
  - **Method**: /do
  - **Files**: .workflows/orchestration/chat-history-files-image-search/PLAN.md, .workflows/todos.md, .workflows/plan/P1-NOTES-A036.md, CHANGELOG.md, README.md, drizzle/0003_chat_images.sql, drizzle/meta/0003_snapshot.json, drizzle/meta/_journal.json, src/chat/agent.ts, src/chat/backend.ts, src/chat/compose.ts, src/chat/images.ts, src/daemon.ts, src/db/schema.ts, src/http/api.ts, src/http/app.ts, src/http/chatImages.ts, src/images/store.ts, tests/integration/chat.images.int.test.ts, tests/integration/daemon.int.test.ts, tests/integration/imageHarness.ts, tests/integration/migration0002.int.test.ts, tests/integration/schema.int.test.ts, tests/integration/setup.ts, tests/live/chat.live.test.ts, tests/unit/chat-agent.test.ts, tests/unit/chat-compose.test.ts, tests/unit/chat-images.test.ts, tests/unit/chat-stub.test.ts, tests/unit/images/store.test.ts, web/src/App.test.tsx, web/src/App.tsx, web/src/api.ts, web/src/components/AnswerPanel.test.tsx, web/src/components/AnswerPanel.tsx, web/src/components/ChatBar.css, web/src/components/ChatBar.test.tsx, web/src/components/ChatBar.tsx, web/src/components/DropOverlay.test.tsx, web/src/components/DropOverlay.tsx, web/src/hooks/useChat.test.tsx, web/src/hooks/useChat.ts, web/src/hooks/useChatImages.test.tsx, web/src/hooks/useChatImages.ts, web/src/types.ts
  - **Drift**:
    - Plan missed two integration tests that hard-code the migration count (tests/integration/schema.int.test.ts, migration0002.int.test.ts expected 3, now 4); changed both to derive the count from drizzle/meta/_journal.json so later migration phases need no edit.
    - Live test (tests/live/chat.live.test.ts image case) not run: opt-in and billed; plan's pre-merge check still pending.
  - **Decided**:
    - Create tasks for all 11 phases vs phase 3 only -> phase 3 only (sibling worktrees p1/p2 run concurrently and would conflict on todos.md; narrowest blast radius, rung 6/tie-break)
    - Migration-count assertions in two integration tests -> derive from journal length rather than hard-coding 4 (reversible, avoids per-phase churn; rung 3 exit criterion 'migration chain intact')
    - Wave-0 integration: the phase-3 session reported this task as P1-NOTES-A034, which phase 1's session had already minted for phase 1; renumbered to P1-NOTES-A036 (phase 1 minted A036 for phase 3), plan file is `.workflows/plan/P1-NOTES-A036.md` (phase 3's copy differed only in the Adopted-from header line).

- [x] **P1-NOTES-A035** Phase 2: Shared Lightbox + note modal strip
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns a standalone `Lightbox` component (`LightboxItem {id, src, label?, width?, height?, film?}`, `isLightboxOpen()` Esc seam, prev/next buttons and ArrowLeft/ArrowRight, Esc closes only itself, no wrap at ends), its CSS and tests; wiring it into the note editor's thumbnail strip (`.ed-open` buttons, the editor's Esc listener yields while a lightbox is open). Exit: clicking a strip thumbnail opens the lightbox on it; arrows/keys move between the note's available images without closing; Esc closes the lightbox but not the editor; component accepts a generic item list so chat can reuse it.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 2 of 11)
  - **Satisfies**: R4 — One shared image lightbox (chat + note modal strip)
  - **Depends on**: none
  - **Plan**: `.workflows/plan/P1-NOTES-A035.md`
  - **Completed**: 2026-10-31 09:20 (recorded under P2-NOTES-H202 by the phase-2 session; merged in wave-0 integration)
  - **Done as**: P2-NOTES-H202 (see that entry for Files, Decided, Verified)

- [x] **P1-NOTES-A034** Phase 1: Card footer: reveal button left
  - **Difficulty**: EASY
  - **Type**: Feature
  - **Context**: Owns moving the card-footer "Show in Explorer" button so it sits immediately after the copy-ID button, left side; tests (`footerSequence` order tests in `NoteCard.test.tsx`, a position check in `RevealMounts.test.tsx`). Exit: footer order is id, copy, reveal, (copied label), date-right; `.copied` label no longer pushes the reveal button; existing `NoteCard`/`RevealButton` tests updated and a new test asserts DOM order.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 1 of 11)
  - **Satisfies**: R6 — "Show in explorer" aligned left in the note card footer
  - **Depends on**: none
  - **Plan**: `.workflows/plan/P1-NOTES-A034.md`
  - **Completed**: 2026-10-31 09:22
  - **Method**: /do
  - **Files**: CHANGELOG.md, web/src/components/NoteCard.tsx, web/src/components/NoteCard.test.tsx, web/src/components/RevealMounts.test.tsx
  - **Drift**: plan's test used an unused `container` destructure in the 'keeps the reveal button in place' case; removed to satisfy tsc noUnusedLocals.
  - **Decided**: test:int skipped -> coordinator instructed commit+DONE (shared test DB truncated concurrently by wave-0 phases: deadlocks/FK/404s; phase touches web/ only) (rung 2, exit criteria; coordinator re-runs full suite after wave merge)
  - **Verified**: typecheck, build, npm test (852 pass), targeted vitest files; test:int not run to green (shared-DB contention)

- [x] **P2-NOTES-H202** Phase 2: Shared Lightbox + note modal strip
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns a standalone `Lightbox` component (`LightboxItem {id, src, label?, width?, height?, film?}`, `isLightboxOpen()` Esc seam, prev/next buttons and ArrowLeft/ArrowRight, Esc closes only itself, no wrap at ends), its CSS and tests; wiring it into the note editor's thumbnail strip (`.ed-open` buttons, the editor's Esc listener yields while a lightbox is open). Not `PhotoModal`/`Gallery`, chat UI (P9 consumes it), file chips. Exit: clicking a strip thumbnail opens the lightbox on it; arrows/keys move between the note's available images without closing; Esc closes the lightbox but not the editor; generic item list so chat can reuse it.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search-p2/.workflows/orchestration/chat-history-files-image-search/PLAN.md` (phase 2 of 11)
  - **Satisfies**: R4 — One shared image lightbox (chat + note modal strip)
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P2-NOTES-H202.md`
  - **Completed**: 2026-10-31 09:20
  - **Method**: /do
  - **Files**: web/src/components/Lightbox.tsx, web/src/components/Lightbox.css, web/src/components/Lightbox.test.tsx, web/src/components/NoteEditor.tsx, web/src/components/NoteEditor.css, web/src/components/NoteEditor.test.tsx, README.md, CHANGELOG.md, .workflows/todos.md, .workflows/plan/P2-NOTES-H202.md, .workflows/orchestration/chat-history-files-image-search/PLAN.md
  - **Decided**:
    - Task bookkeeping in a per-phase-worktree swarm → mint only phase 2's task, as P2-NOTES-H202 (non-sequential ID: phase 3's worktree already minted P1-NOTES-A034 from the shared counter, so the next sequential ID would collide with a peer), in root .workflows/todos.md (same convention as P2-NOTES-C506)
    - test:int failed with Postgres deadlocks (40P01), FK violations and 404s from peer phase sessions running concurrent truncateAll against one shared test DB → treated as environmental; this phase changes no src/ or tests/ server code (verified: typecheck, build, npm test 874 passed)
    - Same task as P1-NOTES-A035 (phase 2); the phase-2 session minted P2-NOTES-H202 instead. Both entries kept; P1-NOTES-A035 is marked completed by this entry (wave-0 integration).

- [x] **P1-NOTES-A032** Phase 10: Docs, Neon migration 0002, full verification
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `README.md` (photos, gallery, modal, editor, bin, reveal, answer panel, chat bar, API/storage/MCP tables), `claude/skills/n/SKILL.md`, `docs/INSTALL.md` (0002 migrate step), `npm run db:migrate` against Neon with before/after verification, `npm run build`; no source changes (defects fixed in the owning phase). Exit: full suite + build green; Neon `note_images` has one row per legacy image (matches `notes where image_path is not null`, minus listed late ingests) with identical metadata; installed daemon untouched.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 10 of 11)
  - **Satisfies**: R5, R1 — Unit/component + integration tests for all of the above; README photo/gallery/modal text updated; Several images per note: per-image table, lossless migration, per-image dedupe, wire `images[]`, HTTP + MCP attach and soft remove of one image
  - **Depends on**: P1-NOTES-A031 (satisfied), P1-NOTES-A033 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A032.md`
  - **Completed**: 2026-10-30 17:14
  - **Method**: /do
  - **Files**: README.md, claude/skills/n/SKILL.md, docs/INSTALL.md
  - **Drift**: README line numbers had shifted a few lines from the plan's; every edit was anchored on its exact quoted old text instead, and each anchor matched exactly once.
    Step 1f: the 'Open file location' and undo paragraphs were re-wrapped to ~100 columns (the plan's text had two over-long lines); wording unchanged.
    .env.local symlink already existed (created by phase 1), so Step 6 was a no-op; integration setup refuses Neon URLs, so the suites were unaffected.

- [x] **P1-NOTES-A031** Phase 9: Web reveal button + capabilities
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `web/src/hooks/useCapabilities.ts`, `web/src/components/RevealButton.tsx` (+ tests, new), `api.ts` (`Capabilities`, `fetchCapabilities`, `revealImage`), mount points in `NoteCard`, `PhotoModal`, `NoteEditor` (`.ed-reveal` rule in `NoteEditor.css`), `RevealMounts.test.tsx`; not server/`App.tsx`/`Gallery.tsx`/`styles.css`. Exit: visibility rules tested (caps false -> none; unavailable image -> none; both true -> icon, click POSTs); icon in card meta, modal toolbar and editor strip.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 9 of 11)
  - **Satisfies**: R4, R5 — Folder icon on photos runs `explorer.exe /select,<wslpath -w>` via notesd; own-Origin only; only when local + WSL interop; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A027 (satisfied), P1-NOTES-A030 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A031.md`
  - **Completed**: 2026-10-30 17:07
  - **Method**: /do
  - **Files**: web/src/api.ts, web/src/components/NoteCard.tsx, web/src/components/NoteEditor.css, web/src/components/NoteEditor.tsx, web/src/components/PhotoModal.tsx, web/src/components/RevealButton.tsx, web/src/components/RevealButton.test.tsx, web/src/components/RevealMounts.test.tsx, web/src/hooks/useCapabilities.ts, web/src/hooks/useCapabilities.test.tsx
  - **Drift**: RevealMounts.test.tsx: NoteCardProps now requires onExpand (phase 7); added onExpand: vi.fn() to the card props literal so the `as NoteCardProps` cast typechecks (plan Step 9 anticipated adding required props).
    No existing test needed a resetCapabilitiesForTests prime; no fetch-count assertion broke.
  - **Verified**: typecheck, npm test (766 tests), build:web, test:int (294 tests)

- [x] **P1-NOTES-A030** Phase 8: Web delete, undo, recycle bin view
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `web/src/components/{Bin,UndoBar}.{tsx,css}` (new), `web/src/hooks/{useUndo,useBin}.ts` (new), `{NoteCard,NoteEditor,PhotoModal,Gallery,Rail,Sidebar,Header,Wall}.tsx`, `App.tsx` (`view`, `removeNote`, `removeImageWithUndo`, `onRestored`, `toggleBin`), `api.ts` bin/restore/purge calls, `types.ts` (`Bin`, `BinImage`, `View`), `filter.ts` (`BIN_HEADING`, `binCountLine`), tests. Exit: R3 acceptance steps pass in component tests; undo label sits above the chat bar right end without overlapping the answer panel.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 8 of 11)
  - **Satisfies**: R3, R5 — Delete icon on card/editor/modal with quiet undo; "Deleted." bin view with restore and inline-confirmed delete forever; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A026 (satisfied), P1-NOTES-A029 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A030.md`
  - **Completed**: 2026-10-30 18:10
  - **Method**: /do
  - **Files**: web/src/App.tsx, web/src/api.ts, web/src/types.ts, web/src/lib/filter.ts, web/src/components/Gallery.tsx, web/src/components/Header.tsx, web/src/components/NoteCard.tsx, web/src/components/NoteCard.test.tsx, web/src/components/NoteEditor.tsx, web/src/components/NoteEditor.test.tsx, web/src/components/PhotoModal.tsx, web/src/components/Rail.tsx, web/src/components/Sidebar.tsx, web/src/components/Wall.tsx, web/src/App.bin.test.tsx, web/src/components/Bin.tsx, web/src/components/Bin.css, web/src/components/Bin.test.tsx, web/src/components/PhotoModal.delete.test.tsx, web/src/components/UndoBar.tsx, web/src/components/UndoBar.css, web/src/components/UndoBar.test.tsx, web/src/hooks/useBin.ts, web/src/hooks/useUndo.ts, web/src/lib/binFilter.test.tsx
  - **Drift**: None against the plan; tree matched the post-phase-7 state and code blocks were applied verbatim. NoteEditor's onRemoveImage doc comment now reads 'App offers a 6 s undo' (was 'phase 8 adds undo'). Phase 7's removeImg was deleted and replaced by removeImageWithUndo.
  - **Delivered**: Trash icon ('Delete note') on wall cards, editor toolbar and photo modal; soft delete, no confirm, 6 s UndoBar above the chat bar's right end (also covers editor-strip image remove). Rail + sidebar Trash toggle the "Deleted." bin (Bin + useBin): image grid on top, deleted-note cards below, restore, inline-confirmed delete forever (Check/X). Tag filters apply in the bin; sidebar counts stay live-only. API: fetchBin, restoreNote, restoreImage, purgeNote, purgeImage, DuplicateImageError.
  - **Verified**: typecheck, build:web, npm test (67 files, 752 tests), test:int (24 files, 294 tests)

- [x] **P1-NOTES-A026** Phase 4: Bin listing, note restore endpoint, purge (rows + files)
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/notes/{types,events}.ts` (`Bin`, `BinImage`, `PurgeResult`, `purged` op), `src/notes/binRepo.ts` (new), service `listBin`/`purgeNote`/`purgeImage`, `src/images/store.ts` (`removeImageFiles`), `src/http/api.ts` (bin, restore, purge routes), bin int test, `removeImageFiles` and worker unit tests; no MCP purge tool. Exit: contract routes pass; purge leaves other files in `images/` and `cache/` untouched; live items 409 `not_deleted`; missing/foreign/`null` Origin 403.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 4 of 11)
  - **Satisfies**: R3, R5 — Delete icon on card/editor/modal with quiet undo; "Deleted." bin view with restore and inline-confirmed delete forever; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A025 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A026.md`
  - **Completed**: 2026-10-30 17:30
  - **Method**: /do
  - **Files**: src/notes/types.ts, src/notes/events.ts, src/notes/binRepo.ts, src/notes/service.ts, src/images/store.ts, src/http/api.ts, tests/integration/bin.int.test.ts, tests/unit/images/removeImageFiles.test.ts, tests/unit/embeddings/worker.test.ts
  - **Drift**: toBinImage placed directly after roundSimilarity (service.ts now has more helpers after it); otherwise code applied verbatim.
    bin.int.test.ts: purge() helper made async (plan's sync version failed typecheck: app.request returns Response | Promise<Response>).
  - **Decided**: bin.int.test 'nope' used as a non-id → replaced with 'not-an-id' ('nope' normalizes to the valid id N-OPE, so 404 is correct; the 400 assertion is unchanged) (rung 6: ids.ts convention; restore test already uses 'not-an-id')


- [x] **P1-NOTES-A029** Phase 7: Web big editor modal + attach on drop/paste
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `web/src/components/NoteEditor.{tsx,css,test.tsx}` (new), `web/src/hooks/useNotice.ts` (new), `web/src/components/{NoteCard,Wall,DropOverlay}.tsx` + tests, `web/src/App.tsx` (editor state, save/commit/expand/close, attach, portal), `web/src/api.ts` (`attachImage`, `removeImage`), `filter.ts` `visibleOnWall`, `App.test.tsx` describe block; not `styles.css`. Exit: each R2 bullet covered by a component test; card expand icon labelled `Expand note`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 7 of 11)
  - **Satisfies**: R2, R5 — Big editor modal from an expand icon on every card; save on blur/close; Esc; drop/paste attaches to the edited note; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A025 (satisfied), P1-NOTES-A028 (satisfied)
  - **Plan**: `.workflows/plan/P1-NOTES-A029.md`
  - **Completed**: 2026-10-30 16:52
  - **Method**: /do
  - **Commit**: 448e11f
  - **Files**: web/src/App.test.tsx, web/src/App.tsx, web/src/api.ts, web/src/components/DropOverlay.test.tsx, web/src/components/DropOverlay.tsx, web/src/components/NoteCard.test.tsx, web/src/components/NoteCard.tsx, web/src/components/Wall.tsx, web/src/lib/filter.test.tsx, web/src/lib/filter.ts, web/src/components/NoteEditor.css, web/src/components/NoteEditor.test.tsx, web/src/components/NoteEditor.tsx, web/src/hooks/useNotice.ts
  - **Drift**: filter.test.tsx has no note(id, body, {image}) helper; the keep-list test uses makeNote(..., { images: ['F-FFF'] })
  - **Decided**: App.test '+ then expand' used getByLabelText('New note') but Rail and Header both carry that label → getAllByLabelText('New note')[0]! (both call the same addNote) (rung 2: exit criteria — every R2 bullet has a passing test; selector fix, no assertion relaxed)

- [x] **P1-NOTES-A025** Phase 3: Attach / remove / restore one image: service, ingest, HTTP, MCP tools
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `DuplicateImageError`, `touchNote`, service `attachImage`/`removeImage`/`restoreImage`/`requireImageId`/`lockImage`, ingest `attachImage`, `src/http/imageAccess.ts` attach helpers, `src/http/images.ts` (`POST /api/notes/:id/images`, `DELETE /api/images/:id`, `POST /api/images/:id/restore`), MCP `attach_image`/`remove_image`/`restore_image`, instructions `Attaching.` paragraph, `src/chat/status.ts`, attach int test. Exit: three routes and three tools work as contracted; dedupe returns the holder (restoring a deleted one); restore keeps position; restore clash answers 409 `duplicate_image`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 3 of 11)
  - **Satisfies**: R1, R5 — Several images per note: per-image table, lossless migration, per-image dedupe, wire `images[]`, HTTP + MCP attach and soft remove of one image; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A024
  - **Plan**: `.workflows/plan/P1-NOTES-A025.md`
  - **Completed**: 2026-10-30 16:41
  - **Method**: /do
  - **Files**: src/notes/types.ts, src/notes/repo.ts, src/notes/service.ts, src/images/ingest.ts, src/http/imageAccess.ts, src/http/images.ts, src/mcp/imageTools.ts, src/mcp/instructions.ts, src/chat/status.ts, tests/unit/chat-status.test.ts, tests/unit/mcp.instructions.test.ts, tests/integration/images.attach.int.test.ts
  - **Drift**: none — every anchor the plan named was where it said; images.ts route doc comment gained two lines listing the new routes

- [x] **P1-NOTES-A027** Phase 5: Reveal in Explorer: capabilities + reveal endpoint
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/http/reveal.ts` (new), `src/http/app.ts` (mount + `CreateAppOptions.reveal`), `tests/unit/reveal.test.ts`, `tests/integration/reveal.int.test.ts`. Exit: capabilities reports `reveal: false` off WSL; reveal route answers 202 on spawn without awaiting Explorer; command line is exactly `[explorer, ['/select,' + wslpath -w original]]`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 5 of 11)
  - **Satisfies**: R4, R5 — Folder icon on photos runs `explorer.exe /select,<wslpath -w>` via notesd; own-Origin only; only when local + WSL interop; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A024
  - **Plan**: `.workflows/plan/P1-NOTES-A027.md`
  - **Completed**: 2026-10-30 16:45
  - **Method**: /implement
  - **Files**: src/http/reveal.ts, src/http/app.ts, tests/unit/reveal.test.ts, tests/integration/reveal.int.test.ts
  - **Drift**: none — app.ts hunks placed by anchor text as planned; locateImage/sameOriginOnly/normalizeId/imageHarness matched phase 2's tree

- [x] **P1-NOTES-A028** Phase 6: Web on `images[]`: cards, gallery, modal stepping, full-screen by image
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `web/src/types.ts`, `web/src/api.ts` (URLs by image id), `web/src/components/{NoteImage,NoteCard,Gallery,PhotoModal}.tsx`, `web/src/fullscreen/FullscreenApp.tsx`, `web/src/lib/filter.ts` (`hasImages`, `imageCount`, `photosOf`), `web/src/App.tsx` (photo count, empty rule, `<Gallery items>`), `styles.css` (`.card-cover`, `.card-count`), `web/src/testing/fixtures.ts` (new) and tests. Exit: wall cover + count, gallery tile per image, modal steps image by image then across notes with `k/n`, full-screen by image id; grep gates empty.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 6 of 11)
  - **Satisfies**: R1, R5 — Several images per note: per-image table, lossless migration, per-image dedupe, wire `images[]`, HTTP + MCP attach and soft remove of one image; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A024
  - **Plan**: `.workflows/plan/P1-NOTES-A028.md`
  - **Completed**: 2026-10-30 16:39
  - **Method**: /do
  - **Files**: web/src/types.ts, web/src/api.ts, web/src/App.tsx, web/src/App.test.tsx, web/src/styles.css, web/src/components/NoteImage.tsx, web/src/components/NoteImage.test.tsx, web/src/components/NoteCard.tsx, web/src/components/NoteCard.test.tsx, web/src/components/Gallery.tsx, web/src/components/Gallery.test.tsx, web/src/components/PhotoModal.tsx, web/src/components/PhotoModal.test.tsx, web/src/components/DropOverlay.test.tsx, web/src/fullscreen/FullscreenApp.tsx, web/src/fullscreen/FullscreenApp.test.tsx, web/src/lib/filter.ts, web/src/lib/filter.test.tsx, web/src/testing/fixtures.ts
  - **Drift**: none — every quoted hunk matched the tree (phase 11 already landed; App.tsx hunks applied by content)
  - **Decided**: Grep gate 1 (`\.image\b`) also matches PhotoItem.image (`it.image`) that the phase's own code blocks introduce → gate judged by its intent, narrowed to `(note|n)\.image\b`, which is empty (rung 3: phase code blocks)

- [x] **P1-NOTES-A024** Phase 2: Cut the server over to per-image: wire `images[]`, filters, ingest, image-id routes, `view_images`, same-origin guard, startup reconcile
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/notes/{types,repo,service}.ts` (wire `images`, batch image load on every read path, EXISTS filters), `src/images/{records,ingest}.ts`, `src/http/{imageAccess,images}.ts` (image-id routes + note alias), `src/http/sameOrigin.ts` (new), `src/mcp/{imageTools,tools,instructions}.ts`, `src/chat/prompt.ts`, `src/background.ts` (startup reconcile), `tests/helpers/fakeNotes.ts` and every server test reading `image`. Exit: no server code reads `image_path`/`image_meta` outside `legacy.ts`; every read path returns `images[]`; filters are any-live-image; `view_images` returns all images capped at 8; legacy and new image routes both serve incl. a reconciled row; `sameOriginOnly` 403s missing/foreign/`null` Origin.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 2 of 11)
  - **Satisfies**: R1, R5 — Several images per note: per-image table, lossless migration, per-image dedupe, wire `images[]`, HTTP + MCP attach and soft remove of one image; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: P1-NOTES-A023
  - **Plan**: `.workflows/plan/P1-NOTES-A024.md`
  - **Completed**: 2026-10-30 16:31
  - **Method**: /do
  - **Files**: src/background.ts, src/chat/prompt.ts, src/http/app.ts, src/http/imageAccess.ts, src/http/images.ts, src/http/sameOrigin.ts, src/images/derive.ts, src/images/ingest.ts, src/images/records.ts, src/images/store.ts, src/mcp/imageTools.ts, src/mcp/instructions.ts, src/mcp/tools.ts, src/notes/repo.ts, src/notes/service.ts, src/notes/types.ts, tests/helpers/fakeNotes.ts, tests/integration/api.int.test.ts, tests/integration/helpers/api-harness.ts, tests/integration/imageHarness.ts, tests/integration/images.http.int.test.ts, tests/integration/images.int.test.ts, tests/integration/images.mcp.int.test.ts, tests/integration/notes.service.int.test.ts, tests/unit/images/inbox.test.ts, tests/unit/images/ingest.test.ts, tests/unit/notes.helpers.test.ts, tests/unit/sameOrigin.test.ts, tests/unit/takenFilter.test.ts

- [x] **P1-NOTES-A023** Phase 1: `note_images` table, migration 0002, legacy copy/reconcile, image repo
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/db/schema.ts` (`noteImages`, legacy columns kept), `drizzle/0002_note_images.sql` + snapshot/journal, `src/notes/imageRepo.ts` (new), `src/images/legacy.ts` (new; `LEGACY_COPY_SQL`, `reconcileLegacyImages`), integration setup/schema tests, new `migration0002`/`imageRepo` int tests; no consumer reads the new table yet. Exit: migration applies on Docker DB; every legacy image (live, deleted, both sha-clash shapes) gets exactly one row with identical metadata, files untouched; reconcile idempotent, picks up late legacy ingests, bins a late clash; other tests green.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 1 of 11)
  - **Satisfies**: R1, R5 — Several images per note: per-image table, lossless migration, per-image dedupe, wire `images[]`, HTTP + MCP attach and soft remove of one image; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P1-NOTES-A023.md`
  - **Completed**: 2026-10-30 16:23
  - **Method**: /do
  - **Files**: src/db/schema.ts, src/images/legacy.ts, src/notes/imageRepo.ts, drizzle/0002_note_images.sql, drizzle/meta/0002_snapshot.json, drizzle/meta/_journal.json, tests/integration/setup.ts, tests/integration/schema.int.test.ts, tests/integration/migration0002.int.test.ts, tests/integration/imageRepo.int.test.ts

- [x] **P1-NOTES-A033** Phase 11: Collapsible answer panel + multi-line chat bar
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `web/src/components/{AnswerPanel,ChatBar}.tsx`, `ChatBar.css` (new), `web/src/hooks/useChat.ts`, `web/src/lib/oneLine.ts` (new), `.answer*`/`.chatbar*`/`.sendbtn` rules in `styles.css`, the `<AnswerPanel>` JSX in `App.tsx` (two new props), `App.test.tsx:125` (button count 2 -> 3), tests (`AnswerPanel`, `ChatBar`, `useChat`, `oneLine`). Exit: R6 and R7 bullets each covered by a component test; panel left-anchored and <= 680px wide; `--chatbar-h` published on `document.documentElement`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` (phase 11 of 11)
  - **Satisfies**: R6, R7, R5 — Collapsible answer panel: caret beside pin/dismiss; collapsed = header line only; streaming continues collapsed; Multi-line chat bar: textarea, Enter sends, Shift+Enter newline, IME-safe; grows to ~6 lines; newlines reach /api/chat; Unit/component + integration tests for all of the above; README photo/gallery/modal text updated
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P1-NOTES-A033.md`
  - **Completed**: 2026-10-30 16:23
  - **Method**: /do
  - **Files**: web/src/lib/oneLine.ts, web/src/lib/oneLine.test.tsx, web/src/hooks/useChat.ts, web/src/hooks/useChat.test.tsx, web/src/components/AnswerPanel.tsx, web/src/components/AnswerPanel.test.tsx, web/src/components/ChatBar.tsx, web/src/components/ChatBar.css, web/src/components/ChatBar.test.tsx, web/src/styles.css, web/src/App.tsx, web/src/App.test.tsx
  - **Decided**: Step 3 task creation → skipped; phase 1's concurrent session had already minted P1-NOTES-A023..A033 and adopted every plan (command's re-run rule)

- [x] **P1-NOTES-A022** Phase 6: Live test, docs, Neon migration + first backfill
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `tests/live/embeddings.live.test.ts`, `vitest.config.ts`, `package.json` (`test:live:embeddings`), README (all but phase 1's sentence), `docs/INSTALL.md`, `claude/skills/n/SKILL.md`; `docs/ROADMAP.md` checked, no change; may retune `src/search/blend.ts` constants if the live run demands it; runs `npm run db:migrate` against Neon and `npm run embed:backfill`. Exit: live test passes once against OpenRouter (one request) with both usage examples ranked first by raw similarity and through the blend; Neon has `vector` 0.8.6, `note_embeddings` and its HNSW index; backfill ends with `done: … 0 pending` and the independent query agrees.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 6 of 6)
  - **Satisfies**: R6 — Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A019, P1-NOTES-A020, P1-NOTES-A021
  - **Plan**: `.workflows/plan/P1-NOTES-A022.md`
  - **Completed**: 2026-10-30 15:28
  - **Method**: /do
  - **Files**: tests/live/embeddings.live.test.ts, vitest.config.ts, package.json, src/search/blend.ts, README.md, docs/INSTALL.md, claude/skills/n/SKILL.md
  - **Drift**:
    - None in code. main gained web/src/styles.css (079c284) after the branch point; the branch itself changes nothing under web/.
  - **Decided**:
    - Headline acceptance: rank 1 vs 'must come back' → 'must come back': each example has raw cosine >= BLEND.minSimilarity, raw rank <= 5, and is on the default hybrid page (MCP_DEFAULT_LIMIT=50) (coordinator, rungs 1 and 4: brief's Why)
    - Literal hit vs closer meaning-only note → phase 4 invariant stands, literal text hit ranks first; textFloor, fixture, phase 4 tests untouched (coordinator, rungs 1 and 4)
    - BLEND.minSimilarity 0.3 → 0.22: real-model labelled positive seer-incident scored 0.240 and was dropped; live blend MRR 0.708 → 0.733; phase 4 unit+int tests still green (plan Step 8 retune allowance)
    - Live test has no database: 'hybrid search page' is checked as the in-memory rankCandidates ranking over real vectors, truncated to MCP_DEFAULT_LIMIT (rung 3: plan says the live test needs no Docker/DB)


- [x] **P1-NOTES-A021** Phase 5: `related` tool
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `nearestNotes` in `src/embeddings/repo.ts`, `NotesService.related` / `embedNow`, `src/notes/types.ts` (`RelatedNote`, `RelatedResult`, `not_embedded`), the `related` tool in `src/mcp/tools.ts`, the `Related.` element in `src/mcp/instructions.ts`, one `it` in `tests/unit/mcp.instructions.test.ts`, `src/chat/status.ts` + `tests/unit/chat-status.test.ts`, `tests/integration/related.int.test.ts`. Exit: related never returns the note itself or a deleted note; ignores stale and other-model vectors; embeds an unembedded source once on demand; `not_embedded` without an embedder or on embed failure; textless photo → `invalid_input`; chat allow list is 14 + 15 + 2.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 5 of 6)
  - **Satisfies**: R5, R6 — `related` MCP tool: nearest notes by meaning with similarity, excluding the note itself; no UI change; Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A017, P1-NOTES-A018, P1-NOTES-A020
  - **Plan**: `.workflows/plan/P1-NOTES-A021.md`
  - **Completed**: 2026-10-30
  - **Method**: /implement
  - **Files**: src/embeddings/repo.ts, src/notes/types.ts, src/notes/service.ts, src/mcp/tools.ts, src/mcp/instructions.ts, src/chat/status.ts, tests/unit/chat-status.test.ts, tests/unit/mcp.instructions.test.ts, tests/integration/related.int.test.ts
  - **Drift**:
    - Only line-number drift (service.ts tags() at :257, tools.ts tags registration at :280-290); all quoted anchors matched as text.
  - **Decided**:
    - Which plan index to tick: -f pointed at the untracked copy .workflows/orchestration/semantic-search/PLAN.md, while the tracked canonical index is docs/plans/SEMANTIC_SEARCH_PLAN.md → tick both; commit only the tracked one (rung 6: repo convention, earlier phases ticked docs/plans)
    - Coordinator asked to also tick phase 3's row in docs/plans/SEMANTIC_SEARCH_PLAN.md (phase 3's handler missed it; todos.md already shows P1-NOTES-A019 completed) → done as bookkeeping


- [x] **P1-NOTES-A020** Phase 4: Hybrid search + labelled set
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/search/{blend,queryVector}.ts`, `src/notes/repo.ts` (`searchCandidates`), `src/notes/service.ts` (`search`, `textSearch`, imports), `src/notes/types.ts` (`SearchMode`, `SearchPage`), `src/mcp/tools.ts` (`search` only), `src/mcp/instructions.ts` (`Reading.` paragraph), one `it` in `tests/unit/mcp.instructions.test.ts`, `tests/fixtures/semantic/labelled.ts`, unit + integration tests. Exit: hybrid beats text-only on the labelled set (stated metric); exact id and rare code token at rank 1; failing query embed → `mode: 'text'` + `fallback`; `mode: 'text'` matches today's ordering.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 4 of 6)
  - **Satisfies**: R4, R6 — Hybrid `search`: text + vector + tags + recency, filters before ranking, ids/code tokens still first, fallback to text that says so, weights in one commented place tuned on a labelled set, optional `mode`, description + instructions updated, caption unchanged; Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A017, P1-NOTES-A018
  - **Plan**: `.workflows/plan/P1-NOTES-A020.md`
  - **Completed**: 2026-10-30 15:05
  - **Method**: /do
  - **Files**: src/search/blend.ts, src/search/queryVector.ts, src/notes/repo.ts, src/notes/service.ts, src/notes/types.ts, src/mcp/tools.ts, src/mcp/instructions.ts, tests/unit/mcp.instructions.test.ts, tests/fixtures/semantic/labelled.ts, tests/unit/search.blend.test.ts, tests/unit/search.queryVector.test.ts, tests/integration/search.hybrid.int.test.ts
  - **Decided**:
    - search.hybrid.int.test.ts built one module-level NotesService, so its query-vector LRU served cached vectors across tests and the fallback (failNext, timeout) and paging (calls === 1) tests failed → rebuild the service in beforeEach; no assertion changed (rung 2: exit criteria 'failing/slow embedder returns mode text' and 'paging embeds once' are what the tests check; the cache leak was test isolation, not product behaviour)

- [x] **P1-NOTES-A019** Phase 3: Embedding worker, background backfill, `embed:backfill`
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/embeddings/{worker,backfill}.ts`, `src/background.ts`, `src/cli/embedBackfill.ts`, `package.json` (`embed:backfill`), `tests/helpers/memoryEmbeddingStore.ts`, worker / backfill / CLI unit tests, integration tests (create/update/append/revert/image note embedded; failure keeps the write and retries; backfill resumable; deleted notes keep vectors; restore makes no call). Exit: with the fake embedder every write path ends with a current vector after `idle()`; a failing embedder leaves writes intact and the note retried after backoff; stop/restart mid-backfill finishes without re-embedding finished notes; idle worker logs nothing; `close()` returns within its 5 s grace even when a call hangs.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 3 of 6)
  - **Satisfies**: R3, R1, R6 — Background backfill inside notesd (batched, rate-limited, resumable, logged, quiet when idle) + `npm run embed:backfill` with progress; Embeddings via OpenRouter (`openai/text-embedding-3-small`, 1536), run-insights' cap and error handling; embedded after every body write without blocking/failing it; failures marked and retried; vector tied to its body hash; textless photos have none; deleted notes keep vectors, never appear; Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A017, P1-NOTES-A018
  - **Plan**: `.workflows/plan/P1-NOTES-A019.md`
  - **Completed**: 2026-10-30 14:50
  - **Method**: /do
  - **Files**: package.json, src/background.ts, src/cli/embedBackfill.ts, src/embeddings/backfill.ts, src/embeddings/worker.ts, tests/helpers/memoryEmbeddingStore.ts, tests/unit/embeddings/backfill.test.ts, tests/unit/embeddings/worker.test.ts, tests/unit/embeddings/embedBackfillCli.test.ts, tests/integration/embeddings.worker.int.test.ts
  - **Drift**:
    - RateLimiter.acquire: the plan's second `signal?.aborted === true` check failed tsc (TS2367: narrowed to false across the await). Same logic, now read through a local `aborted()` function, with one comment line explaining why.
    - Manual check: without .env.local the CLI exits 1 on DATABASE_URL (loadConfig runs first) before it reaches the key check. With DATABASE_URL set and no key, it prints 'OPENROUTER_API_KEY is not set' and exits 1, as planned.

- [x] **P1-NOTES-A018** Phase 2: OpenRouter embedder, config, deps wiring, fake embedder
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/embeddings/{embedder,openrouter}.ts`, `src/config.ts` (`embeddings`), `src/deps.ts`, `src/daemon.ts` (build embedder, `StartDaemonOptions.embedder`), `src/notes/service.ts` (constructor deps only), every existing test `Config` / `AppDeps` literal (6 integration files) and `tests/live/chat.live.test.ts` (`embedder: null`), `tests/helpers/fakeEmbedder.ts`, unit tests (fake fetch, config, fake embedder). Exit: every error path of run-insights' module has a unit test against a fake `fetch`; batching preserves order; the daemon starts with no key (`deps.embedder === null`) and with an injected fake.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 2 of 6)
  - **Satisfies**: R1, R6 — Embeddings via OpenRouter (`openai/text-embedding-3-small`, 1536), run-insights' cap and error handling; embedded after every body write without blocking/failing it; failures marked and retried; vector tied to its body hash; textless photos have none; deleted notes keep vectors, never appear; Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A017
  - **Plan**: `.workflows/plan/P1-NOTES-A018.md`
  - **Completed**: 2026-10-30 14:44
  - **Method**: /do
  - **Files**: src/embeddings/embedder.ts, src/embeddings/openrouter.ts, src/config.ts, src/deps.ts, src/daemon.ts, src/notes/service.ts, tests/helpers/fakeEmbedder.ts, tests/unit/embeddings/openrouter.test.ts, tests/unit/embeddings/fakeEmbedder.test.ts, tests/unit/config.test.ts, tests/integration/daemon.int.test.ts, tests/integration/images.int.test.ts, tests/integration/helpers/api-harness.ts, tests/integration/imageHarness.ts, tests/integration/connectors/mcp.int.test.ts, tests/integration/mcp.tools.int.test.ts, tests/live/chat.live.test.ts
  - **Drift**:
    - Test Config/AppDeps literals were single-line objects, not the multi-line form the plan quoted; added embeddings/embedder fields inline, keeping each file's existing style.

- [x] **P1-NOTES-A017** Phase 1: pgvector schema, migration, embedding state + repo
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/embeddings/{constants,state,repo}.ts` (repo all but `nearestNotes`), `src/db/schema.ts` (`noteEmbeddings`), `drizzle/0001_*.sql` + `drizzle/meta/*`, `scripts/test-int.sh` (notes container on `pgvector/pgvector:pg16`, recreated on image mismatch), `tests/integration/setup.ts` (`truncateAll`), README test-container sentence, state unit tests, repo + migration integration tests (incl. pgvector >= 0.8). Exit: migration applies on a fresh pgvector container and re-applies as a no-op; installed `vector` >= 0.8; JS and SQL hashes agree on ASCII, emoji and CRLF bodies; `listPending` / `saveEmbedding` / `recordFailure` / `embeddingStats` behave per the contract.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` (phase 1 of 6)
  - **Satisfies**: R2, R1, R6 — pgvector schema: extension, side table, HNSW cosine index; first migration since iteration 1; applies to Neon and test DB; test container ships pgvector; Embeddings via OpenRouter (`openai/text-embedding-3-small`, 1536), run-insights' cap and error handling; embedded after every body write without blocking/failing it; failures marked and retried; vector tied to its body hash; textless photos have none; deleted notes keep vectors, never appear; Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1`
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P1-NOTES-A017.md`
  - **Completed**: 2026-10-30 14:39
  - **Method**: /do
  - **Files**: src/embeddings/constants.ts, src/embeddings/state.ts, src/embeddings/repo.ts, src/db/schema.ts, drizzle/0001_note_embeddings.sql, drizzle/meta/0001_snapshot.json, drizzle/meta/_journal.json, scripts/test-int.sh, tests/integration/setup.ts, tests/integration/schema.int.test.ts, tests/integration/embeddings.repo.int.test.ts, tests/unit/embeddings.state.test.ts, README.md
  - **Drift**:
    - none: every plan code block applied verbatim; migration SQL generated byte-identical to the plan's expected 0001_note_embeddings.sql

- [x] **P1-NOTES-A013** Phase 2: expense-tracking curated tools
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/connectors/expenses/{curated,categories,dates,queries}.ts`, `tests/unit/connectors/expenses.{dates,categories,queries}.test.ts`, `tests/integration/connectors/expenses.curated.int.test.ts`. Exit: `expenses_spending` (`from`/`to`, optional `categories`, `top` → total, by category with Indonesian label, by day, by ISO week Monday–Sunday with partial flags, largest items), `expenses_get` (`id` → one expense group with items, photo count/urls, note, raw text), `expenses_months` (`months`, `to_month`, `categories` → monthly totals, zero-filled) return correct integers on seeded data; handlers use `run(…, { compact: true })` and phase 1's `toObjects`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p2/docs/plans/CONNECTORS_PLAN.md` (phase 2 of 6)
  - **Satisfies**: R2, R5 — MCP tools per system (curated, WIB / integer rupiah); unit + Docker integration tests
  - **Depends on**: P1-NOTES-A012
  - **Plan**: `.workflows/plan/P1-NOTES-A013.md`
  - **Completed**: 2026-10-30 13:37
  - **Method**: /implement
  - **Files**: src/connectors/expenses/curated.ts, src/connectors/expenses/categories.ts, src/connectors/expenses/dates.ts, src/connectors/expenses/queries.ts, tests/unit/connectors/expenses.dates.test.ts, tests/unit/connectors/expenses.categories.test.ts, tests/unit/connectors/expenses.queries.test.ts, tests/integration/connectors/expenses.curated.int.test.ts, .workflows/todos.md, .workflows/plan/P1-NOTES-A013.md, docs/plans/CONNECTORS_PLAN.md
  - **Decided**:
    - Plan index names worktree connectors / branch feature/connectors; session is in connectors-p2 on phase-2-connectors → proceed on phase-2-connectors (coordinator orch-connectors assigned this branch explicitly; rung 5 task text)
    - TaskID → P1-NOTES-A013 as assigned by the coordinator; only phase 2's task created in this worktree (tie-break: narrower blast radius, same as phase 1)
    - Code applied verbatim from the plan's eight code blocks (rung 3); no drift against phase 1's types.ts/rows.ts/tools.ts/harness.ts or ~/expense-tracking's drizzle schema

- [x] **P1-NOTES-A014** Phase 3: run-insights curated tools
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `src/connectors/runs/{curated,format,periods,queries}.ts`, `tests/unit/connectors/runs.{format,periods,curated}.test.ts`, `tests/integration/connectors/runs.curated.int.test.ts`. Exit: `runs_list` (`from`, `to` default today → reviewed runs with key metrics and period totals), `runs_get` (exactly one of `id` or `date`: metrics, splits, zones, the app's latest session insight), `runs_review` (`scope` week|month, `key` week/month/day → latest review + totals) correct on seeded data; app units with readable companions; handlers use `run(…, { compact: true })` and phase 1's `toObjects`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p3/docs/plans/CONNECTORS_PLAN.md` (phase 3 of 6)
  - **Satisfies**: R2, R5 — MCP tools per system (curated runs tools); unit + Docker integration tests
  - **Depends on**: P1-NOTES-A012
  - **Plan**: `.workflows/plan/P1-NOTES-A014.md`
  - **Completed**: 2026-10-30 13:37
  - **Method**: /implement
  - **Files**: src/connectors/runs/curated.ts, src/connectors/runs/format.ts, src/connectors/runs/periods.ts, src/connectors/runs/queries.ts, tests/unit/connectors/runs.format.test.ts, tests/unit/connectors/runs.periods.test.ts, tests/unit/connectors/runs.curated.test.ts, tests/integration/connectors/runs.curated.int.test.ts, .workflows/todos.md, .workflows/plan/P1-NOTES-A014.md, docs/plans/CONNECTORS_PLAN.md
  - **Decided**:
    - TaskID → P1-NOTES-A014 as assigned by coordinator orch-connectors (rung 5: task text / coordinator brief)
    - Step 3 task creation in per-phase worktree → only phase 3's task, in root .workflows/todos.md (tie-break: narrower blast radius; matches phases 1 and 6 precedent)
    - Integration tests run serialized under flock /tmp/mcp-notes-test-int.lock (shared Docker containers with peers)

- [x] **P1-NOTES-A015** Phase 4: Seer curated tools (db + lab)
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/connectors/seer/{curated,rows,ranking,leaderboard,positions,sera}.ts`, `tests/unit/connectors/seer.{ranking,sera,curated}.test.ts`, `tests/integration/connectors/seer.curated.int.test.ts`. Exit: `seer_leaderboard` ranks as the app does (common dates, ≥63 shared sessions, annualised Sharpe, tie-breaks; benchmarks and retired not ranked, shown separately), `seer_positions` lists open bracket orders and book positions with marks and unrealised P&L, `seer_sera_best` lists the best variant per method from lab.sqlite with the lab's metrics, correct on seeded Postgres + `makeLab()` lab; handlers use `run(…, { compact: true })` and phase 1's `toObjects`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p4/docs/plans/CONNECTORS_PLAN.md` (phase 4 of 6)
  - **Satisfies**: R2, R5 — MCP tools per system (Seer curated tools); unit + Docker integration tests
  - **Depends on**: P1-NOTES-A012
  - **Plan**: `.workflows/plan/P1-NOTES-A015.md`
  - **Completed**: 2026-10-30 13:37
  - **Method**: /do
  - **Files**: src/connectors/seer/curated.ts, src/connectors/seer/rows.ts, src/connectors/seer/ranking.ts, src/connectors/seer/leaderboard.ts, src/connectors/seer/positions.ts, src/connectors/seer/sera.ts, tests/unit/connectors/seer.ranking.test.ts, tests/unit/connectors/seer.sera.test.ts, tests/unit/connectors/seer.curated.test.ts, tests/integration/connectors/seer.curated.int.test.ts, .workflows/todos.md, .workflows/plan/P1-NOTES-A015.md, docs/plans/CONNECTORS_PLAN.md
  - **Decided**:
    - Plan index names worktree .../connectors on feature/connectors; this session runs in .../connectors-p4 on phase-4-connectors → proceed (coordinator cut per-phase worktrees from af45c9e and said to commit here)
    - TaskID → P1-NOTES-A015 (assigned by coordinator orch-connectors)
    - Step 3 task creation → only phase 4's task created, inline (narrower blast radius; each phase session mints its own)

- [x] **P1-NOTES-A016** Phase 5: Chat bar + /n for connectors
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns src/chat/status.ts, src/chat/prompt.ts, tests/unit/chat-status.test.ts, tests/unit/chat-prompt.test.ts, claude/skills/n/SKILL.md, README (TOC line + "Spending, runs and Seer" /n subsection + first two paragraphs of "The chat bar"), docs/plans/CHAT_BAR_BRAIN_PLAN.md invariant 4 note. Exit: allowedChatTools() = 13 notes + 15 connector + 2 web tools; captions "reading expenses"/"reading runs"/"reading seer" from SYSTEM_META for every connector tool, null for unknown; system prompt names the three systems, says curated first / _sql last / _schema before SQL, asks for what the data shows plus an opinion in the apps' units; /n routes spending/runs/Seer questions to the connector tools; typecheck and unit tests green.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p5/docs/plans/CONNECTORS_PLAN.md` (phase 5 of 6)
  - **Satisfies**: R3 — Chat bar allows + captions the new tools; `/n` routes data questions and gives an opinion
  - **Depends on**: P1-NOTES-A012
  - **Plan**: `.workflows/plan/P1-NOTES-A016.md`
  - **Completed**: 2026-10-30 14:05
  - **Method**: /do
  - **Files**: src/chat/status.ts, src/chat/prompt.ts, tests/unit/chat-status.test.ts, tests/unit/chat-prompt.test.ts, claude/skills/n/SKILL.md, README.md, docs/plans/CHAT_BAR_BRAIN_PLAN.md, docs/plans/CONNECTORS_PLAN.md, .workflows/todos.md, .workflows/plan/P1-NOTES-A016.md
  - **Decided**:
    - Worktree mismatch (index names connectors/feature/connectors; session is in connectors-p5/phase-5-connectors) → proceed in the per-phase worktree (rung 6: swarm coordinator's per-phase worktree convention, cut from af45c9e which contains phase 1)
    - TaskID → P1-NOTES-A016, assigned by coordinator orch-connectors; only phase 5's task minted in root .workflows/todos.md (same convention phases 1 and 6 used)

- [x] **P2-NOTES-C506** Phase 6: Readable links in the answer panel
  - **Difficulty**: EASY
  - **Type**: Feature
  - **Context**: Owns `web/src/components/AnswerPanel.tsx`, `web/src/lib/links.ts` + `web/src/lib/links.test.tsx`, `web/src/styles.css` (link style), `web/src/components/AnswerPanel.test.tsx` (new). Exit: markdown links `[text](https://…)` render as an underlined `<a>` showing the text, bare `http(s)://` URLs render as underlined links, both open in a new tab with `rel="noreferrer noopener"`, styled in the caption family; raw `[..](..)` never appears; streaming partial links degrade to plain text until complete.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p6/docs/plans/CONNECTORS_PLAN.md` (phase 6 of 6)
  - **Satisfies**: R4 — Answer panel never shows raw markdown link syntax
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P2-NOTES-C506.md`
  - **Completed**: 2026-10-30 13:40
  - **Method**: /do
  - **Files**: web/src/lib/links.ts, web/src/lib/links.test.tsx, web/src/components/AnswerPanel.tsx, web/src/components/AnswerPanel.test.tsx, web/src/styles.css, .workflows/todos.md, .workflows/plan/P2-NOTES-C506.md, docs/plans/CONNECTORS_PLAN.md
  - **Decided**:
    - Task bookkeeping in a per-phase-worktree swarm → mint only phase 6's task, as P2-NOTES-C506 (non-sequential ID to avoid colliding with phase 1's counter), in root .workflows/todos.md (tie-break: narrower blast radius; rung 6 convention: earlier plan sets tracked in root todos)
    - test:int not run for a web-only phase → skipped to avoid disturbing phase 1's concurrent Docker containers (tie-break: narrower blast radius; no src/ or tests/integration change)

- [x] **P1-NOTES-A012** Phase 1: Connector core, generic tools, test harness
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `src/connectors/{names,types,errors,env,rows,pg,lab,guard,connector,schema,sql,register}.ts`, `src/connectors/<id>/index.ts` + stub `curated.ts` for all three systems, `src/mcp/{server,tools,instructions}.ts`, `scripts/test-int.sh`, `vitest.config.ts`, `package.json` (scripts), connector unit/integration/live tests, README connectors sections, `docs/INSTALL.md` ("5. Connectors") (39 files). Exit: `tools/list` on `/mcp` shows the 6 generic tools; `_schema` returns tables/columns/types/comments from the live DB (and lab for seer); `_sql` rejects writes and multi-statements before the DB, caps rows, and `nextval`/INSERT through the unguarded executor fail with a read-only error; missing repo / `.env.local` / unreachable DB give the short error and other tools keep working; `npm run test:live:connectors` exists and is excluded by default.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/.worktrees/mcp-notes/connectors-p1/docs/plans/CONNECTORS_PLAN.md` (phase 1 of 6)
  - **Satisfies**: R1, R2, R5 — Connector core (read-only connectors per system); MCP tools per system; unit + Docker integration tests
  - **Depends on**: —
  - **Plan**: `.workflows/plan/P1-NOTES-A012.md`
  - **Completed**: 2026-10-30 13:28
  - **Method**: /do
  - **Files**: src/connectors/names.ts, src/connectors/types.ts, src/connectors/errors.ts, src/connectors/env.ts, src/connectors/rows.ts, src/connectors/pg.ts, src/connectors/lab.ts, src/connectors/guard.ts, src/connectors/connector.ts, src/connectors/schema.ts, src/connectors/sql.ts, src/connectors/register.ts, src/connectors/expenses/index.ts, src/connectors/expenses/curated.ts, src/connectors/runs/index.ts, src/connectors/runs/curated.ts, src/connectors/seer/index.ts, src/connectors/seer/curated.ts, src/mcp/instructions.ts, src/mcp/server.ts, src/mcp/tools.ts, tests/unit/mcp.instructions.test.ts, tests/unit/connectors/names.test.ts, tests/unit/connectors/guard.test.ts, tests/unit/connectors/rows.test.ts, tests/unit/connectors/env.test.ts, tests/unit/connectors/failsoft.test.ts, tests/integration/connectors/siblings.ts, tests/integration/connectors/globalSetup.ts, tests/integration/connectors/harness.ts, tests/integration/connectors/core.int.test.ts, tests/integration/connectors/generic.int.test.ts, tests/integration/connectors/mcp.int.test.ts, tests/live/connectors.live.test.ts, scripts/test-int.sh, vitest.config.ts, package.json, README.md, docs/INSTALL.md
  - **Decided**:
    - Step 3 task creation in a per-phase-worktree swarm: create all 6 phases' tasks vs only phase 1's → only phase 1's (tie-break: narrower blast radius; each phase's own session/branch mints its own). TaskID P1-NOTES-A012 was minted as next-after-A011; sibling phase branches may mint the same number, so the coordinator should renumber on integration.

- [x] **P1-NOTES-A011** Phase 4: Daemon fit: unit, install.sh, live suite, installed acceptance
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `deploy/notesd.service` (`NOTESD_CLAUDE_BIN`, `HOME`), `scripts/install.sh` (resolved claude path, credential/LLM_* warnings, chat smoke in `verify`), `vitest.config.ts` + `package.json` `test:live`, `tests/live/chat.live.test.ts` (real Claude + GLM message), `docs/INSTALL.md` (6 files); links `.env.local` into the worktree, runs install.sh from the worktree and the acceptance prompts against the installed daemon; re-running install.sh from `~/mcp-notes` happens after landing. Exit: the installed daemon answers each acceptance prompt for real, and the live suite passes.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` (phase 4 of 4)
  - **Satisfies**: R1 — Claude brain: Agent SDK `ChatBackend`. One run per message, token streaming, notes MCP + WebSearch/WebFetch only (writes allowed), `view_images`, system prompt, no saved answers, max turns, timeout, abort; R5 — Daemon fit: unit + install.sh give the SDK `claude` and the login, verified through the installed daemon; R6 — Tests: backend unit tests vs a fake `query`, `/api/chat` int tests with the fake injected, opt-in live suite `CHAT_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A009, P1-NOTES-A010
  - **Plan**: `.workflows/plan/P1-NOTES-A011.md`
  - **Completed**: 2026-10-30 11:29
  - **Method**: /do
  - **Files**: deploy/notesd.service, scripts/install.sh, vitest.config.ts, package.json, tests/live/chat.live.test.ts, docs/INSTALL.md
  - **Drift**:
    - None in code. Wall SSE note event op is 'updated' on the wire (plan text said 'update'); A2 matched on it.
    - Owner's Neon store had zero live notes before acceptance (only two image notes 3-3XZ, 9-C0C soft-deleted at 10:23 local, before this phase). A1 correctly answered 'no #seer notes'.

- [x] **P1-NOTES-A009** Phase 2: Agent SDK backend: Claude, GLM, fallback, threads, guardrails
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `@anthropic-ai/claude-agent-sdk@0.3.311` + `@anthropic-ai/sdk@0.135.0` in `dependencies`, new `src/chat/agent.ts` (`createAgentChatBackend`), `src/chat/prompt.ts`, `src/chat/status.ts`, `src/chat/env.ts` (child env, strips parent-session markers), four unit test files against a fake `query`, `src/daemon.ts` (real backend by default, lazy MCP url, `close()` on stop), `tests/integration/daemon.int.test.ts` (stub injected; agent-by-default start/stop test) (12 files). Exit: unit tests cover delta streaming, status mapping, ids passed through, resume, abort (client + supersede + timeout + close), max turns, fallback (pre-text auth/limit error → one GLM retry; post-text error → no retry; `CHAT_BRAIN=glm` → GLM only, no fallback), and session-marker stripping. No integration test spawns `claude`. `npm run build` succeeds.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` (phase 2 of 4)
  - **Satisfies**: R1 — Claude brain: Agent SDK `ChatBackend`. One run per message, token streaming, notes MCP + WebSearch/WebFetch only (writes allowed), `view_images`, system prompt, no saved answers, max turns, timeout, abort; R2 — Threads: `thread_id` = SDK session. Resume on follow-up, dismiss = new thread, pin keeps it, survives a daemon restart; R3 — GLM fallback: `CHAT_BRAIN=claude\|glm` (default claude), one GLM retry after a Claude usage-limit/auth failure, brain label in the panel header; R4 — Progress: `event: status` in the SSE contract, terse tool captions in the panel header; R6 — Tests: backend unit tests vs a fake `query`, `/api/chat` int tests with the fake injected, opt-in live suite `CHAT_LIVE_TEST=1`
  - **Depends on**: P1-NOTES-A008
  - **Plan**: `.workflows/plan/P1-NOTES-A009.md`
  - **Completed**: 2026-10-30 11:21
  - **Method**: /do
  - **Files**: package.json, package-lock.json, src/chat/agent.ts, src/chat/env.ts, src/chat/prompt.ts, src/chat/status.ts, src/daemon.ts, tests/integration/daemon.int.test.ts, tests/unit/chat-agent.test.ts, tests/unit/chat-env.test.ts, tests/unit/chat-prompt.test.ts, tests/unit/chat-status.test.ts
  - **Drift**:
    - none: src/daemon.ts and daemon.int.test.ts matched Phase 1's quoted text exactly
    - npm install warned that esbuild postinstall scripts were not approved (install-scripts policy); tsx/vitest/vite already worked, build and tests green

- [x] **P1-NOTES-A010** Phase 3: Panel: status caption, brain label, thread reset on dismiss
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `web/src/hooks/useChat.ts` (`status`, `brain`, `close()` clears thread), `web/src/components/AnswerPanel.tsx` (one `.answer-status` span), `web/src/styles.css`, `web/src/App.tsx` (two prop lines), `web/src/App.test.tsx`, new `web/src/hooks/useChat.test.tsx` (6 files). Exit: a fake SSE stream with `status` + `done{brain}` renders caption then label; dismiss → the next post has no `thread_id`; pinned + a second ask → same `thread_id`.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` (phase 3 of 4)
  - **Satisfies**: R2 — Threads: `thread_id` = SDK session. Resume on follow-up, dismiss = new thread, pin keeps it, survives a daemon restart; R3 — GLM fallback: `CHAT_BRAIN=claude\|glm` (default claude), one GLM retry after a Claude usage-limit/auth failure, brain label in the panel header; R4 — Progress: `event: status` in the SSE contract, terse tool captions in the panel header
  - **Depends on**: P1-NOTES-A008
  - **Plan**: `.workflows/plan/P1-NOTES-A010.md`
  - **Completed**: 2026-10-30 11:17
  - **Method**: /implement
  - **Files**: web/src/hooks/useChat.ts, web/src/hooks/useChat.test.tsx, web/src/components/AnswerPanel.tsx, web/src/App.tsx, web/src/App.test.tsx, web/src/styles.css

- [x] **P1-NOTES-A008** Phase 1: Chat seam v2: status events, brain, config, daemon injection
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns the `ChatBackend` contract in `src/chat/backend.ts`, `src/chat/stub.ts` (delta-only), `src/http/api.ts` (`status` + `done.brain`), `src/http/app.ts`, `src/daemon.ts` (`CHAT_SUBDIR`, `StartDaemonOptions { chat? }`, stub by default), `src/config.ts` (`Config.chat`, `DEFAULT_CHAT_CONFIG`), new `tests/integration/helpers/scripted-chat.ts`, api/daemon int tests + harness, and `chat: DEFAULT_CHAT_CONFIG` in the other `Config` literals (15 files). Exit: contract types compile, the stub passes, the int tests cover status/brain/error/abort through `/api/chat`, the daemon still serves the stub by default.
  - **Status**: completed
  - **Plan Set**: `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` (phase 1 of 4)
  - **Satisfies**: R3 — GLM fallback: `CHAT_BRAIN=claude\|glm` (default claude), one GLM retry after a Claude usage-limit/auth failure, brain label in the panel header; R4 — Progress: `event: status` in the SSE contract, terse tool captions in the panel header; R6 — Tests: backend unit tests vs a fake `query`, `/api/chat` int tests with the fake injected, opt-in live suite `CHAT_LIVE_TEST=1`
  - **Depends on**: none
  - **Plan**: `.workflows/plan/P1-NOTES-A008.md`
  - **Completed**: 2026-10-30 11:13
  - **Method**: /do
  - **Files**: src/chat/backend.ts, src/chat/stub.ts, src/config.ts, src/daemon.ts, src/http/api.ts, src/http/app.ts, tests/unit/chat-stub.test.ts, tests/unit/config.test.ts, tests/integration/helpers/scripted-chat.ts, tests/integration/helpers/api-harness.ts, tests/integration/api.int.test.ts, tests/integration/daemon.int.test.ts, tests/integration/imageHarness.ts, tests/integration/mcp.tools.int.test.ts, tests/integration/images.int.test.ts
  - **Drift**:
    - tests/integration/helpers/api-harness.ts: the deps literal was one line, not the multi-line shape the plan quoted; replaced lines 34-48 per the plan's block (no behavioural difference).
    - Worktree had no node_modules; ran `npm ci` (package-lock unchanged).
    - Manual curl against `npm run dev` skipped: daemon.int.test.ts 'serves the stub chat backend when none is injected' covers the stub over real HTTP with no brain.

- [x] **P1-NOTES-A007** Phase 8: Web UI images: gallery, photo modal, full-screen tab, drag/paste upload, missing-file placeholder
  - **Difficulty**: NORMAL
  - **Type**: Feature
  - **Context**: Owns `web/src/components/{NoteImage,Gallery,PhotoModal,DropOverlay}.tsx` (rewrites of P7 stubs), `PhotoModal.css`, `web/fullscreen.html` + `web/src/fullscreen/**`, drag/drop + paste upload to `POST /api/images`, "not on this machine" placeholder, film-tone filter. Exit: gallery, modal (Esc/arrows), full-screen tab (fit/1:1/pan, title = id), upload all work against a running daemon on a test port; gates green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 8 of 8)
  - **Satisfies**: R3 — Web UI: Claude Design as a Vite + React + TS SPA served by notesd, real API, 3-way visibility, gallery, modal, full-screen tab, upload, inline edit, streaming /api/chat stub, live updates
  - **Depends on**: P1-NOTES-A004, P1-NOTES-A006
  - **Plan**: `.workflows/plan/P1-NOTES-A007.md`
  - **Completed**: 2026-10-30 10:34
  - **Method**: /do
  - **Files**: web/src/components/NoteImage.tsx, web/src/components/Gallery.tsx, web/src/components/PhotoModal.tsx, web/src/components/PhotoModal.css, web/src/components/DropOverlay.tsx, web/fullscreen.html, web/src/fullscreen/main.tsx, web/src/fullscreen/FullscreenApp.tsx, web/src/fullscreen/view.ts, web/vite.config.ts, web/src/components/NoteImage.test.tsx, web/src/components/Gallery.test.tsx, web/src/components/PhotoModal.test.tsx, web/src/components/DropOverlay.test.tsx, web/src/fullscreen/FullscreenApp.test.tsx
  - **Drift**:
    - web/vite.config.ts: phase 7's input map uses key `index` (plan expected `main`); added only `fullscreen` alongside it and kept the rest of phase 7's config (proxy targets, assetsDir), as the plan's Step 7 instructs.
  - **Decided**:
    - Phase 7's App.test.tsx locates the gallery by `.gallery` (its stub's class); plan's Gallery had only `data-gallery` → keep `className="gallery"` on the section in Gallery.tsx (rung 1: invariant 2, no phase leaves the tree broken; tie-break: stay inside Owns, never relax a peer's test)
  - **Verification**:
    - npm run typecheck green; npm test (27 files / 223 tests), npm run test:int (9 files / 86 tests) green; npm run build green, web/dist/index.html + web/dist/fullscreen.html (absolute /assets/fullscreen-*.js)
    - Test-port daemon (7391, Docker test DB, temp data dir; Neon untouched): upload created:true, re-upload same id created:false; /full/<id> 200 text/html; /display 200 image/jpeg byte-identical; images/ moved away → 404 not_on_this_machine
    - Headless Chromium: text mode hides image cards; Files drag shows overlay; drop uploads and switches text→all; gallery tiles; modal (display variant, film filter, counter), Esc closes; /full/<id> title = id, fit/1:1/drag; missing-file placeholder on wall, gallery, modal, full-screen; no page errors

- [x] **P1-NOTES-A006** Phase 7: Web UI core: wall, rail, sidebar, header, inline edit, chat bar + answer panel, tooltips, live updates
  - **Difficulty**: HARD
  - **Type**: Feature
  - **Context**: Owns `web/**` (Vite config, components, styles, fonts, API client, SSE + 60 s refetch, 3-way visibility mode), `package.json` scripts only (`build`, `dev:web`), `tsconfig.web.json`; every non-image element of `Notes Wall.dc.html`. Exit: `npm run build` produces `web/dist`; served by the daemon on a test port the wall renders real notes; component tests green.
  - **Status**: completed
  - **Plan Set**: `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` (phase 7 of 8)
  - **Satisfies**: R3 — Web UI: Claude Design as a Vite + React + TS SPA served by notesd, real API, 3-way visibility, gallery, modal, full-screen tab, upload, inline edit, streaming /api/chat stub, live updates
  - **Depends on**: P1-NOTES-A005
  - **Plan**: `.workflows/plan/P1-NOTES-A006.md`
  - **Completed**: 2026-10-30 10:26
  - **Method**: /do
  - **Files**: package.json, tsconfig.web.json, web/index.html, web/tsconfig.json, web/vite.config.ts, web/src/main.tsx, web/src/App.tsx, web/src/App.test.tsx, web/src/styles.css, web/src/types.ts, web/src/api.ts, web/src/lib/text.ts, web/src/lib/text.test.tsx, web/src/lib/filter.ts, web/src/lib/filter.test.tsx, web/src/lib/usedIds.ts, web/src/lib/usedIds.test.tsx, web/src/lib/dates.ts, web/src/lib/dates.test.tsx, web/src/lib/sse.ts, web/src/lib/sse.test.tsx, web/src/hooks/useNow.ts, web/src/hooks/useCopied.ts, web/src/hooks/useNotes.ts, web/src/hooks/useChat.ts, web/src/components/Rail.tsx, web/src/components/Sidebar.tsx, web/src/components/Header.tsx, web/src/components/Wall.tsx, web/src/components/NoteCard.tsx, web/src/components/NoteCard.test.tsx, web/src/components/AnswerPanel.tsx, web/src/components/ChatBar.tsx, web/src/components/Tooltip.tsx, web/src/components/Gallery.tsx, web/src/components/PhotoModal.tsx, web/src/components/DropOverlay.tsx, web/src/components/NoteImage.tsx
  - **Drift**:
    - none: every code block applied verbatim; root tsconfig.json already excludes web/ (Assumption 1 held)
  - **Verification**:
    - npm run typecheck (server + tsconfig.web.json), npm test (22 files / 192 tests, 7 new web files / 40 tests), npm run test:int (9 files / 86 tests), npm run build (web/dist index.html + js/css/woff2): all green
    - Daemon on NOTESD_PORT=7399 against mcp-notes-pg-test: / serves the #root shell, /assets js+css 200, POST/GET /api/notes and /api/tags return real data
    - Not done: in-browser visual checklist (no browser in the session)


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
