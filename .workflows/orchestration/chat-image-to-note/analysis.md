# Code Analysis: turn a pasted chat image into a note (wall chat + Claude Code `/n`)

**Type:** Feature Update
**Date:** 2026-10-31 12:24 (WIB)
**Session ID:** 20261031-122441-Q7MX
**Plan:** `docs/plans/CHAT_IMAGE_TO_NOTE_PLAN.md` (4 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-image-to-note`, branch `feature/chat-image-to-note` (base `main` @ `f899b85`; checkout was clean, no `origin` remote)

---

## User Input

### Original User Request

Feature: turn a pasted chat image into a note, from the wall chat AND from Claude Code "/n please make that image as a new note then".

PROBLEM (observed, wall chat thread cd6e7f63, 2026-10-31): user pasted an image (chat image id G-0NC), asked "search similar image", then "please make that image as a new note then". Agent replied it could not: create_image/attach_image only accept a filesystem `path`, and a chat upload lives in the separate chat_images store (data dir chat-images/YYYY/MM/<id>.<ext>) with no path the agent can name.

FINDINGS ALREADY ESTABLISHED (verify, don't re-derive):
- src/mcp/imageTools.ts: create_image(path, body, origin) -> ingestFromPath in src/http/imageAccess.ts. attach_image likewise path-only.
- src/chat/images.ts + src/chat/capture.ts: chat_images store, sha-deduped, source 'wall' | 'claude_code'.
- claude/hooks/notes-capture.mjs is a Stop hook posting to /api/capture/claude-code. It only captures prompts matching /n, and only extracts images from THAT turn's prompt (lib/transcript.mjs extractImages, isNotesPrompt). So an image pasted in an earlier turn, or in a non-/n turn, never reaches chat_images, and the Claude Code model has no id or path for it.
- ~/.claude/image-cache does not exist here, so do not rely on it.

DECIDED DESIGN (user approved):
1. Daemon: add an `image_id` input (chat-image id like G-0NC, case/dash tolerant) to create_image and attach_image (path XOR image_id). Daemon resolves it to the stored chat image file and runs the existing ingest (copy, sha dedupe -> returns existing note with created:false). Fixes wall chat: the wall agent already sees the G-id in context. Update src/mcp/instructions.ts, src/chat/status.ts captions, and the wall agent system prompt (src/chat/prompt.ts) so it uses image_id instead of asking for a path.
2. Claude Code, same turn (approach "a"): add a UserPromptSubmit hook for /n prompts that reads the newest transcript entry(ies), ingests pasted images into chat_images immediately (reuse the capture endpoint or a new one; idempotent with the later Stop-hook capture, no duplicate rows), and injects additionalContext like "Pasted image(s) this session: latest = G-xxx (paste #N), earlier = ...". Model then calls create_image(image_id=...).
3. Resolution default for "that image": this session's LATEST pasted image; explicit ids ("G-0NC") override.
4. Robustness: capture images from ANY user turn in the session that contains images (not only /n turns) so earlier pastes resolve to ids; keep size/count caps (MAX_IMAGES 8, 20MB). Hook failures must never block the prompt. Idempotency key must stay <claude_session>:<user_uuid>.

ASK: full analysis, plan set with phases, tests (vitest + hook tests), risks (privacy of capturing non-/n turns: confirm scope, disk growth, dedupe), and docs/CHANGELOG updates. Work in /home/miftah/mcp-notes. Do not implement yet; produce the plan set.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Daemon: `image_id` (chat-image id, case/dash tolerant, path XOR image_id) on `create_image` and `attach_image`, same ingest and sha dedupe (`created:false`); wall agent prompt, MCP instructions and status captions use it instead of asking for a path |
| R2 | Claude Code, same turn: a `UserPromptSubmit` hook for `/n` prompts ingests pasted images into `chat_images` at once and injects `additionalContext` naming the ids, so the model can call `create_image(image_id=...)`; idempotent with the later Stop capture |
| R3 | "That image" resolves to this session's LATEST pasted image; an explicit id overrides |
| R4 | Robustness: images of any user turn in the session resolve to ids; caps kept (8 images, 20 MB); a hook failure never blocks the prompt; idempotency key stays `<claude_session>:<user_uuid>` |
| R5 | Tests (vitest unit + integration, hook tests) and a risk analysis (privacy of non-`/n` turns, disk growth, dedupe) |
| R6 | Docs and CHANGELOG updates |

---

## Detailed Requirements Understanding

**Problem statement.** A picture the user pastes lives in `chat_images` (own id space, same `A-B32` shape, files under `<dataDir>/chat-images/YYYY/MM/<id>.<ext>`). The note store's two image-writing tools take only a filesystem path, and no tool can name a chat image's file. The wall agent therefore cannot honour "make that image a note" although it sees `[image upload:G-0NC]`. In Claude Code the situation is worse: a pasted image has no path and, unless the turn was `/n` and the Stop hook later ran, no id.

**Behaviour that must change.**
1. `create_image` / `attach_image` accept `image_id` instead of `path`, resolve it through the chat image store and reuse the existing ingest.
2. The agents' instructions say to use `image_id` for pasted images and never ask for a path.
3. A new `UserPromptSubmit` hook turns the session's pasted images into chat image ids before the model answers, and tells the model which id is "that image".

**Success criteria.**
- Wall chat: paste image, "make that image a note" → one `create_image({image_id})` call, a new image note; asking again returns the same note with `created: false`.
- Claude Code: `/n please make that image a new note` with the image pasted in this or any earlier turn of the session → note created from the latest image; "the first image"/`[Image #1]`/`G-xxx` overrides.
- No `chat_images` duplicate rows (sha256 unique) and no duplicate chat thread (key `<claude_session>:<user_uuid>` unchanged); the Stop hook's later capture of the same turn attaches the same ids.
- A hook failure (daemon down, transcript unreadable, timeout) leaves the prompt untouched and exits 0.

**Edge cases / constraints.**
- Same bytes pasted twice → same chat id (sha dedupe); same bytes already a note image → `create_image` returns that note (`created:false`), `attach_image` returns `attached:false`.
- Chat image row exists but its file is on the other laptop (`available:false`) → a clear refusal, not a crash.
- `image_id` of a *note* image (remove_image/similar_images's `image_id` space) is a different id space; an unknown chat id must say so ("no pasted image X") rather than silently match a note image.
- The transcript may not yet contain the current prompt when `UserPromptSubmit` fires (unverified; the Stop hook needs a 3 s settle poll for the same reason).
- `UserPromptSubmit` blocks the prompt: the hook must be cheap on every non-`/n` prompt and time-boxed on `/n` prompts.

**Assumptions.**
- `UserPromptSubmit` stdin carries `session_id`, `transcript_path`, `cwd`, `prompt`; stdout `{hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}` adds context (documented Claude Code contract; the repo has no prior use, so a live check script is part of the plan).
- A typed `/n ...` arrives in `input.prompt` as `/n ...`.
- `imagePasteIds` is a per-session running counter, so `[Image #N]` is a stable per-session label (the existing `pickPastedImage` already treats it that way).

---

## Analysis Scope

### Explicitly Mentioned Files (all read)
- `src/mcp/imageTools.ts`, `src/http/imageAccess.ts`, `src/chat/images.ts`, `src/chat/capture.ts`
- `claude/hooks/notes-capture.mjs`, `claude/hooks/lib/transcript.mjs`, `src/mcp/instructions.ts`, `src/chat/status.ts`, `src/chat/prompt.ts`

### Discovered Related Files
- `claude/hooks/notes-paste.mjs` (PreToolUse for `similar_images`; already uploads a pasted image to `POST /api/chat/images` with `source=claude_code`, exports `uploadImage`, `uploadIdFrom`)
- `claude/hooks/lib/state.mjs` (`daemonBaseUrl`, `stateDir`, `writeLog`, `readStdin`, `isMainModule`), `claude/hooks/*.d.mts` (type declarations the typecheck needs)
- `src/http/chatImages.ts` (`POST /api/chat/images`, multipart `file` + `source`), `src/http/capture.ts` (`/api/capture/claude-code`)
- `src/embeddings/chatUploads.ts` (`dbChatUploadSource`: id → absolute original path via `locateChatImage`), `src/mcp/similarTools.ts` (`upload_id` resolution; the model for `image_id`)
- `src/http/images.ts` (maps `ImageInputError` → 413/415 for HTTP routes), `src/images/ingest.ts` (`ingestImage`, `attachImage`; sha dedupe, accept `path`)
- `scripts/claude-hooks.mjs` (settings.json merge; `OUR_SCRIPT` regex, `ourGroups`), `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/verify-paste-hook.mjs`
- `claude/skills/n/SKILL.md` (Images section documents `pasted_image` and "never save it as a note unless asked")
- tests: `tests/unit/hooks/{fixtures,notesCapture,notesPaste,transcript}.test.ts`, `tests/unit/scripts/claudeHooks.test.ts`, `tests/integration/{capture.hook,images.mcp,images.attach,chat.images,similarImages.mcp}.int.test.ts`, `tests/unit/{mcp.instructions,chat-prompt,chat-status,imageAccess}.test.ts`
- docs: `README.md` (hooks section ~l.295, install steps ~l.572, tool table ~l.692, state dir ~l.790), `docs/INSTALL.md`, `CHANGELOG.md` (`[Unreleased]`)

---

## Current Dataflow

### A. Wall chat: why "make that image a note" fails

1. Browser pastes an image → `POST /api/chat/images` (`src/http/chatImages.ts`) → `ingestChatImage` (`src/chat/images.ts:180`): sha256 dedupe in `chat_images`, probe, write `chat-images/YYYY/MM/<id>.<ext>`, insert row (`id`, `path`, `sha256`, `mime`, `width`, `height`, `bytes`, `original_name`, `host`, `source`).
2. The chat turn goes out with `image_ids`; `resolveTurnImages` (`images.ts:279`) builds preview blocks; the message text carries `[image upload:G-0NC]`.
3. The agent may call `similar_images({upload_id})` → `dbChatUploadSource` → `locateChatImage` (`images.ts:258`) → absolute path → embed on the fly (never persisted).
4. For "make it a note" the agent has only `create_image({path, body, origin})` (`imageTools.ts:121`) → `ingestFromPath` (`imageAccess.ts:182`): requires an absolute, existing, ≤200 MB regular file → `runIngest` → `ingestImage(img, {path, originalName, origin, move:false})` (`ingest.ts:159`). No tool turns a chat id into a path, so the agent refuses.

### B. Claude Code `/n`: what reaches `chat_images` today

1. `Stop` hook `notes-capture.mjs` (async, 60 s) → `capturePayload` (`:102`) polls the transcript up to 3 s, `findTurn` takes the LAST human prompt, and returns null unless `isNotesPrompt(turn.prompt)` (`transcript.mjs:93`).
2. `buildPayload` (`:67`) carries `images: selectImages(extractImages(prompt))` of that one entry only (≤8, ≤20 MB each, ≤48 MB base64 total, png/jpeg/gif/webp).
3. `POST /api/capture/claude-code` (`src/http/capture.ts`) → `captureClaudeCodeExchange` (`src/chat/capture.ts:58`): each image → `ingestChatImage(source 'claude_code', maxBytes 20 MB)` (sha dedupe) → `deps.chat.recordExchange` keyed `<claude_session>:<user_uuid>` (idempotent; `duplicate:true` on replay).
4. This runs AFTER the turn. During the turn the model has no id. The only in-turn route is `PreToolUse` `notes-paste.mjs` for `mcp__notes__similar_images` with `pasted_image: N`, which uploads image N of the latest image-carrying human prompt via `POST /api/chat/images` and rewrites the call to `upload_id`. It serves `similar_images` only.

### Data persistence
- `chat_images` (unique `sha256`; `ingestChatImage` returns the existing row with `created:false` and heals a missing local file). Originals never pruned (no GC exists). Derivatives under `cache/c_<id>/`.
- Hook state: `${XDG_STATE_HOME:-~/.local/state}/notes-capture/` (`outbox/`, `capture.log`, `paste.log`).

### Exit points / side effects
- `create_image` → note + `images` row (sha-deduped against LIVE note images via `records.bySha256Live`), event on `/api/events`.
- Hook stdout is hook JSON only; exit code always 0.

---

## Key Data Structures

### `ImageInputError` (`src/http/imageAccess.ts:42-52`)
Codes `'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large'`. MCP tools turn it into `isError` text; `src/http/images.ts:37-47,126-131` maps every non-`too_large` code to HTTP 415 (HTTP routes never raise path-only codes, so adding MCP-only codes is safe).

### `ChatImageRow` / `locateChatImage` (`src/chat/images.ts:250-272`)
`{row, source:{id:'c_<id>', mime, originalPath}, available}`; tolerant of any `normalizeId` spelling. `ToolDeps` already holds `db` and `dataDir` (`src/mcp/tools.ts:18-27`), which is all `locateChatImage` needs.

### Transcript image shapes (`claude/hooks/lib/transcript.mjs`)
`extractImages(entry)` → `[{media_type, data_base64, paste_id}]`; `isHumanPrompt`, `findLatestImagePrompt`, `pickPastedImage` exist. `findLatestImagePrompt` returns only the newest image-carrying prompt; nothing enumerates ALL image-carrying prompts of a session.

### Hook registration (`scripts/claude-hooks.mjs`)
`OUR_SCRIPT = /notes-(?:capture|paste)\.mjs.../` recognises our handlers; `ourGroups` emits exactly two groups (`Stop`, `PreToolUse`); `mergeHooks` / `removeHooks` / `ourHandlers` iterate events generically.

---

## Dependencies

- Config/env: `NOTESD_PORT` (hooks), `XDG_STATE_HOME`, `HOME`. No new config keys.
- Services: notesd on 127.0.0.1 (hooks degrade silently without it).
- Claude Code contract: `UserPromptSubmit` stdin/stdout shape (new for this repo); transcript JSONL 2.1.x.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `create_image` tool | `src/mcp/imageTools.ts:105-132` | def | mcp |
| `attach_image` tool | `src/mcp/imageTools.ts:227-253` | def | mcp |
| `ingestFromPath`, `attachFromPath`, `checkLocalImagePath` | `src/http/imageAccess.ts:182,259,224` | def | http |
| `ImageInputErrorCode` | `src/http/imageAccess.ts:42` | def | http |
| `toolImageDeps`, `toolAttachDeps` | `src/http/imageAccess.ts:55,208` | def | http |
| `locateChatImage`, `findChatImage`, `ingestChatImage` | `src/chat/images.ts:258,118,180` | def | chat |
| `dbChatUploadSource` | `src/embeddings/chatUploads.ts` | call (model for lookup) | embeddings |
| `similar_images` `upload_id` | `src/mcp/similarTools.ts:151-176,237` | call | mcp |
| "Images." / "Attaching." / "Similar images." paragraphs | `src/mcp/instructions.ts` | doc | mcp |
| image paragraph of `buildChatSystemPrompt` | `src/chat/prompt.ts` | doc | chat |
| `captionForToolUse` `create_image` / `attach_image` | `src/chat/status.ts:107-117` | call | chat |
| `NOTES_TOOL_NAMES`, `allowedChatTools` | `src/chat/status.ts:14-35,53` | def | chat |
| `OUR_SCRIPT`, `ourGroups`, `mergeHooks`, `removeHooks` | `scripts/claude-hooks.mjs` | def | scripts |
| hook file lists | `scripts/install.sh:110,255`, `scripts/uninstall.sh` | config | scripts |
| `isNotesPrompt`, `extractImages`, `findLatestImagePrompt` | `claude/hooks/lib/transcript.mjs` | def | hooks |
| `uploadImage`, `uploadIdFrom` | `claude/hooks/notes-paste.mjs:98,89` | def | hooks |
| `/n` skill Images section | `claude/skills/n/SKILL.md:185-205` | doc | skill |
| hook docs | `README.md:295-304,572-579,692,790,865` | doc | docs |
| tests touching these | see Discovered Related Files | test | tests |

---

## Impact Points (files that WILL need changes)

1. `src/http/imageAccess.ts` — `image_id` resolution + ingest/attach wrappers + new error codes (phase 1)
2. `src/mcp/imageTools.ts` — `image_id` input, XOR check, descriptions (phase 1)
3. `tests/unit/imageAccess.test.ts`, `tests/integration/images.mcp.int.test.ts`, `tests/integration/images.attach.int.test.ts` — new cases (phase 1)
4. `src/mcp/instructions.ts`, `src/chat/prompt.ts`, `src/chat/status.ts` + their unit tests (phase 2)
5. `claude/hooks/notes-prompt.mjs` (+ `.d.mts`), `claude/hooks/lib/transcript.mjs` (+ `.d.mts`), `scripts/claude-hooks.mjs` (+ `.d.mts`), `scripts/install.sh`, `scripts/uninstall.sh`, `claude/skills/n/SKILL.md` + hook/script unit tests (phase 3)
6. `tests/integration/prompt.hook.int.test.ts`, `scripts/verify-prompt-hook.mjs`, `package.json`, `README.md`, `docs/INSTALL.md`, `CHANGELOG.md` (phase 4)

---

## Risks recorded during analysis (planned mitigations are in the plan index)

- **Privacy of non-`/n` turns.** A hook on every prompt that uploads every image would copy screenshots from unrelated sessions into the notes store. Scope in the plan: the hook acts only when the submitted prompt is `/n`; on that prompt it back-fills images from ANY earlier turn of the same session. Sessions that never use `/n` capture nothing.
- **Disk growth.** `chat_images` originals are never deleted. Bounded by sha dedupe, ≤8 images and 20 MB each per `/n` prompt, a per-session memo (no re-upload), and `/n`-only scope.
- **Transcript lag.** The current prompt's entry may not be in the transcript at `UserPromptSubmit`. The hook polls briefly and, if the newest image is still unreadable, says so in the context instead of promoting an older image as "latest".
- **Id-space confusion.** `remove_image`/`similar_images(image_id)` take NOTE image ids; the new `image_id` on create/attach is a CHAT image id. Same `A-B32` shape, different tables. Tool descriptions must say so; an unknown id error must name the chat store.
- **Blocking.** `UserPromptSubmit` is synchronous: bounded wall-clock budget, immediate exit on non-`/n`.
- **Unverified Claude Code behaviour** (`UserPromptSubmit` payload, `additionalContext`, transcript timing): covered by an opt-in live script like `verify:paste-hook`.

**This document describes. The plan files prescribe.**
