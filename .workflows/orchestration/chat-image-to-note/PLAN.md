# Plan: Pasted chat image → note (wall chat + Claude Code `/n`)

**Slug:** chat-image-to-note
**Date:** 2026-10-31 12:40 (WIB)
**Analysis:** `docs/analyzer/20261031-122441-Q7MX_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-image-to-note`
**Branch:** `feature/chat-image-to-note` (base: `main` @ `f899b85`)
**Phases:** 4
**Status:** phases 1, 3/4 complete
**Coordinator:** —

---

## Why

Feature: turn a pasted chat image into a note, from the wall chat AND from Claude Code "/n please make that image as a new note then".

PROBLEM (observed, wall chat thread cd6e7f63, 2026-10-31): user pasted an image (chat image id G-0NC), asked "search similar image", then "please make that image as a new note then". Agent replied it could not: create_image/attach_image only accept a filesystem `path`, and a chat upload lives in the separate chat_images store (data dir chat-images/YYYY/MM/<id>.<ext>) with no path the agent can name.

DECIDED DESIGN (user approved):
1. Daemon: add an `image_id` input (chat-image id like G-0NC, case/dash tolerant) to create_image and attach_image (path XOR image_id). Daemon resolves it to the stored chat image file and runs the existing ingest (copy, sha dedupe -> returns existing note with created:false). Fixes wall chat: the wall agent already sees the G-id in context. Update src/mcp/instructions.ts, src/chat/status.ts captions, and the wall agent system prompt (src/chat/prompt.ts) so it uses image_id instead of asking for a path.
2. Claude Code, same turn (approach "a"): add a UserPromptSubmit hook for /n prompts that reads the newest transcript entry(ies), ingests pasted images into chat_images immediately (reuse the capture endpoint or a new one; idempotent with the later Stop-hook capture, no duplicate rows), and injects additionalContext like "Pasted image(s) this session: latest = G-xxx (paste #N), earlier = ...". Model then calls create_image(image_id=...).
3. Resolution default for "that image": this session's LATEST pasted image; explicit ids ("G-0NC") override.
4. Robustness: capture images from ANY user turn in the session that contains images (not only /n turns) so earlier pastes resolve to ids; keep size/count caps (MAX_IMAGES 8, 20MB). Hook failures must never block the prompt. Idempotency key must stay <claude_session>:<user_uuid>.

ASK: full analysis, plan set with phases, tests (vitest + hook tests), risks (privacy of capturing non-/n turns: confirm scope, disk growth, dedupe), and docs/CHANGELOG updates. Do not implement yet; produce the plan set.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | `image_id` (chat image id; path XOR image_id) on `create_image` and `attach_image`, same ingest and sha dedupe; wall agent prompt, MCP instructions, status captions use it | 1, 2 |
| R2 | `UserPromptSubmit` hook for `/n`: ingest pasted images into `chat_images` now, inject `additionalContext` with the ids; idempotent with the Stop capture | 3, 4 |
| R3 | "That image" = this session's latest pasted image; explicit id overrides | 2, 3 |
| R4 | Robustness: any earlier turn's images resolve; 8 images / 20 MB caps; never block the prompt; idempotency key unchanged | 3, 4 |
| R5 | Tests (vitest unit + integration, hook tests) and risk analysis | 1, 2, 3, 4 (each phase ships its tests; risks below) |
| R6 | Docs and CHANGELOG | 4 |

Phases 1, 2, 3 each serve R1/R2 plus their own tests; R5 is spread by design (every phase carries its tests), R3 spans the wall prompt text (2) and the hook's context text (3).

## Scope

**In scope:** `image_id` on the two MCP tools; wall-agent/MCP wording and captions; a `UserPromptSubmit` hook (`notes-prompt.mjs`) with install/uninstall/status registration; a transcript helper that enumerates every image-carrying human prompt; `/n` skill wording; tests; an opt-in live verify script; README, INSTALL, CHANGELOG.

