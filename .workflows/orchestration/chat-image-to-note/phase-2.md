# Phase 2: Agent-facing text: instructions, wall prompt, captions

**Plan set:** `CHAT_IMAGE_TO_NOTE_PLAN.md`
**Analysis:** `docs/analyzer/20261031-122441-Q7MX_code_analyzer.md`
**Satisfies:** R1 (agents use `image_id` instead of asking for a path), R3 ("that image" = latest pasted image, explicit id overrides), R5 (unit tests for this phase)
**Depends on:** Phase 1 (the text names the `image_id` input phase 1 adds; nothing in this phase's code or tests calls the tool, so the tree also builds and passes without phase 1, but the words are only true once it has landed)
**Difficulty:** NORMAL
**Package:** `src/mcp`, `src/chat`

---

## Goal

The MCP server instructions, the wall agent's system prompt and the wall's tool-status captions all know that `create_image` and `attach_image` take a pasted image's id as `image_id`. A wall agent asked to "make that image a note" calls `create_image({image_id})` with the id of the picture in the current message (else the reply target, else the latest `[image upload:ID]` in history) instead of asking for a path, and the panel shows "saving the pasted photo as a note" / "attaching the pasted photo" while it runs. The id-space difference (pasted-image id vs note-image id) is stated once in the instructions.

## Interface Contract

**Deletes:** the sentence `To save a local image file (for example a screenshot path you have), call create_image with its absolute path and optional body text; it becomes a new note, the file is copied, not moved, and saving a file that already lives in a note returns that note.` from the Images paragraph of `buildInstructions` (`src/mcp/instructions.ts:49`) — replaced, see Step 1. No code symbol is deleted.
**Renames:** none
**Creates:** private helper `hasImageId(input: unknown): boolean` in `src/chat/status.ts` (not exported)
**Signature changes:** none. `buildInstructions`, `buildChatSystemPrompt`, `captionForToolUse` keep their signatures.
**Behaviour changes:**
- `captionForToolUse('mcp__notes__create_image', {image_id: <non-empty string>})` -> `'saving the pasted photo as a note'` (was `'saving a note'`).
- `captionForToolUse('mcp__notes__attach_image', {id, image_id: <non-empty string>})` -> `'attaching the pasted photo'` (was `'attaching a photo'`).
- Every other input (including `path`, `{}`, `null`, empty `image_id`) keeps today's caption. `create`, `remove_image`, `restore_image`, `similar_images` captions are unchanged even when their input has `image_id`.
**Requires (from earlier phases):** Phase 1: `create_image({ path?, image_id?, body?, origin? })` and `attach_image({ id, path?, image_id?, origin? })`, exactly one of `path`/`image_id`; result shapes `{ note, created }` / `{ note, attached }` unchanged (C1).
**Relies on (from phase 3, wording only):** the `/n` hook injects a context note naming pasted images as `[Image #N] = G-xxx` with a "(latest)" marker (C2). The instructions refer to it generically as "the pasted-images note the /n prompt carries"; no exact phase 3 string is quoted, so phase 3 may word its header freely.
**Leaves alone (owned by others):** `src/mcp/imageTools.ts`, `src/http/imageAccess.ts` and tool descriptions/schemas (Phase 1); `claude/hooks/*`, `scripts/*`, `claude/skills/n/SKILL.md` (Phase 3); `README.md`, `docs/INSTALL.md`, `CHANGELOG.md`, integration tests (Phase 4). The `Similar images.` paragraph of the instructions is not edited.

## Files

| File | Action | What changes |
|---|---|---|
| `src/mcp/instructions.ts` | modify | line 49 (`Images.` paragraph): replace the create_image-by-path sentence with path-or-image_id, pasted-image id space, "that image" = latest, never ask for a path; line 51 (`Attaching.` paragraph): add `attach_image(id, image_id)` and the note-image meaning of `remove_image(image_id)` |
| `src/chat/prompt.ts` | modify | line 28 (picture paragraph): append how to save/attach a pasted image with `image_id`, which picture "that image" is, never ask for a path |
| `src/chat/status.ts` | modify | lines 85-129: add `hasImageId`, split `create` / `create_image`, image_id-aware captions for `create_image` and `attach_image`, docstring |
| `tests/unit/mcp.instructions.test.ts` | modify | lines 62-73: Attaching test also expects `attach_image(id, image_id)`; new Images-paragraph test after line 73 |
| `tests/unit/chat-prompt.test.ts` | modify | new test after line 85 |
| `tests/unit/chat-status.test.ts` | modify | lines 46-55: add image_id / path rows to the caption table |

No other file pins the edited strings: `grep` over `src tests web claude` for `attach_image(id, path)`, `To save a local image file`, `saving a note`, `attaching a photo`, `similar_images with upload_id` finds only these three sources and these three tests (callers `src/chat/agent.ts:271,341` and `src/mcp/server.ts:15` only call the functions).

## Implementation Steps

### Step 1: Images and Attaching paragraphs of the MCP instructions
**File:** `src/mcp/instructions.ts:49` and `src/mcp/instructions.ts:51`
**Change:** Replace the two array elements at lines 49 and 51 in full. The Images paragraph keeps every sentence up to and including `... taken then).` and the trailing `available: false ...` sentence; only the create_image sentence in between is replaced. The Attaching paragraph changes its first `attach_image` sentence and adds the id-space clause to `remove_image`. Keep `Images.` and `Attaching.` as the paragraph openings (tests split on them), and keep paragraph order unchanged.
**Code:** (line 49, whole element)
```ts
    `Images. A note can hold several images: photos or screenshots saved on the laptop that stored them. Every note returned by get/list/search has an images array, empty for text notes, otherwise one entry per image in the order they were added, each {id, note_id, position, mime, width, height, bytes, taken_at, original_name, host, available, urls}. An image id looks like a note id; a note's first image shares the note's id. To look at pictures, find the ids first, then call view_images with up to 8 note ids or image ids: a note id shows every image of that note, at most 8 images come back per call, and a last line lists the image ids left for the next call. "Show me pictures I saved on 30 oct" means list with has_image: true (notes with at least one image) and from/to for that day, then view_images on the ids. "Photos taken last week" uses taken_from/taken_to (the camera's EXIF date; a note matches when any of its images was taken then). To save a picture as a new note, call create_image with exactly one of path or image_id, plus optional body text; the picture is copied, not moved. path is the absolute path of a local image file (for example a screenshot path you have). image_id is the id of a pasted image: a picture the user pasted into the wall chat, named [image upload:ID] in the message, or into this Claude Code conversation, named in the pasted-images note a /n prompt carries. When the user asks to save "that image" or "this image", use the latest pasted image unless they name another id or image number; never ask the user for a path to a picture they pasted. Saving a picture that already lives in a note returns that note with created: false. Pasted image ids look like note ids (G-0NC) but live in their own store: only create_image and attach_image take a pasted image's id as image_id; on remove_image, restore_image and similar_images, image_id means an image already in a note, and similar_images takes a pasted image as upload_id. available: false means that image's file lives on another machine (host): the note's text is still there, but that picture cannot be viewed here.`,
```
(line 51, whole element)
```ts
    `Attaching. A note can hold several images, in attach order; each entry of a note's images has its own id (image ids look like note ids; the first image of a note saved from a picture has the note's own id). attach_image(id, path) adds a local image file to an existing note, and attach_image(id, image_id) adds a pasted image to it (the same pasted image ids create_image takes); either way the picture is copied, not moved. If the same file already lives in a note (that one or another), nothing is copied and that note comes back with attached: false, so tell the user where the picture already is. remove_image(image_id) takes one image out of its note (image_id here is the id of an image in a note, never a pasted image): it is soft, the image goes to the recycle bin with its file untouched, and restore_image(image_id) puts it back at its old position (restoring its note too if the note was deleted). Nothing you can call deletes a note or an image permanently; only the user can, from the recycle bin in the web page.`,
```
**Impact:** Changes the text every MCP client (Claude Code sessions, the wall agent) reads at `initialize`. Still contains `attach_image(id, path)`, `remove_image(image_id)`, `restore_image(image_id)`, `attached: false`, `soft`, `old position`, `copied, not moved`, `Nothing you can call deletes a note or an image permanently` (existing test at `tests/unit/mcp.instructions.test.ts:62-73` stays green). Does not contain `7317` (port test at line 127 stays green). The `Similar images.` paragraph, which already explains `upload_id` vs `image_id` for `similar_images`, is untouched.

### Step 2: Picture paragraph of the wall agent's system prompt
**File:** `src/chat/prompt.ts:28`
**Change:** Replace the array element at line 28 in full: the existing text is kept verbatim and four sentences are appended after `... say which ones really match and why.`. Order of precedence for "that image": the id the owner names; else the picture in `<message>` (the last one when it holds several and the owner does not say which); else the one in `<reply_to>`; else the most recent `[image upload:ID]` in `<chat_history>`. The text must not contain "markdown link" or "bare URL" (test at `tests/unit/chat-prompt.test.ts:72-74`).
**Code:** (line 28, whole element)
```ts
    `To look at pictures, find the notes with images first (list with has_image, or search), then call view_images with their note ids (each note id shows every image of that note, up to 8 images per call; image ids work too) and comment on what you actually see. A note may also hold files that are not pictures: you see each one's name, type and size in the note's files list but cannot open them, and you cannot attach files. Images the owner pastes into the chat bar come with their message and are named in its text as [image upload:ID]. To find photos like one of them, call similar_images with upload_id set to that ID (image_id for a picture already in a note, query for words such as "red top in a car"), then call view_images on the top hits and say which ones really match and why. When the owner asks to keep a pasted picture as a note ("make that image a note"), call create_image with image_id set to its ID and, if they gave any, body text; to add it to an existing note, call attach_image with that note's id and image_id set to its ID. "That image" is the one whose ID the owner names; otherwise the picture in <message> (the last one if it holds several), otherwise the one in <reply_to>, otherwise the most recent [image upload:ID] in <chat_history>. Never ask the owner for a file path to a picture they pasted: its ID is all the tools need. If the picture already lives in a note, the tool returns that note (created: false, or attached: false for attach_image): tell the owner which note holds it.`,
```
**Impact:** Wall agent behaviour only (`src/chat/agent.ts:341`). The section opening and every phrase the existing tests check (`[image upload:ID]`, `similar_images with upload_id`, `then call view_images on the top hits`, `files that are not pictures`, `cannot open them`) are kept. The general rule at line 26 ("Do not create a note unless the owner asks for one") still applies: the new text only fires when the owner asks.

### Step 3: Captions that tell a pasted-photo save apart
**File:** `src/chat/status.ts:85-129`
**Change:** Add a private `hasImageId` helper after `connectorCaption` (after line 83), update the `captionForToolUse` docstring (lines 85-88), split `case 'create': case 'create_image':` (lines 109-111) so `create` keeps `'saving a note'` and `create_image` chooses on `image_id`, and make `attach_image` (lines 120-121) choose on `image_id`. Replace lines 85-129 with:
**Code:**
```ts
/** True when a tool input carries a non-empty `image_id` string (a pasted chat image on create_image / attach_image). */
function hasImageId(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const imageId = (input as { image_id?: unknown }).image_id;
  return typeof imageId === 'string' && imageId.trim() !== '';
}

/**
 * The caption for one top-level `tool_use` block, or null for a tool the panel does not name.
 * `input` is the block's raw input; only `ids` (get, view_images) and `image_id` (create_image,
 * attach_image: a pasted chat image rather than a file path) are read.
 */
export function captionForToolUse(name: string, input: unknown): string | null {
  if (name === 'WebSearch') return 'searching the web';
  if (name === 'WebFetch') return 'reading a web page';
  if (!name.startsWith(MCP_PREFIX)) return null;
  const tool = name.slice(MCP_PREFIX.length);
  switch (tool) {
    case 'search':
    case 'list':
    case 'tags':
      return 'searching notes';
    case 'related':
      return 'finding related notes';
    case 'similar_images':
      return 'finding similar photos';
    case 'get':
      return counted(idCount(input), 'reading a note', (n) => `reading ${n} notes`, 'reading notes');
    case 'view_images':
      return counted(idCount(input), 'looking at a photo', (n) => `looking at ${n} photos`, 'looking at photos');
    case 'revisions':
      return 'reading history';
    case 'create':
      return 'saving a note';
    case 'create_image':
      return hasImageId(input) ? 'saving the pasted photo as a note' : 'saving a note';
    case 'update':
    case 'append':
    case 'revert':
      return 'editing a note';
    case 'delete':
      return 'deleting a note';
    case 'restore':
      return 'restoring a note';
    case 'attach_image':
      return hasImageId(input) ? 'attaching the pasted photo' : 'attaching a photo';
    case 'remove_image':
      return 'removing a photo';
    case 'restore_image':
      return 'restoring a photo';
    default:
      return connectorCaption(tool);
  }
}
```
**Impact:** Captions for path calls and for `{}` unchanged. `NOTES_TOOL_NAMES` and `allowedChatTools` untouched (still 18 notes tools). The web panel renders whatever string arrives; no web test pins these captions.

### Step 4: Instructions unit tests
**File:** `tests/unit/mcp.instructions.test.ts:62-73` (modify) and new test inserted after line 73
**Change:** Replace the Attaching test (lines 62-73) with the version below, and insert the new Images test right after it (before the `Files` test at line 75).
**Code:**
```ts
  it('has one Attaching paragraph: attach_image copies and dedupes, remove_image is soft, restore_image undoes it', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Attaching.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of [
      'attach_image(id, path)',
      'attach_image(id, image_id)',
      'remove_image(image_id)',
      'restore_image(image_id)',
      'attached: false',
      'soft',
      'old position',
    ]) {
      expect(p).toContain(word);
    }
    expect(p).toContain('copied, not moved');
    expect(p).toContain('never a pasted image');
    expect(p).toContain('Nothing you can call deletes a note or an image permanently');
  });

  it('has one Images paragraph: create_image takes path or a pasted image_id, "that image" is the latest, never ask for a path', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Images.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('call create_image with exactly one of path or image_id');
    expect(p).toContain('[image upload:ID]');
    expect(p).toContain('/n prompt');
    expect(p).toContain('use the latest pasted image unless they name another id');
    expect(p).toContain('never ask the user for a path to a picture they pasted');
    expect(p).toContain('created: false');
    expect(p).toContain('copied, not moved');
    // the id-space note: pasted ids only on create_image/attach_image; image_id elsewhere is a note image
    expect(p).toContain('only create_image and attach_image take a pasted image');
    expect(p).toContain('on remove_image, restore_image and similar_images, image_id means an image already in a note');
    expect(p).toContain('similar_images takes a pasted image as upload_id');
    expect(p).not.toContain('To save a local image file');
  });
