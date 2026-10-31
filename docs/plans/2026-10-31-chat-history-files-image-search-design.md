# Chat history, note files, image search: design

Status: agreed in discussion 2026-10-31, ready for `/analyze`. Robustness over speed; phases ordered by dependency.

## Scope

1. Paste an image into the chat query bar (wall chat, and `/n` in Claude Code).
2. Note files: attach any file to a note from the bigger-note-view modal; ctrl-v in that modal attaches to that note.
3. Chat history: persisted, own page, reply_to, edit/delete, note-id links, image thumbnails.
4. Image lightbox shared by chat and the note modal gallery.
5. Real image similarity search ("find similar photos as this").
6. UI fix: "Show in explorer" is centered in the note card footer; move it left.

## 1. Paste into the query bar

- Today `web/src/components/DropOverlay.tsx` has a global `document` `paste` listener that creates a new note from any pasted image.
- New rule: if the ChatBar input is focused (`document.activeElement`), the global handler does nothing and the ChatBar handles the paste itself.
- Pasted images show as removable thumbnails in the bar and are sent with the message (upload, then reference by id in the chat request).
- Inside the bigger-note-view modal, ctrl-v attaches the pasted file to that note instead of creating a new one (see section 2).
- `/n` in Claude Code: the agent receives the image through the normal Claude Code image paste; it then calls the `similar_images` tool (section 5).

## 2. Note files

- Notes already hold many images via `note_images` (position, sha256 dedupe, soft delete). Non-image files are new.
- Storage: store and dedupe by sha256 like images; schema carries `extracted_text` and an extraction `status` so text extraction can be added later without a migration. No extraction in v1.
- Agent tools expose a note's files by name, size and type, so Claude can see a file exists even when it cannot read it.
- Modal: an attach (paperclip) icon button opens a file picker; ctrl-v and drop attach to the open note. Files render as chips (name, size, type) with download and per-file reveal.
- "Show in explorer": the note-level button stays and opens the folder containing all of that note's files. Each file chip also gets its own reveal. Server side extends `src/http/reveal.ts`.

## 3. Chat history

### Data model (own DB is the source of truth)
- Tables for threads, messages (id, thread, role, text, created_at UTC, reply_to, edited_at, deleted_at, source: `wall` | `claude_code`, brain), message revisions, and message attachments (image or note files by id).
- Each message has a stable short id shown to the model as e.g. `[msg:K7F2]`.
- Each wall chat turn rebuilds the model context from our rows for that thread, plus any bubbles named by reply_to (even from other threads). Agent SDK `resume` is no longer relied on, so claude and glm behave identically.
- Old Agent SDK sessions are not imported.

### Claude Code capture
- A Claude Code hook fires at end of turn, detects a prompt starting with `/n`, reads `transcript_path`, and POSTs `{prompt, final answer, timestamp, pasted images}` to the daemon.
- Each exchange is one single-turn thread on a unified timeline, badged "claude code". Works from either laptop because the daemon and DB are shared.
- Pasted images are copied into the store at capture time (transcript copies may be ephemeral).

### reply_to
- User picks a bubble to reply to. The model replies to a bubble by citing its id; the server parses the citation into `reply_to`. Both brains support it.
- A reply bubble shows a quoted header; clicking it scrolls to and highlights the target. A deleted target shows "message deleted".

### Edit and delete
- Edit: user bubbles only, in place, with an "edited" mark and the old text kept as a revision. Affects future context only; the existing answer is not regenerated.
- Delete: any bubble, soft and restorable (same pattern as the notes bin). Deleting a question offers to delete its answer too.

### UI
- Sidebar: chat-history icon above the recycle bin.
- Chat panel (screenshot 1): add a "chat in full screen" icon button that opens the history page.
- History page: the same pill query bar at the bottom; a timestamp on every bubble in UTC+7 (Asia/Jakarta), stored UTC; image thumbnails that open the lightbox.
- Every note id in chat text renders as a link that opens the bigger-note-view modal in place, no navigation. The modal gets an icon button that goes to `/?note=ID` and flashes the note on the wall.

## 4. Image lightbox

- One shared component: click a thumbnail to view the image large.
- Used by chat history thumbnails, and by the note modal gallery strip (screenshot 3) with left/right arrows (clicks and keys) to move between adjacent images without closing.

## 5. Image similarity search

- Model: Google Gemini Embedding 2 through OpenRouter, the same endpoint and key as the text embeddings (`src/embeddings/openrouter.ts`). Text and images share one vector space; images are sent as `image_url` content items. Verify the live model page, request format, pricing and output dimension before building.
- New table `note_image_embeddings`, separate from `note_embeddings` (different model and dimension). Worker embeds new images; a backfill script covers existing ones (mirror `embed:backfill`).
- New MCP tool `similar_images` (input: pasted image or an existing image id; output: nearest images with scores), available to the wall chat agent and `/n`. The model then views the top hits with `view_images` to explain or rank them.
- Text to image search ("red top in a car") reuses the same vectors.

## 6. UI bug

- "Show in explorer" in the note card footer is centered; align it left.

## Suggested phase order

1. Foundations: UI fix, paste routing, shared lightbox.
2. Note files: schema, API, modal UI, reveal, tools.
3. Image embeddings: provider check, table, worker, backfill, `similar_images`, chat-bar paste upload.
4. Chat persistence: schema, backend rebuild of context, reply_to, edit/delete.
5. Claude Code hook capture.
6. History page and sidebar, note-id links, modal "show on wall".

## Open items for the analyze step

- Confirm Gemini Embedding 2 request shape and dimension on OpenRouter.
- Decide the transport for pasted chat images (upload endpoint vs inline).
- Decide the hook's install location (user settings) and its auth to the daemon.