**Out of scope:** a new HTTP endpoint (the existing `POST /api/chat/images` is reused); changing `/api/capture/claude-code` or the Stop hook's `/n`-only thread capture; any `chat_images` GC or retention; a `PreToolUse` rewrite for `create_image` (`pasted_image` on `create_image`); web UI changes; new DB migration; `remove_image` / `similar_images` `image_id` semantics (they stay NOTE image ids).

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of every phase (integration tests need Docker Postgres via `npm run test:int` and are run per phase where the phase adds them).
2. `create_image` / `attach_image` with `path` behave byte for byte as today; `image_id` is purely additive, and exactly one of `path` / `image_id` is required.
3. `image_id` is a CHAT image id. It is never looked up in the note-image space, and an unknown id is refused as "no pasted image X", never matched to a note image.
4. Idempotency keys unchanged: `chat_images.sha256` unique; capture thread key `<claude_session>:<user_uuid>`. The new hook must not create chat threads or messages.
5. Every hook always exits 0, writes only hook JSON to stdout (nothing on non-`/n` prompts), logs to `${XDG_STATE_HOME:-~/.local/state}/notes-capture/`, and never lets a failure block the prompt.
6. The new hook does no I/O (no transcript read, no network) for a prompt that is not `/n`.
7. Caps stay: ≤8 images per run, ≤20 MB each, ≤48 MB base64 total, png/jpeg/gif/webp only.
8. No secrets or note bodies in logs, fixtures or docs.

## Interface contracts (what the parallel planners must agree on)

**C1 (phase 1 → 2, 4): MCP tool shapes.**
- `create_image({ path?: string, image_id?: string, body?: string, origin? })`; `attach_image({ id: string, path?: string, image_id?: string, origin? })`. Exactly one of `path` / `image_id`; otherwise `isError` text `create_image refused (bad_arguments): give exactly one of path or image_id` (same wording with `attach_image`).
- `src/http/imageAccess.ts` exports `resolveChatImageFile(chat: {db: Db; dataDir: string}, rawId: string): Promise<{ id: string; absPath: string; originalName: string | null }>` (throws `ImageInputError('unknown_chat_image', 'no pasted image <id>. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt')` or `ImageInputError('not_on_this_machine', 'pasted image <ID> is stored on <host>, not on this machine')`), `ingestFromChatImage(img, chat, rawId, body, origin)` and `attachFromChatImage(img, chat, noteId, rawId)` returning the same shapes as the `...FromPath` functions. `ImageInputErrorCode` gains `'bad_arguments' | 'unknown_chat_image' | 'not_on_this_machine'`.
- Created note origin `source` is `'mcp'`, as for `path`.