```
**Impact:** Pins the new wording; the old Attaching expectations are a subset of the new ones.

### Step 5: Wall prompt unit test
**File:** `tests/unit/chat-prompt.test.ts`, new test inserted after line 85 (after `tells the agent how pasted images appear ...`)
**Code:**
```ts
  it('saves or attaches a pasted image by its ID, resolves "that image", and never asks for a path', () => {
    expect(prompt).toMatch(/call create_image with image_id set to its ID/);
    expect(prompt).toMatch(/call attach_image with that note's id and image_id set to its ID/);
    expect(prompt).toContain('"That image" is the one whose ID the owner names');
    expect(prompt).toContain('otherwise the picture in <message>');
    expect(prompt).toContain('otherwise the most recent [image upload:ID] in <chat_history>');
    expect(prompt).toMatch(/Never ask the owner for a file path to a picture they pasted/);
    expect(prompt).toMatch(/created: false, or attached: false for attach_image/);
  });
```
**Impact:** none beyond pinning the text.

### Step 6: Caption unit tests
**File:** `tests/unit/chat-status.test.ts:46-55`
**Change:** In the first `it.each` table, replace the rows at lines 47 and 53 with the block below (the original two rows are kept as the first row of each group).
**Code:** (replaces line 47 `[n('create_image'), {}, 'saving a note'],`)
```ts
    [n('create_image'), {}, 'saving a note'],
    [n('create_image'), { path: '/tmp/a.png' }, 'saving a note'],
    [n('create_image'), { image_id: 'G-0NC' }, 'saving the pasted photo as a note'],
    [n('create_image'), { image_id: 'g0nc', body: 'receipt' }, 'saving the pasted photo as a note'],
    [n('create_image'), { image_id: '' }, 'saving a note'],
    [n('create_image'), null, 'saving a note'],
    [n('create'), { image_id: 'G-0NC' }, 'saving a note'],
```
(replaces line 53 `[n('attach_image'), { id: 'A-B32', path: '/tmp/a.png' }, 'attaching a photo'],`)
```ts
    [n('attach_image'), { id: 'A-B32', path: '/tmp/a.png' }, 'attaching a photo'],
    [n('attach_image'), { id: 'A-B32', image_id: 'G-0NC' }, 'attaching the pasted photo'],
    [n('attach_image'), { id: 'A-B32', image_id: '   ' }, 'attaching a photo'],
```
The existing `[n('similar_images'), { image_id: 'A-B32' }, 'finding similar photos']` and `[n('remove_image'), { image_id: 'C-D54' }, 'removing a photo']` rows stay and now also prove that `image_id` on those tools does not change their captions.
**Impact:** none beyond pinning behaviour.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/mcp.instructions.test.ts tests/unit/chat-prompt.test.ts tests/unit/chat-status.test.ts`, then `npm test` (full unit suite; invariant 1)
**Manual check:** `npx tsx -e "import('./src/mcp/instructions.ts').then(m=>console.log(m.buildInstructions('Asia/Jakarta')))"` and read the Images/Attaching paragraphs once for flow; optionally, with phase 1 landed and the daemon running, paste an image in the wall chat and ask "make that image a note": the panel shows "saving the pasted photo as a note" and the agent answers with a new note id without asking for a path.
**Exit criteria (from the index):** instructions and wall prompt name `image_id` and the chat-id space and drop "ask for a path" for pasted images; captions distinguish a pasted-photo save; unit tests green. Concretely: the three test files pass, `npm run typecheck` and `npm test` pass, and `grep -n "To save a local image file" src/` returns nothing.

## Handoffs

- **Phase 1 (R1):** the `create_image` / `attach_image` tool descriptions (`src/mcp/imageTools.ts:105-132,227-253`) must state the same id-space rule ("image_id is a pasted chat image id, as in [image upload:ID]; not a note image id") so the description and these instructions agree. The refusal text `no pasted image <id>. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt` (C1) matches this phase's phrase "the pasted-images note a /n prompt carries"; keep it that way.
- **Phase 3 (R2, R3):** `claude/skills/n/SKILL.md` Images section should say the same thing for Claude Code: use `create_image(image_id)` from the hook's context, "that image" = the one marked latest. The instructions here only say "the pasted-images note a /n prompt carries"; if phase 3 also wants non-`/n` sessions mentioned, that is the skill's job, not this text.
- **Phase 4 (R6):** README tool table (~l.692) and CHANGELOG should mention the new captions only if they list captions today; the `image_id` wording in README should mirror Step 1's id-space sentence.
- Noticed, not done (out of scope): the `Similar images.` paragraph could cross-reference create_image for "save it" follow-ups; left as is to avoid widening the diff.

## Rollback

`git revert` this phase's commit. It touches only three source strings/one switch and three unit tests; no schema, data or config change, so reverting is safe in any order relative to phases 1, 3, 4 (the tools still accept `image_id` after a revert; the agents just stop being told about it).