**C2 (phase 3 → 2, 4): the `additionalContext` text** emitted by the hook for a `/n` prompt (exact wording is owned by phase 3's constant `CONTEXT_HEADER`/`buildContext`; phases 2 and 4 only rely on this shape):
```
Pasted images in this Claude Code session, oldest first: [Image #1] = G-AAA; [Image #2] = G-BBB; [Image #3] = G-0NC (latest).
"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].
To save one as a new note call create_image with image_id (never path); to add one to an existing note call attach_image with id and image_id; to search with one call similar_images with upload_id.
```
Header constant `CONTEXT_HEADER` = `Pasted images in this Claude Code session, oldest first: `; ids are joined by `; `, the line ends with `.`; ` (latest)` follows only the newest id and only when that id is the session's newest pasted image. Line 3 is `TOOLS_HINT`.

**Newest image not stored** (it never appeared in the transcript in time, its upload failed, or it is outside the caps) **while at least one older image was stored**: line 1 lists the stored ids with no ` (latest)` anywhere, and line 2 is replaced by `The latest pasted image ([Image #N]) could not be stored (it was not readable in time or its upload failed), so it has no id. If the user means that image, tell them it could not be stored and ask them to paste it again with the request; do not use an older image in its place.` (`[Image #N]` dropped when N is unknown).

**No output at all** (`runPrompt` → `null`, hook prints nothing) when the prompt is not `/n`, the session has no pasted images, the transcript is unreadable, or **no image at all could be stored** (e.g. daemon down).

**"Caught up" (transcript settled):** the transcript holds the current prompt once its **last human prompt carries every `[Image #N]` number typed in the `/n` prompt** among its paste ids (trivially true when the `/n` prompt has no placeholder). The hook polls for that ≤2.5 s; if it never happens, the largest typed N is reported as the missing latest image.

**C3 (phase 3): hook module surface** for tests: `notes-prompt.mjs` exports `runPrompt({input, env, fetchImpl, readText, sleep, now})` → hook output object or `null`, plus constants (`CONTEXT_HEADER`, `TOOLS_HINT`, `LOG_FILE = 'prompt.log'`, `MEMO_DIR = 'prompt-images'`, `TRANSCRIPT_WAIT_MS`, `TRANSCRIPT_POLL_MS`, `UPLOAD_BUDGET_MS`) and pure helpers; `notes-prompt.d.mts` declares them (typecheck of phase 4's integration test depends on it). `lib/transcript.mjs` exports `isNotesPromptText(text)` (`/n` after optional leading whitespace, or the slash-command XML) and `listImagePrompts(entries)` → `[{entry, images}]` for every human prompt with ≥1 base64 image, oldest first. State: `<XDG_STATE_HOME>/notes-capture/prompt.log` and `.../prompt-images/<session_id>.json` (failed uploads are never memoised).

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Daemon: `image_id` on create_image / attach_image | R1, R5 | `src/http`, `src/mcp` | 5 | — | NORMAL | `.workflows/plan/chat-image-to-note/phase-1.md` | P1-NOTES-A045 | — |
| 2 | Agent-facing text: instructions, wall prompt, captions | R1, R3, R5 | `src/mcp`, `src/chat` | 6 | 1 | NORMAL | `.workflows/plan/chat-image-to-note/phase-2.md` | P1-NOTES-A046 | — |
| 3 | Claude Code `UserPromptSubmit` hook + registration + skill | R2, R3, R4, R5 | `claude/hooks`, `scripts`, `claude/skills` | 12 | — | HARD | `.workflows/plan/chat-image-to-note/phase-3.md` | P1-NOTES-A047 | — |
| 4 | End-to-end tests, live verify script, docs, CHANGELOG | R2, R4, R5, R6 | `tests`, `scripts`, docs | 6 | 1, 2, 3 | NORMAL | `.workflows/plan/chat-image-to-note/phase-4.md` | P1-NOTES-A048 | — |

R2 is served by 3 (hook) and 4 (end-to-end proof); R1 by 1 (code) and 2 (words); phase 3 spans R2+R3+R4 because the hook's scan, caps, failure behaviour and context text are one module and cannot be split without a half-working hook.

### Phase 1 — Daemon: `image_id` on create_image / attach_image
**Satisfies:** R1, R5
**Owns:** `src/http/imageAccess.ts` (`resolveChatImageFile`, `ingestFromChatImage`, `attachFromChatImage`, new error codes), `src/mcp/imageTools.ts` (schemas, XOR check, descriptions that state the id-space), unit + integration tests for them.
**Does not touch:** `src/mcp/instructions.ts`, `src/chat/*`, hooks, scripts, docs.
**Exit criteria:** `create_image({image_id})` makes an image note from a chat image; same bytes again → `created:false` same note; `attach_image({id, image_id})` appends or returns `attached:false`; unknown / other-machine / both-or-neither arguments are refused with the C1 wording; `path` calls unchanged; typecheck and unit and integration tests green.

### Phase 2 — Agent-facing text: instructions, wall prompt, captions
**Satisfies:** R1, R3, R5
**Owns:** `src/mcp/instructions.ts` (Images/Attaching paragraphs), `src/chat/prompt.ts` (picture paragraph: use `image_id`; "that image" = the id the owner names, else the picture in `<message>`, else the one in `<reply_to>`, else the latest `[image upload:ID]` in `<chat_history>`; never ask for a path), `src/chat/status.ts` (captions when input has `image_id`), and `tests/unit/{mcp.instructions,chat-prompt,chat-status}.test.ts`.
**Does not touch:** tool schemas, hooks, docs.
**Exit criteria:** instructions and wall prompt name `image_id` and the chat-id space and drop "ask for a path" for pasted images; captions distinguish a pasted-photo save; unit tests green.

### Phase 3 — Claude Code `UserPromptSubmit` hook + registration + skill
**Satisfies:** R2, R3, R4, R5
**Owns:** `claude/hooks/notes-prompt.mjs` (+ `.d.mts`), `claude/hooks/lib/transcript.mjs` (+ `.d.mts`: `listImagePrompts`), per-session memo, `scripts/claude-hooks.mjs` (+ `.d.mts`: third group, regex), `scripts/install.sh` / `uninstall.sh` file lists and messages, `claude/skills/n/SKILL.md` (use `create_image(image_id)` from the hook context), and `tests/unit/hooks/notesPrompt.test.ts`, `tests/unit/hooks/transcript.test.ts`, `tests/unit/scripts/claudeHooks.test.ts`.
**Does not touch:** the daemon, `notes-capture.mjs` behaviour, `notes-paste.mjs` (imports `uploadImage` from it, does not edit it), docs, CHANGELOG.
**Exit criteria:** hook returns the C2 context for `/n` prompts with images in any session turn, nothing otherwise; uploads newest-first within a time budget; memo prevents re-upload; a failure that leaves no image stored returns null and logs, and a newest image that could not be stored is reported in the context (never replaced by an older one as "latest"); installer registers exactly three groups idempotently and uninstall removes them; unit tests green.

### Phase 4 — End-to-end tests, live verify script, docs, CHANGELOG
**Satisfies:** R2, R4, R5, R6
**Owns:** `tests/integration/prompt.hook.int.test.ts` (hook → real daemon → `chat_images`; then Stop capture of the same turn → same ids, no duplicate rows or threads; daemon down → `null`; then `create_image({image_id})` → note, again → `created:false`), `scripts/verify-prompt-hook.mjs` + `package.json` (`verify:prompt-hook` script), `README.md`, `docs/INSTALL.md`, `CHANGELOG.md`. Sole owner of README/INSTALL/CHANGELOG/`package.json` in this set.
**Does not touch:** any source under `src/` or `claude/` (a defect found here is fixed in the owning phase's files only if a phase plan allows; otherwise it is recorded).
**Exit criteria:** integration test green on Docker Postgres; docs say three hooks, `image_id`, the `/n`-only scope, the state files and the privacy/disk notes; CHANGELOG `[Unreleased]` entries (Added: `image_id`, prompt hook; Changed: hooks count).

## Risks and mitigations

| Risk | Mitigation (where) |
|---|---|
| **Privacy: capturing images of non-`/n` turns.** A per-prompt capture would copy unrelated screenshots into the notes store. | Scope decided: the hook acts ONLY on `/n` prompts; on one it back-fills images from any earlier turn of the same session. Non-`/n` prompts exit before any I/O (inv. 6). Sessions that never use `/n` store nothing. Documented in README (phase 4). |
| **Disk growth.** `chat_images` originals are never pruned. | sha dedupe; ≤8 images, ≤20 MB each per run; per-session memo prevents re-upload; `/n`-only scope. No GC added (out of scope); documented. |
| **Duplicate rows / threads.** | Hook uploads through the sha-deduped `POST /api/chat/images`; Stop capture re-ingests the same bytes → same ids; thread key unchanged. Proven by phase 4's integration test. |
| **Transcript lag at `UserPromptSubmit`.** | Poll ≤2.5 s until the last human prompt carries every `[Image #N]` typed in the `/n` prompt; if it never does, the context says the latest image could not be stored rather than naming an older image "latest" (C2), or prints nothing when no image was stored at all. Live check by `verify:prompt-hook`. If the live check shows the entry is never present, the follow-up is a `PreToolUse` rewrite, recorded in README, not built now. |
| **Blocking the prompt.** | Non-`/n`: instant. `/n`: upload budget 8 s, hook timeout 20 s, newest image first, always exit 0. |
| **Id-space confusion** (`image_id` here vs note-image ids elsewhere). | Tool descriptions, instructions and error text name the chat store (inv. 3, C1). |
| **Unverified `UserPromptSubmit` contract.** | Opt-in `verify:prompt-hook` (phase 4); unit tests pin the output shape. |

## Reconciliation Log

Ledger (round 1): no symbol is deleted or renamed by any phase. Created symbols have one owner each (phase 1: `image_id` schemas, `resolveChatImageFile`, `ingestFromChatImage`, `attachFromChatImage`, `oneImageSource`, `CHAT_IMAGE_ID_HINT`, new `ImageInputErrorCode`s; phase 2: private `hasImageId`; phase 3: `notes-prompt.mjs`/`.d.mts`, `isNotesPromptText`, `listImagePrompts`, `PROMPT_TIMEOUT_S`, third `ourGroups` key; phase 4: test file, verify script, npm script). File owners are disjoint: no file is modified by two phases (README/INSTALL/CHANGELOG/`package.json` only phase 4; `SKILL.md`, `scripts/*.sh`, `scripts/claude-hooks.*` only phase 3; `src/chat/*`, `src/mcp/instructions.ts` only phase 2; `src/http/imageAccess.ts`, `src/mcp/imageTools.ts` only phase 1). File counts match the plans (5 / 6 / 12 / 6). Every analysis Impact Point (1-6) and Reference List row has an owner. Dependencies point backward only (2→1, 4→1,2,3; 3 independent). Every phase builds green alone: phase 2 only edits strings and a switch, phase 3 calls no daemon tool, phase 4 runs last.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Index C2 said "if the newest image could not be stored the text says so" without a condition; phase 3's `buildContext` returns `null` when nothing was stored, and phase 4 asserts `null` for daemon-down | Contract drift (index vs phase 3/4) | Index C2 now states: the "could not be stored" line appears only when ≥1 older image was stored; nothing stored → no output. Phase 3 contract and phase 4 Requires/Handoffs say the same. See Decisions D1 |
| 2 | "Caught up" left vague in the index; phase 3 settled it as "last human prompt carries every typed `[Image #N]`" | Contract drift | Index C2 and Risks now carry phase 3's definition; phase 4 Requires, verify-script header and README limitation sentence worded to match. Decisions D2 |
| 3 | Phase 3 exit criterion "every failure path returns null" contradicts its own code (upload of the newest fails while an older one is stored → context, not null) | Contract drift | Phase 3 and index exit criteria reworded: no-image-stored failures return null; a missing newest image is reported in the context |
| 4 | Phase 4 Requires described the `/n` test as regex `^\/n(?:\s|$)` on `input.prompt`; phase 3's `isNotesPromptText` also accepts leading whitespace and the slash-command XML | Contract drift (phase 4 quoted a narrower contract) | Phase 4 Requires now cites `isNotesPromptText`; its test inputs (`'  please /n later'`, `'/new idea'`) are still non-`/n` under phase 3's rule, no assertion changes |
| 5 | Phase 4 left two conditional notes ("if phase 3's context differs / chooses differently, the reconciler updates…") | Unmet assumption check | Verified against phase 3: `CONTEXT_HEADER`, `[Image #N] = ID`, `; ` joiner, ` (latest)`, `TOOLS_HINT` naming `create_image`/`image_id`, `prompt.log`, `prompt-images/`, failed uploads not memoised, `notes-prompt.d.mts` typing `runPrompt` all match phase 4's assertions. Conditional notes replaced by confirmations |
| 6 | Index phase 2 Owns described "that image" as current message → latest in history; phase 2 also uses `<reply_to>` | Contract drift (index vs plan) | Kept phase 2's precedence (named id > `<message>` > `<reply_to>` > latest in `<chat_history>`); index Owns updated. Decisions D3 |
| 7 | `package.json` edited by phase 4 but missing from the index's phase 4 Owns | Gap (ownership record) | Added to phase 4 Owns; no other phase touches it |
| 8 | Id-space and refusal wording across phases 1/2/3/4 | Consistency check | Consistent, no edit: phase 1 refusal "…in the pasted-images note of a Claude Code /n prompt", phase 2 "the pasted-images note a /n prompt carries", phase 3 skill "a note that starts 'Pasted images in this Claude Code session'", phase 4 README/CHANGELOG "pasted-image id … not a photo id" / "refused as 'no pasted image'". Phase 2's "image_id elsewhere means a note image" matches phase 1's "NOT a note image id" |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Capture scope: "images from ANY user turn" vs privacy of non-`/n` prompts | trigger only on `/n`; on it, ingest images from every human turn of the session (newest 8). Meets the stated goal (earlier pastes resolve) without per-prompt capture | 5: raw input (item 4 intent + the ASK's "confirm scope") |
| Transport for the hook's upload: reuse the capture endpoint, or a new one | reuse `POST /api/chat/images` (`source=claude_code`): per-image, sha-deduped, already used by `notes-paste.mjs`; the capture endpoint would create a thread and a message | 5: raw input allowed either ("reuse … or a new one"); 6: convention |
| Parameter name `image_id` vs the existing `upload_id` convention of `similar_images` for the same id space | `image_id`, as the approved design says; descriptions and error text state it is a chat image id | 5: user's decided design |
| Hook imports `uploadImage` from `notes-paste.mjs` instead of extracting a shared module | import (no edit to a working hook) | 6: convention (no refactor of shipped code) |
| Phase 3 depends on phase 1? | no: the hook's text names `image_id` but nothing in phase 3's code or tests calls the daemon tool; phase 4 proves them together | 6: only true edges |
| Launch of execution | not launched: the user said "Do not implement yet; produce the plan set" | 5: raw input (equivalent to `--no-orchestrate`) |
| D1. Hook output when NO image could be stored (daemon down, every upload failed): a "could not be stored" context, or nothing | nothing (`runPrompt` → `null`, failure logged to `prompt.log`); the "latest could not be stored" line appears only when at least one older image was stored. A daemon-down session has no ids to offer, and the `/n` skill already says "with no such note there is no id: ask the user to paste again" | 2: phase exit criteria (phase 4 "survives a dead daemon" / phase 3) + 3: code blocks (phase 3 `buildContext` returns null on empty; phase 4 asserts `toBeNull()`); index C2 prose edited to match |
| D2. When the transcript counts as holding the current prompt | the LAST human prompt carries every `[Image #N]` number typed in the `/n` prompt (trivially settled when none is typed); not "the newest image-carrying prompt has ≥ placeholder-count images" | 3: phase 3 code block (`imagesSettled`) and its tests; it is the stricter reading and is safe because paste ids are a per-session counter (checked on real transcripts) |
| D3. Wall prompt precedence for "that image" | named id > picture in `<message>` (last one if several) > picture in `<reply_to>` > most recent `[image upload:ID]` in `<chat_history>` | 3: phase 2 code block; consistent with R3 ("latest", explicit id overrides) since the wall agent sees `<reply_to>` pictures as the owner's explicit pointer |

## Open Questions

None.

## Rollback

Per phase: `git revert` the phase's commit (phases 1 and 2 are daemon/text only; phase 3 is additive files plus one regex/group list; phase 4 is tests and docs). Whole set: revert the merge. Operationally: `scripts/uninstall.sh` removes the new hook entry from `~/.claude/settings.json`; chat images already stored stay (harmless, sha-deduped, no migration to undo).

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/CHAT_IMAGE_TO_NOTE_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows (phases 1 and 3 run together):

    /analyze-orchestrator -f docs/plans/CHAT_IMAGE_TO_NOTE_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/CHAT_IMAGE_TO_NOTE_PLAN.md
