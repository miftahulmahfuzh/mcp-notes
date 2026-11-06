> Adopted from `.workflows/orchestration/dword-connector/PLAN.md` phase 6. Source: `.workflows/plan/dword-connector/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: Wall chat

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R6 — the user can run the same `/v`/`/j` vocabulary and journal flow from the wall's
chat bar, in plain language, with the exchange captured into chat history like any other turn
**Depends on:** Phase 3, Phase 4, Phase 5
**Difficulty:** NORMAL
**Package:** `src/chat`

---

## Goal

After this phase, the wall chat bar recognizes a natural-language vocabulary or journal request
("what does perch mean", "save this saying: ...") and runs the same
lookup-or-find-similar-then-add flow as `/v`/`/j`, through the four curated dword tools, which are
already on the chat agent's allow-list once phases 1/3/4 land. The status panel shows a distinct
caption for each of the four dword actions instead of a generic one. No new capture-path code is
needed — a dword exchange already lands in chat history exactly like any other wall turn, which
this phase confirms by reading the real code path rather than assuming it.

**Load-bearing finding, stated up front:** the phase index describes this phase as adding "a
`DWORD_TOOL_NAMES` array ... spliced into `allowedChatTools()`." Reading `src/chat/status.ts` and
`tests/unit/chat-status.test.ts` in full shows that would be wrong, not just unnecessary: `dword`
is a `CONNECTOR_SYSTEMS` member (added by Phase 1), and `CONNECTOR_TOOL_NAMES.dword` holds all six
of its tool names once Phases 1/3/4 land (`dword_schema`, `dword_sql`, plus the four curated
names) — exactly the same shape `expenses`/`runs`/`seer` already use. `allowedChatTools()` already
spreads `ALL_CONNECTOR_TOOL_NAMES`, which flattens every system in `CONNECTOR_SYSTEMS`, so all six
dword tool names reach the allow-list with **zero changes to the function body**. Spreading a
second, separate `DWORD_TOOL_NAMES` array into the same return value would list the four curated
names twice and fail the existing invariant test
`expect(new Set(tools).size).toBe(tools.length)` (`tests/unit/chat-status.test.ts:15`). This plan
follows the code, not the index's phrasing: it still introduces a `DWORD_TOOL_NAMES` constant
(the four curated names only), but uses it solely to give those four tools their own status
caption and to drive this file's own tests — never spread into `allowedChatTools()`'s return
array. See **Principles applied** (Laziness protocol / Subtract before you add).

## Interface Contract

**Creates:**
- `DWORD_TOOL_NAMES`, `DwordToolName` (`src/chat/status.ts`) — the four curated dword tool names,
  used only for captions and tests, never spread into `allowedChatTools()`.
- A new paragraph in `buildChatSystemPrompt`'s `sections` array (`src/chat/prompt.ts`).
- `## Wall chat (phase 6)` H2 section appended to
  `.claude/skills/verify-notesd/features/dword.md` (created by Phase 5; see **Handoffs** if its
  actual structure differs from the flat four-section layout assumed here).

**Modifies:**
- `captionForToolUse` (`src/chat/status.ts`) — adds 4 `switch` cases (`dword_vocab_lookup`,
  `dword_vocab_add`, `dword_journal_find_similar`, `dword_journal_add`) before the generic
  `default: return connectorCaption(tool);` fallback. `dword_schema`/`dword_sql` are **not**
  touched — they keep the generic one-caption-per-system fallback, same as every other connector's
  `_schema`/`_sql` tools.
- Doc comments on `allowedChatTools()` and the file header (counts: 15 → 21 connector tools).
- `tests/unit/chat-status.test.ts` — updated counts and caption assertions.
- `tests/unit/chat-prompt.test.ts` — new assertions on the dword paragraph.

**Does NOT modify:** `allowedChatTools()`'s function body (confirmed unnecessary — see Goal);
`src/http/capture.ts`, `src/http/api.ts`, `src/chat/service.ts` (read, not changed — see Goal and
Implementation Steps for why); `src/connectors/*`; `src/mcp/dword*Tools.ts`; `src/dword/*`;
`claude/skills/v/SKILL.md`, `claude/skills/j/SKILL.md`; `.claude/skills/verify-notesd/features/README.md`.

**Requires (from earlier phases, assumed landed):**
- Phase 1: `'dword'` in `CONNECTOR_SYSTEMS`; `SYSTEM_META.dword.caption` set (assumed
  `'reading daily-words'`, per design §5.1, unflagged by the analysis's R1 corrections — see
  **Assumptions**).
- Phases 1/3/4: `CONNECTOR_TOOL_NAMES.dword` = `['dword_schema', 'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add', 'dword_journal_find_similar', 'dword_journal_add']` (schema/sql first, curated after, mirroring `expenses`/`runs`/`seer`'s existing array shape).
- Phases 3/4: `dword_vocab_lookup { term }`, `dword_vocab_add { term, part_of_speech, pronunciation, definition, examples[3], origin?, context? }`, `dword_journal_find_similar { text }`, `dword_journal_add { text, source_note?, insight, force? }` exist as MCP tools with these argument shapes (per the analysis's "Processing chain", since Phase 3/4's own plan files were not available when this phase was planned — see **Assumptions**).
- Phase 5: `claude/skills/v/SKILL.md`, `claude/skills/j/SKILL.md` exist with register rules this
  phase's new prompt paragraph mirrors; `.claude/skills/verify-notesd/features/dword.md` exists
  with at least one section describing the Claude Code skill path.

**Leaves alone (owned by others):** `src/mcp/dwordVocabTools.ts`, `src/mcp/dwordJournalTools.ts`
(Phases 3/4, already shipped); `claude/skills/v/`, `claude/skills/j/` (Phase 5, already shipped);
`src/dword/*` (Phase 2); `src/connectors/*` (Phase 1); `.claude/skills/verify-notesd/features/README.md`'s index table (expected to be updated by Phase 5, since it creates `dword.md`).

## Files

| File | Action | What changes |
|---|---|---|
| `src/chat/status.ts` | modify | add `DWORD_TOOL_NAMES`/`DwordToolName` (after `ADVERSARY_TOOL_NAMES`, line 56 of the pre-phase-6 file); add 4 `captionForToolUse` switch cases before `default`; update two doc comments |
| `src/chat/prompt.ts` | modify | insert one new paragraph into `buildChatSystemPrompt`'s `sections` array, right after the existing apps paragraph |
| `tests/unit/chat-status.test.ts` | modify | import `DWORD_TOOL_NAMES`; update tool-count assertions (15 → 21 connector tools, total 19+5+3+21+2); add dword rows to the caption `it.each`; split the "every connector tool" assertion so the four curated dword tools are checked against their bespoke captions instead of the generic pattern |
| `tests/unit/chat-prompt.test.ts` | modify | append assertions on the new dword paragraph: app framing, trigger phrases, register limits, origin rules, duplicate-then-force rule, no-slash-command statement |
| `.claude/skills/verify-notesd/features/dword.md` | modify (append) | add a `## Wall chat (phase 6)` H2 section (Sub-features / How to get to it / Driving it with verify.sh / Gotchas) — see **Handoffs** for the structural caveat |

## Implementation Steps

### Step 1: Confirm wall-chat capture needs no new code
**Files (read only):** `src/http/api.ts:320-432`, `src/chat/service.ts:126-200`, `src/http/capture.ts`, `claude/hooks/notes-capture.mjs`

**Finding:** two separate capture paths exist, and only one of them is content-sensitive:

1. **Claude Code `/n` capture** (`claude/hooks/notes-capture.mjs` → `POST /api/capture/claude-code`
   → `src/http/capture.ts` → `ChatService.recordExchange`): a Stop hook that reads the session
   transcript and only fires when `isNotesPrompt(turn.prompt)` is true (the prompt started with
   `/n`). This is **not** the wall chat bar's path, and `/v`/`/j` Claude Code skill turns already
   go through it unconditionally too, per Phase 5's own scope — nothing to do here.
2. **Wall chat capture** (`POST /api/chat`, `src/http/api.ts:328-432`): writes the user message
   row via `history.addUserMessage` (line 360) **before** the agent runs at all, then — "on a
   clean finish only" (the route's own doc comment, line 323) — writes the assistant row via
   `history.addAssistantMessage` (line 412). Neither call branches on message text or on which
   tools the agent called mid-turn. `ChatService.addUserMessage`/`addAssistantMessage`
   (`src/chat/service.ts:126-200`) take `text`/`attachments` and write them with no content
   inspection.

**Conclusion:** a wall-chat vocab/journal exchange is captured into chat history exactly like any
other wall-chat message, today, with no code change. This phase makes **no change** to
`src/http/api.ts`, `src/chat/service.ts`, `src/http/capture.ts` or `claude/hooks/notes-capture.mjs`.
The **Proof** section demonstrates this empirically rather than resting on the reading alone.

### Step 2: Caption the four curated dword tools in `src/chat/status.ts`
**File:** `src/chat/status.ts` (post-Phase-1/3/4 state: imports unchanged at lines 1-7)
**Change:** add the `DWORD_TOOL_NAMES` constant after `ADVERSARY_TOOL_NAMES`; add 4 `switch` cases
to `captionForToolUse`; update the two doc comments that state exact tool counts.

**Code — complete replacement file:**
```ts
import {
  ALL_CONNECTOR_TOOL_NAMES,
  CONNECTOR_SYSTEMS,
  CONNECTOR_TOOL_NAMES,
  SYSTEM_META,
  type SystemId,
} from '../connectors/names.js';

/**
 * The chat agent's tool surface and the terse captions the answer panel shows while a tool runs.
 * Notes tool names match src/mcp/tools.ts and src/mcp/imageTools.ts; session tool names match
 * src/mcp/sessionTools.ts; connector tool names come from src/connectors/names.ts. Claude Code
 * exposes all of them as `mcp__notes__<name>` because the daemon registers its one MCP server
 * under the name `notes`.
 */
export const NOTES_MCP_SERVER = 'notes';

export const NOTES_TOOL_NAMES = [
  'create',
  'get',
  'update',
  'append',
  'delete',
  'restore',
  'list',
  'search',
  'tags',
  'related',
  'revisions',
  'revert',
  'create_image',
  'view_images',
  'attach_image',
  'remove_image',
  'restore_image',
  'move_image',
  'similar_images',
] as const;

export type NotesToolName = (typeof NOTES_TOOL_NAMES)[number];

/** Read-only Claude Code session tools (PROJECT_SESSION_GRAPH_PLAN phase 7; phase 9 appends session_resume). */
export const SESSION_TOOL_NAMES = [
  'sessions_search',
  'session_get',
  'session_transcript',
  'sessions_usage',
  'session_resume',
] as const;

export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

/** Read-only Seer Adversarial tools (SEER_ADVERSARIAL_PLAN phase 5): src/mcp/adversaryTools.ts registers them under these names. */
export const ADVERSARY_TOOL_NAMES = ['adversary_overview', 'adversary_verdicts', 'adversary_scorecard'] as const;

export type AdversaryToolName = (typeof ADVERSARY_TOOL_NAMES)[number];

/**
 * The four curated dword (daily-words) tools (DWORD_CONNECTOR_PLAN phases 3/4: src/mcp/dwordVocabTools.ts,
 * src/mcp/dwordJournalTools.ts). Named here only so `captionForToolUse` can give each one its own caption
 * and so this file's tests can assert on them by name. Unlike ADVERSARY_TOOL_NAMES/SESSION_TOOL_NAMES,
 * this array is deliberately NOT spread into `allowedChatTools()`'s return value: dword is a
 * `CONNECTOR_SYSTEMS` member (DWORD_CONNECTOR_PLAN phase 1), so all six of its tool names (these four
 * plus the generic `dword_schema`/`dword_sql`) already reach `allowedChatTools()` through
 * `ALL_CONNECTOR_TOOL_NAMES` below. Spreading this array too would list the same four names twice and
 * fail the no-duplicates assertion in tests/unit/chat-status.test.ts.
 */
export const DWORD_TOOL_NAMES = [
  'dword_vocab_lookup',
  'dword_vocab_add',
  'dword_journal_find_similar',
  'dword_journal_add',
] as const;

export type DwordToolName = (typeof DWORD_TOOL_NAMES)[number];

export const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

/** Status-line caption for every tool of one read-only system ('reading expenses' / 'reading runs' / 'reading seer'). */
export const CONNECTOR_CAPTIONS = Object.fromEntries(
  CONNECTOR_SYSTEMS.map((id) => [id, SYSTEM_META[id].caption]),
) as Record<SystemId, string>;

const MCP_PREFIX = `mcp__${NOTES_MCP_SERVER}__`;

/**
 * Exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 21 connector tools and
 * WebSearch + WebFetch (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN phase 3 adds
 * `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`; PROJECT_SESSION_GRAPH_PLAN phase 7 adds the session tools;
 * PROJECT_SESSION_GRAPH_PLAN phase 9 adds `session_resume`; SEER_ADVERSARIAL_PLAN phase 5 adds the
 * adversary tools; DWORD_CONNECTOR_PLAN phases 1/3/4 add dword's six tool names to
 * `ALL_CONNECTOR_TOOL_NAMES`, 15 -> 21, with no change needed to this function's body).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ADVERSARY_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    // dword's six tool names (dword_schema, dword_sql, and DWORD_TOOL_NAMES above) arrive here
    // already, because CONNECTOR_SYSTEMS includes 'dword' (DWORD_CONNECTOR_PLAN phase 1).
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
}

function idCount(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const ids = (input as { ids?: unknown }).ids;
  return Array.isArray(ids) ? ids.length : null;
}

function counted(n: number | null, one: string, many: (n: number) => string, unknown: string): string {
  if (n === 1) return one;
  if (n !== null && n > 1) return many(n);
  return unknown;
}

/** The caption for a connector tool name (without the MCP prefix), or null if it is not one. */
function connectorCaption(tool: string): string | null {
  for (const system of CONNECTOR_SYSTEMS) {
    const names: readonly string[] = CONNECTOR_TOOL_NAMES[system];
    if (names.includes(tool)) return CONNECTOR_CAPTIONS[system];
  }
  return null;
}

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
    case 'move_image':
      return 'moving a photo to its own note';
    case 'sessions_search':
      return 'searching sessions';
    case 'session_get':
      return 'reading a session';
    case 'session_transcript':
      return 'reading a session transcript';
    case 'sessions_usage':
      return 'counting session tokens';
    case 'session_resume':
      return 'opening a session in tmux';
    case 'adversary_overview':
      return 'reading Seer Adversarial';
    case 'adversary_verdicts':
      return "reading Claude's verdicts";
    case 'adversary_scorecard':
      return "reading Claude's record";
    case 'dword_vocab_lookup':
      return 'looking up a word';
    case 'dword_vocab_add':
      return 'saving a word';
    case 'dword_journal_find_similar':
      return 'checking for a similar saying';
    case 'dword_journal_add':
      return 'saving a saying';
    default:
      return connectorCaption(tool);
  }
}
```
**Impact:** `allowedChatTools()`'s output is unchanged in length or content versus what Phases
1/3/4 already produce (still exactly `ALL_CONNECTOR_TOOL_NAMES`, now 21 long, spread once). The
only observable change is that `captionForToolUse('mcp__notes__dword_vocab_add', ...)` now returns
`'saving a word'` instead of falling through to the generic `'reading daily-words'` — the first
connector tool to get a bespoke caption instead of the generic per-system one, because dword is
the first connector with a write tool.

### Step 3: Add the dword paragraph to `src/chat/prompt.ts`
**File:** `src/chat/prompt.ts:19-39` (the `sections` array and the function around it)
**Change:** insert one new paragraph right after the existing apps paragraph (old index 0), so it
reads immediately after the sentence introducing `expenses_*`/`runs_*`/`seer_*` and before the
date/timezone paragraph. Nothing else in the function changes.

**Code — complete replacement file:**
```ts
import { localTimeZone } from '../mcp/instructions.js';
import { OMITTED_LINE } from './context.js';

function part(now: Date, timeZone: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(now);
}

/**
 * The chat agent's whole system prompt (it replaces Claude Code's default prompt). It is built
 * per run so "today" is always current. The notes MCP server adds its own instructions about
 * tools, ids and dates on top.
 */
export function buildChatSystemPrompt(now: Date = new Date(), timeZone: string = localTimeZone()): string {
  const isoDate = part(now, timeZone, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = part(now, timeZone, 'en-US', { weekday: 'long' });
  const longDate = part(now, timeZone, 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = part(now, timeZone, 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const sections = [
    `You are the chat bar of mcp-notes, the personal note store of the person typing to you. They are the owner of every note in it, and you answer only them. A note is a plain-text body with #hashtag tags written into it; some notes are image notes (photos and screenshots). You reach the notes only through the notes tools (mcp__notes__*). The owner's three other apps are open to you read-only, each through its own tools on the same server: expense-tracking, their spending in rupiah (expenses_*); run-insights, their Apple Watch runs with the app's own analyses and weekly and monthly reviews, and their coach Nina (runs_*); and Seer, their trading lab with its paper strategies, leaderboard and open positions, plus Sera, the lab that searches for and tests trading methods (seer_*). For those systems use the curated tools first; use a system's _sql tool only when the curated tools do not answer, and call its _schema tool before you write SQL. You cannot change anything in those apps. You may also use WebSearch and WebFetch when the owner asks about something outside their notes and apps.`,

    `The owner also keeps daily-words, a vocabulary and wise-words app, open to you. Unlike expense-tracking, run-insights and Seer, you may write to daily-words as well as read it, through dword_* tools (curated tools first; dword_sql and dword_schema only when the curated tools do not answer). When a message looks like a vocabulary question or request — "what does X mean", "add the word X", "X as in <sentence>", or a bare word or phrase the owner clearly wants looked up or added — call dword_vocab_lookup with that term first. If it is found, tell the owner what is already stored: definition, part of speech, examples and any origin. If the message also gave a sentence after the word and the found entry has no origin yet, call dword_vocab_add again with the term, its existing fields and that sentence as the origin context, so the one-time origin attach can run; it never overwrites an origin that is already set. If dword_vocab_lookup finds nothing, write the entry yourself in daily-words' own register: pick the part of speech from its list, write a definition under 60 characters, give British RP pronunciation, and give exactly three example sentences, each containing the term and under 100 characters. When the word the owner typed is not English, put the natural English word in term and record the original word, its language and the sentence (if any) as origin_term, origin_language and origin_context; when the word is already English and a sentence was given, set origin_term to the term itself, origin_context to the sentence, and origin_language to the literal English. Then call dword_vocab_add with everything you wrote and tell the owner it was added. When a message looks like asking about or saving a saying, a piece of wise words, or a journal-style insight — "have I saved something like this", "save this: ...", or wise words the owner quotes without saying "save" — call dword_journal_find_similar with the text first. If it answers duplicate, show the owner the existing entry and its insight and insert nothing, unless the owner then says to save it anyway (for example "save it anyway" or "add it as a new one"), in which case call dword_journal_add with force: true. If it answers none, write the insight yourself — a plain-English meaning under 220 characters, and 2 to 3 concrete everyday situations in whenItApplies, each under 120 characters, no advice, no praise — and call dword_journal_add to insert it, then tell the owner it was saved. None of this is slash-command syntax: the chat bar never parses /v or /j, there is no command parser here, only your reading of plain language, so look for the natural-language patterns above, not a leading slash.`,

    `Today is ${weekday} ${isoDate} (${longDate}), ${time} in ${timeZone}. Resolve relative dates such as "today", "this week", "last week", "last month" or "30 oct" against that date in that timezone; weeks start on Monday. When a notes tool or one of the apps' tools takes a date, pass YYYY-MM-DD; the server reads it in ${timeZone}.`,

    `Whenever you use a note, quote its id in your answer exactly in the form A-B32: one character, a dash, three characters, upper case. The page highlights notes by finding those ids in your answer text, so every note you relied on must appear by id. Never invent an id.`,

    `You may change notes when the owner asks: edit, append, tag, untag, delete or restore. To tag a note, write the #hashtag into its body. Read a note with get before you update it, and send the whole new body. Do not create a note unless the owner asks for one, and never save your own answer as a note.`,

    `To look at pictures, find the notes with images first (list with has_image, or search), then call view_images with their note ids (each note id shows every image of that note, up to 8 images per call; image ids work too) and comment on what you actually see. A note may also hold files that are not pictures: you see each one's name, type and size in the note's files list but cannot open them, and you cannot attach files. Images the owner pastes into the chat bar come with their message and are named in its text as [image upload:ID]. To find photos like one of them, call similar_images with upload_id set to that ID (image_id for a picture already in a note, query for words such as "red top in a car"), then call view_images on the top hits and say which ones really match and why. When the owner asks to keep a pasted picture as a note ("make that image a note"), call create_image with image_id set to its ID and, if they gave any, body text; to add it to an existing note, call attach_image with that note's id and image_id set to its ID. "That image" is the one whose ID the owner names; otherwise the picture in <message> (the last one if it holds several), otherwise the one in <reply_to>, otherwise the most recent [image upload:ID] in <chat_history>. Never ask the owner for a file path to a picture they pasted: its ID is all the tools need. If the picture already lives in a note, the tool returns that note (created: false, or attached: false for attach_image): tell the owner which note holds it. A picture the owner attached from a note comes as [note image:IMG in note NOTE, image k of n]: it already lives in that note, so it is never a pasted upload; use IMG as image_id for similar_images and view_images, and NOTE tells you which note holds it. To pull one picture out of a note into its own note ("move this image to a new note"), look at it, write the text the new note should carry (for example an image generation prompt that would recreate it), and call move_image with image_id set to IMG and that text as body; it moves the picture, nothing is copied, and the old note keeps its other pictures. Tell the owner the id of the new note. Name every picture so it can be referred to later: write a picture's id as img:ID for a picture in a note and upload:ID for a pasted one (for example img:9-TD6, upload:G-0NC), never as a bare id, because a note's first picture has the same id as its note and a bare id reads as the note. Whenever the owner's message carries a picture, state its id (upload:ID, or img:IMG for one attached from a note) once in your answer so later messages can point at it, and when you save, move or attach it say both the picture (img:ID) and the note that holds it now. view_images, similar_images and the other tools take the bare id, and view_images also takes img:ID to mean the picture and never the note of that id.`,

    `When you answer from the owner's spending, runs or Seer, say what the data shows and what you think about it, not just a tally: name the patterns, compare with the previous period or with what is usual for them, point out what stands out, and end with one concrete suggestion. Say which dates you looked at. Give figures in the apps' own units: rupiah as whole numbers written like Rp 38.500 (dots between thousands, no decimals), distance in km, pace as m:ss /km, heart rate in bpm, and Seer money in USD.`,

    `Write plain prose for a small panel: short paragraphs separated by one blank line. No markdown headings, no tables, no bold or italics, no code blocks unless the owner asks for code. Use a list only when the owner asks for one. Answer first, then the supporting detail. If the notes do not hold the answer, say so plainly. If one of the apps' tools returns an error, say which app could not be read and do not guess its numbers.`,

    `Every message from the owner reaches you in the same layout. <chat_history>, when present, holds the earlier messages of this conversation, oldest first; a line "${OMITTED_LINE}" means older ones were left out to save space. <reply_to>, when present, is the message the owner is replying to, possibly from another conversation. <message> is what the owner is asking now: answer that. Each message is one line that starts with its label, its role and its time in WIB (Asia/Jakarta), for example [msg:K7F2] user (2026-10-31 09:15 WIB): ... You see only the text of earlier answers, not the tool results behind them, so call the tools again when you need the data. Pictures appear as [image upload:ID]: you see the pictures of the current message and of the message being replied to; earlier pictures appear only by that label.`,

    `A turn may start with a <project> block that names a repository (repo: mcp-notes). The owner is then chatting from that repository's page in the wall's Projects view, where each node of the graph is one Claude Code session they ran there, with a node id like A0-3G (two characters, a dash, two characters; a note id like A-B32 has a different shape). Read their questions as being about that repository's sessions unless they clearly ask about notes or their apps. Find sessions with sessions_search, passing that repository as repo, and read the ones you rely on with session_get before you describe them. Quote every session you rely on by its node id in the form A0-3G, and never invent one. Without a <project> block, use the session tools only when the owner asks about their Claude Code sessions.`,

    `You may reply to one particular earlier message by starting your answer with its label exactly, for example "[msg:K7F2] " followed by your answer. The page hides the label and shows your answer as a reply to that message. Replying is optional: do it only when your answer is about one specific earlier message, never for the current message, and never invent a label. Do not write message labels anywhere else in your answer.`,
  ];
  return sections.join('\n\n');
}
```
**Impact:** `allowedChatTools()` is untouched by this step; this is purely the behavioral
instruction layer. The new paragraph is self-contained and does not change the wording of the
existing apps paragraph (which still correctly says the *other three* apps are read-only — dword
is introduced separately as the one writable app, so that sentence does not need to become false).

### Step 4: Update `tests/unit/chat-status.test.ts`
**File:** `tests/unit/chat-status.test.ts` (whole file)
**Change:** import `DWORD_TOOL_NAMES`; bump the connector-tool count from 15 to 21 (and the total
from `19+5+3+15+2` to `19+5+3+21+2`); add dword rows to the per-system caption `it.each`; split the
generic "every connector tool" assertion so the four curated dword tools (bespoke captions) are
excluded from the generic `reading X` pattern check and asserted separately.

**Code — complete replacement file:**
```ts
import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../src/connectors/names.js';
import {
  ADVERSARY_TOOL_NAMES,
  DWORD_TOOL_NAMES,
  NOTES_TOOL_NAMES,
  SESSION_TOOL_NAMES,
  allowedChatTools,
  captionForToolUse,
} from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 21 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(19);
    expect(SESSION_TOOL_NAMES).toHaveLength(5);
    expect(ADVERSARY_TOOL_NAMES).toHaveLength(3);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(21);
    expect(tools).toHaveLength(19 + 5 + 3 + 21 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    expect(tools).toContain('mcp__notes__similar_images');
    expect(tools).toContain('mcp__notes__session_resume');
    for (const name of SESSION_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of ADVERSARY_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of DWORD_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });

  it('captions the adversary tools', () => {
    expect(captionForToolUse(n('adversary_overview'), {})).toBe('reading Seer Adversarial');
    expect(captionForToolUse(n('adversary_verdicts'), { verdict: 'object' })).toBe("reading Claude's verdicts");
    expect(captionForToolUse(n('adversary_scorecard'), { strategy: 'A-GT' })).toBe("reading Claude's record");
  });

  it('offers no tool that deletes permanently', () => {
    expect(NOTES_TOOL_NAMES.filter((name) => /purge|forever|destroy/.test(name))).toEqual([]);
  });
});

describe('captionForToolUse', () => {
  it.each([
    [n('search'), {}, 'searching notes'],
    [n('list'), {}, 'searching notes'],
    [n('tags'), {}, 'searching notes'],
    [n('related'), { id: 'A-B32' }, 'finding related notes'],
    [n('similar_images'), { image_id: 'A-B32' }, 'finding similar photos'],
    [n('get'), { ids: ['A-B32'] }, 'reading a note'],
    [n('get'), { ids: ['A-B32', 'B-C43', 'C-D54'] }, 'reading 3 notes'],
    [n('get'), {}, 'reading notes'],
    [n('view_images'), { ids: ['A-B32'] }, 'looking at a photo'],
    [n('view_images'), { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }, 'looking at 4 photos'],
    [n('view_images'), null, 'looking at photos'],
    [n('revisions'), {}, 'reading history'],
    [n('create'), {}, 'saving a note'],
    [n('create_image'), {}, 'saving a note'],
    [n('create_image'), { path: '/tmp/a.png' }, 'saving a note'],
    [n('create_image'), { image_id: 'G-0NC' }, 'saving the pasted photo as a note'],
    [n('create_image'), { image_id: 'g0nc', body: 'receipt' }, 'saving the pasted photo as a note'],
    [n('create_image'), { image_id: '' }, 'saving a note'],
    [n('create_image'), null, 'saving a note'],
    [n('create'), { image_id: 'G-0NC' }, 'saving a note'],
    [n('update'), {}, 'editing a note'],
    [n('append'), {}, 'editing a note'],
    [n('revert'), {}, 'editing a note'],
    [n('delete'), {}, 'deleting a note'],
    [n('restore'), {}, 'restoring a note'],
    [n('attach_image'), { id: 'A-B32', path: '/tmp/a.png' }, 'attaching a photo'],
    [n('attach_image'), { id: 'A-B32', image_id: 'G-0NC' }, 'attaching the pasted photo'],
    [n('attach_image'), { id: 'A-B32', image_id: '   ' }, 'attaching a photo'],
    [n('remove_image'), { image_id: 'C-D54' }, 'removing a photo'],
    [n('restore_image'), { image_id: 'C-D54' }, 'restoring a photo'],
    [n('move_image'), { image_id: 'C-D54' }, 'moving a photo to its own note'],
    [n('sessions_search'), { query: 'wall' }, 'searching sessions'],
    [n('session_get'), { node_id: 'A0-3G' }, 'reading a session'],
    [n('session_transcript'), { node_id: 'A0-3G', query: 'x' }, 'reading a session transcript'],
    [n('sessions_usage'), { by: 'month' }, 'counting session tokens'],
    [n('session_resume'), { node_id: 'A0-3G' }, 'opening a session in tmux'],
    ['WebSearch', { query: 'Verity' }, 'searching the web'],
    ['WebFetch', { url: 'https://example.com' }, 'reading a web page'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it.each([
    [n('expenses_schema'), {}, 'reading expenses'],
    [n('expenses_sql'), { sql: 'select 1' }, 'reading expenses'],
    [n('expenses_spending'), { from: '2026-10-01', to: '2026-10-31' }, 'reading expenses'],
    [n('expenses_get'), { id: 'g1' }, 'reading expenses'],
    [n('expenses_months'), {}, 'reading expenses'],
    [n('runs_schema'), {}, 'reading runs'],
    [n('runs_sql'), { sql: 'select 1' }, 'reading runs'],
    [n('runs_list'), { from: '2026-10-01', to: '2026-10-31' }, 'reading runs'],
    [n('runs_get'), { date: '2026-10-29' }, 'reading runs'],
    [n('runs_review'), {}, 'reading runs'],
    [n('seer_schema'), {}, 'reading seer'],
    [n('seer_sql'), { sql: 'select 1', source: 'lab' }, 'reading seer'],
    [n('seer_leaderboard'), {}, 'reading seer'],
    [n('seer_positions'), {}, 'reading seer'],
    [n('seer_sera_best'), {}, 'reading seer'],
    [n('dword_schema'), {}, 'reading daily-words'],
    [n('dword_sql'), { sql: 'select 1' }, 'reading daily-words'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it('captions the four curated dword tools distinctly, not with the generic connector caption', () => {
    expect(captionForToolUse(n('dword_vocab_lookup'), { term: 'perch' })).toBe('looking up a word');
    expect(captionForToolUse(n('dword_vocab_add'), { term: 'perch' })).toBe('saving a word');
    expect(captionForToolUse(n('dword_journal_find_similar'), { text: 'x' })).toBe('checking for a similar saying');
    expect(captionForToolUse(n('dword_journal_add'), { text: 'x' })).toBe('saving a saying');
  });

  it('captions every other connector tool with the generic one-per-system caption', () => {
    const bespoke: readonly string[] = DWORD_TOOL_NAMES;
    for (const name of ALL_CONNECTOR_TOOL_NAMES) {
      if (bespoke.includes(name)) continue;
      expect(captionForToolUse(n(name), {})).toMatch(/^reading (expenses|runs|seer|daily-words)$/);
    }
  });

  it('names nothing outside the surface', () => {
    expect(captionForToolUse('Bash', { command: 'ls' })).toBeNull();
    expect(captionForToolUse('mcp__other__search', {})).toBeNull();
    expect(captionForToolUse('mcp__other__expenses_sql', {})).toBeNull();
    expect(captionForToolUse(n('unknown'), {})).toBeNull();
    expect(captionForToolUse(n('expenses_unknown'), {})).toBeNull();
  });
});
```
**Impact:** this file is the one place the 15→21 connector-tool count is pinned; this step is what
keeps `npm test` green once Phases 1/3/4 have landed `dword` into `CONNECTOR_SYSTEMS` and
`CONNECTOR_TOOL_NAMES.dword` (see **Handoffs** for the cross-phase ordering risk this implies).

### Step 5: Extend `tests/unit/chat-prompt.test.ts`
**File:** `tests/unit/chat-prompt.test.ts` (append inside the existing `describe('buildChatSystemPrompt', ...)` block, after its last `it(...)`, before the closing `});`)
**Change:** add assertions that pin the new paragraph's content.

**Code — complete new block to append:**
```ts
  it('names daily-words as the one writable app and gives its tool prefix', () => {
    expect(prompt).toContain('daily-words');
    expect(prompt).toMatch(/you may write to daily-words as well as read it/);
    expect(prompt).toContain('dword_*');
  });

  it('triggers a vocab lookup-then-add flow from natural language, never a slash command', () => {
    expect(prompt).toContain('what does X mean');
    expect(prompt).toContain('add the word X');
    expect(prompt).toContain('X as in <sentence>');
    expect(prompt).toMatch(/call dword_vocab_lookup with that term first/);
    expect(prompt).toMatch(/call dword_vocab_add with everything you wrote/);
    expect(prompt).toMatch(/the chat bar never parses \/v or \/j/);
  });

  it('mirrors the vocab register rules: pronunciation, definition and example limits', () => {
    expect(prompt).toMatch(/British RP pronunciation/);
    expect(prompt).toMatch(/definition under 60 characters/);
    expect(prompt).toMatch(/three example sentences, each containing the term and under 100 characters/);
  });

  it('resolves origin fields for a non-English term and for an English term with a sentence', () => {
    expect(prompt).toMatch(/put the natural English word in term/);
    expect(prompt).toContain('origin_term, origin_language and origin_context');
    expect(prompt).toMatch(/origin_language to the literal English/);
  });

  it('never overwrites an existing vocab origin', () => {
    expect(prompt).toMatch(/it never overwrites an origin that is already set/);
  });

  it('triggers a journal find-similar-then-add flow and shows a duplicate before inserting', () => {
    expect(prompt).toMatch(/call dword_journal_find_similar with the text first/);
    expect(prompt).toMatch(/show the owner the existing entry and its insight and insert nothing/);
    expect(prompt).toMatch(/force: true/);
    expect(prompt).toMatch(/meaning under 220 characters/);
    expect(prompt).toMatch(/2 to 3 concrete everyday situations/);
    expect(prompt).toMatch(/no advice, no praise/);
  });
```
**Impact:** pins the exact wording this plan commits to, so a future edit that accidentally
reintroduces `/v`/`/j` slash-command framing (which does not work in chat) fails a test instead of
shipping silently.

### Step 6: Append the wall-chat section to the feature map
**File:** `.claude/skills/verify-notesd/features/dword.md`
**Change:** append a new `## Wall chat (phase 6)` H2 section. **Phase 5 creates this file**; at
the time this phase was planned, Phase 5 had not yet landed in this worktree, so its exact
structure (flat four sections vs. phase-keyed H2s like `adversary.md`) is unknown. Append this
section without altering anything above it; see **Handoffs** for what the implementer must check
before appending.

**Code — complete new section to append:**
```markdown

## Wall chat (phase 6)

### Sub-features
- The wall chat bar runs the same daily-words vocabulary and journal flow as `/v`/`/j`, from
  plain language only — the chat agent has no skill-loading and no slash-command parsing, so
  typing `/v word` or `/j text` into the bar is read as ordinary text, not a command.
- A vocabulary-shaped message ("what does X mean", "add the word X", "X as in <sentence>") calls
  `dword_vocab_lookup` first, then `dword_vocab_add` on a miss (or to attach an origin sentence to
  an existing word that has none yet — it never overwrites one that is already set).
- A saying/journal-shaped message calls `dword_journal_find_similar` first; a duplicate is shown
  and nothing is inserted unless the owner says to save it anyway (`force: true`).
- Every wall chat exchange, including these, is written to chat history the same way as any other
  wall turn: `POST /api/chat` (`src/http/api.ts`) writes the user message before the agent runs and
  the assistant message after a clean finish, with no branch on message content — confirmed by
  reading the route, not assumed.
- The status panel shows `looking up a word`, `saving a word`, `checking for a similar saying` and
  `saving a saying` while the matching dword tool runs, instead of a generic caption.

### How to get to it (user POV)
The wall's bottom chat bar ("Ask about your notes"); type a vocabulary or journal request in
plain language — no leading `/v` or `/j`.

### Driving it with verify.sh
daily-words lives in another database (shared Neon in production); give the run a throwaway
Postgres rebuilt from `~/daily-words`'s own migrations and point the run at it with
`DAILY_WORDS_DIR`, the same recipe `adversary.md` uses for Seer:
```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
DWORD_SRC=${DAILY_WORDS_DIR:-~/daily-words}
S=$(mktemp -d); mkdir -p "$S/dword"; DWORDDB=dword_v_$$
echo "DATABASE_URL=postgres://postgres:mcpnotes@127.0.0.1:55436/$DWORDDB" > "$S/dword/.env.local"
echo "DATABASE_URL_UNPOOLED=postgres://postgres:mcpnotes@127.0.0.1:55436/$DWORDDB" >> "$S/dword/.env.local"
P() { docker exec -i mcp-notes-pg-verify psql -v ON_ERROR_STOP=1 -X -q -U postgres "$@"; }
P -c "create database $DWORDDB"
for f in "$DWORD_SRC"/drizzle/*.sql; do P -d "$DWORDDB" < "$f"; done
P -d "$DWORDDB" -c "insert into users (id, email) values (gen_random_uuid(), 'verify@example.com')"
DAILY_WORDS_DIR="$S/dword" DWORD_USER_EMAIL=verify@example.com $V up --web
$V ui RUN dword-vocab-steps.mjs      # types a vocab request, no /v typed
$V ui RUN dword-journal-steps.mjs    # types a journal request, no /j typed
P -d "$DWORDDB" -c "select term, origin_language from vocab_entries where lower(term) = 'perch'"
P -d "$DWORDDB" -c "select left(text, 40), insight_status from journal_entries order by created_at desc limit 1"
$V api RUN GET /api/chat/messages    # the exchanges appear in chat history, source 'wall'
$V down RUN
P -c "drop database $DWORDDB with (force)"
```
Paid: each `$V ui` journey runs one real, billed Claude Agent SDK chat turn (phase 5's own
`verify-notesd` entries already note this rule for `/v`/`/j`; it applies here too).

### Gotchas
- Never point `DAILY_WORDS_DIR` at the real `~/daily-words` checkout for this journey — it would
  write to production Neon, which D1/invariant 4 forbid. Always a scratch directory whose
  `.env.local` names the throwaway database.
- `$V sql` reads the notes DB only; read dword rows with `docker exec ... psql -d $DWORDDB` as above.
- The verify container's image is `pgvector/pgvector:pg16`; `gen_random_uuid()` (dword's uuid
  default) is built into Postgres core since 13, so no extension needs creating.
- A plain, non-dword wall chat question must still work unchanged in the same run: the new prompt
  paragraph and the six additional allowed tool names must not change how an ordinary notes
  question is answered (see the Proof section's neighbor check).
```
**Impact:** no runtime code; this is the proof-map entry a future verifier or reviewer reads
before (re)driving this feature.

## Principles applied

- **Laziness protocol / Subtract before you add:** the phase index's literal instruction ("add a
  `DWORD_TOOL_NAMES` array ... spliced into `allowedChatTools()`") was not followed as written,
  because `ALL_CONNECTOR_TOOL_NAMES` already carries dword's six tool names generically once
  Phases 1/3/4 land (dword is a `CONNECTOR_SYSTEMS` member, unlike adversary/session tools, which
  are not). Spreading a second array with the same four curated names would duplicate a single
  source of truth and fail the existing `new Set(tools).size === tools.length` invariant test.
  `allowedChatTools()`'s body is left untouched; `DWORD_TOOL_NAMES` is kept only to drive bespoke
  captions and tests, where it has a real, non-duplicating job.
- **Boundary discipline:** the new chat-prompt paragraph is the one place Claude decides what
  `origin_term`/`origin_language`/`origin_context` to send (D2: Claude writes the explanation
  itself; the MCP tool only validates). No validation logic is duplicated here — the paragraph
  states the register rules once, in prose, for Claude to apply when composing the tool call; the
  tool (Phase 2/3's `rules.ts`) is still the actual enforcement boundary.
- **Prove it works:** Verification drives the real wall chat bar through `verify-notesd`'s
  Playwright journey against a throwaway dword Postgres, reads the resulting row back with `psql`,
  and reads the resulting chat-history row back with the real API — not "the prompt contains the
  right words."

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/chat-status.test.ts tests/unit/chat-prompt.test.ts` (then `npm test` for the full suite)

**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`).
- Feature-map entries: `.claude/skills/verify-notesd/features/dword.md` (`## Wall chat (phase 6)`,
  added by this phase).
- Journeys:
  1. **Unit, free.** `npx vitest run tests/unit/chat-status.test.ts` — end state: all tests pass,
     including `allowedChatTools()` contains `mcp__notes__dword_vocab_add` etc. and has no
     duplicates, and `captionForToolUse` returns `'saving a word'` for `dword_vocab_add`, not the
     generic `'reading daily-words'`.
  2. **Unit, free.** `npx vitest run tests/unit/chat-prompt.test.ts` — end state: the prompt text
     asserts for the trigger phrases, register limits, origin rules and the no-slash-command
     statement all pass.
  3. **Live, paid, vocabulary.** Build a throwaway dword Postgres and launch notesd against it (see
     Step 6's script). Write `dword-vocab-steps.mjs` in the scratchpad:
     ```js
     export default async ({ page, base, shot, log }) => {
       await page.goto(base + '/');
       await page.getByLabel('Ask about your notes').fill(
         'add the word perch, as in: she watched it jerk backward on its perch',
       );
       await page.getByRole('button', { name: 'Send' }).click();
       await page.getByText(/perch/i).first().waitFor({ timeout: 30000 });
       await shot('after-vocab-add');
       log('wall chat added "perch" to daily-words from natural language, no /v typed');
     };
     ```
     Run `$V ui RUN dword-vocab-steps.mjs`, then
     `docker exec -i mcp-notes-pg-verify psql -U postgres -d $DWORDDB -c "select term, origin_language from vocab_entries where lower(term)='perch'"`.
     End state: one row, `term = 'perch'`, `origin_language` is `NULL` or `'English'` (never an
     error), proving the write landed in the throwaway DB, not production Neon.
  4. **Live, paid, journal.** Same run, `dword-journal-steps.mjs` sends a wise-words message (for
     example "save this: a stitch in time saves nine"), waits for the reply, then
     `psql -d $DWORDDB -c "select insight_status from journal_entries order by created_at desc limit 1"`
     shows `insight_status = 'ready'`.
  5. **Live, paid, capture.** Same run, `$V api RUN GET /api/chat/messages` — end state: the
     timeline includes the vocab and journal user/assistant message pairs from journeys 3-4, with
     `source: "wall"`, proving Step 1's reading (capture is unconditional) empirically, not just by
     code inspection.
  6. **Neighbor check.** Same run, one more wall-chat turn asking a plain notes question unrelated
     to dword (for example "what notes do I have tagged demo"); end state: the answer still comes
     from the notes tools (`$V api RUN GET /api/chat/messages` shows no `dword_*` tool mentioned in
     its status events, or — more directly — the panel's status captions during that turn never say
     "looking up a word"/"saving a word"/etc.), proving the new prompt paragraph and the six extra
     allowed tool names did not change how an ordinary question is answered.
- Cost: 3 real Claude Agent SDK chat turns in one run (vocabulary, journal, neighbor check),
  billed. Run once; do not re-drive routinely (`verify-notesd`'s own rule for `/api/chat`).
**Exit criteria:** `npm run typecheck` and `npm test` are green; the two unit test files above pass
with the updated counts/assertions; journeys 3-6 above produce the stated end states against the
throwaway dword Postgres, never the real `~/daily-words`.

## Assumptions

- `SYSTEM_META.dword.caption` (Phase 1, `src/connectors/names.ts`) is the literal string
  `'reading daily-words'`, per design doc §5.1, which the analysis's R1 pass did not flag as
  wrong. If Phase 1 chose different wording, update the three literal occurrences in
  `tests/unit/chat-status.test.ts` (the `dword_schema`/`dword_sql` rows and the generic-caption
  regex) to match.
- `CONNECTOR_TOOL_NAMES.dword`, once Phases 1/3/4 land, is exactly
  `['dword_schema', 'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add', 'dword_journal_find_similar', 'dword_journal_add']`
  — schema/sql first, curated after, mirroring `expenses`/`runs`/`seer`'s existing array shape
  (confirmed in the pre-Phase-1 `src/connectors/names.ts`, lines 10-14 of the current file).
- `dword_vocab_lookup`/`dword_vocab_add`/`dword_journal_find_similar`/`dword_journal_add`'s
  argument shapes are exactly as the analysis's "Processing chain" section describes them (Phases
  3/4's own plan files were not available in this worktree when this phase was planned, since
  phases run concurrently).
- Phase 5's actual `claude/skills/v/SKILL.md`/`j/SKILL.md` wording was not available either (same
  concurrent-planning reason). The new chat-prompt paragraph mirrors the design doc's §5.6 prose
  (register rules: British RP pronunciation, definition ≤60 chars, three examples ≤100 chars each
  containing the term; non-English term → English word in `term` plus `origin_*`; journal insight
  meaning ≤220 chars, 2-3 situations ≤120 chars, no advice/praise) rather than Phase 5's shipped
  text. See **Handoffs**.
- `.claude/skills/verify-notesd/features/dword.md` (Phase 5) uses the flat four-section layout like
  `chat.md`/`notes.md`, not the phase-keyed H2 layout `adversary.md` uses. If it is phase-keyed
  already, the appended `## Wall chat (phase 6)` section still fits the same pattern; if it is
  flat, the reconciler should decide whether to convert Phase 5's section into a first H2 (for
  example `## Claude Code skills (phase 5)`) or leave it unheaded above this phase's H2 — either
  way, this phase's content must land as an appended, clearly-labeled section, never merged into or
  overwriting Phase 5's text.

## Handoffs

- **Register-rule wording alignment (R6):** once Phase 5's `claude/skills/v/SKILL.md` and
  `j/SKILL.md` actually exist, diff their register-rule prose against the chat-prompt paragraph
  added in Step 3. The "mirror them, do not diverge" instruction is a correctness requirement, not
  a style preference — if Phase 5 phrased a limit differently (for example a different example
  sentence cap than the 100 characters quoted here from `vocab-enrich.ts:179`), align this
  paragraph's wording to Phase 5's shipped text, not the other way around, since Phase 5 is the
  more detailed, skill-specific source.
- **`features/README.md` index row:** this phase does not add a `dword.md` row to
  `.claude/skills/verify-notesd/features/README.md`'s table — that file is not in this phase's
  "Also owns" scope. Phase 5, which creates `dword.md`, is expected to add the row per the
  feature-map's own convention ("Add an entry when a change ships a new user-facing feature"). If
  it did not, a later cleanup should add it.
- **Cross-phase test breakage window:** `tests/unit/chat-status.test.ts`'s exact tool-count
  assertions (today: 15 connector tools) are not in any earlier phase's explicit "Owns" list, so
  they go red as soon as Phase 1 adds `'dword'` to `CONNECTOR_SYSTEMS` (count becomes 17 with just
  `dword_schema`/`dword_sql`), and again after Phases 3/4 add the curated names (count becomes 21).
  This phase is what returns the file to green, at the final count, since it owns
  `src/chat/status.ts`. If the swarm runs phases in strict dependency order before any merge back
  to a shared branch, this window is invisible; if Phase 1's own commit must pass `npm test` in
  isolation before Phase 6 lands, Phase 1 (or whichever phase lands the count change first) should
  bump the two numeric assertions as a minimal keep-green edit, which Phase 6 will then overwrite
  to the final 21 anyway. Flagging this for the reconciler rather than silently fixing Phase 1's
  file, which is out of this phase's scope.
- **dword caption text (if phase 1 differs):** see **Assumptions** above — three literal-string
  test assertions to adjust if `SYSTEM_META.dword.caption` is not `'reading daily-words'`.

## Rollback

Revert this phase's two source diffs (`src/chat/status.ts`, `src/chat/prompt.ts`) and two test
diffs (`tests/unit/chat-status.test.ts`, `tests/unit/chat-prompt.test.ts`); remove only the
`## Wall chat (phase 6)` section from `.claude/skills/verify-notesd/features/dword.md`, leaving
Phase 5's content intact. No migrations, no persisted rows, no config keys are introduced by this
phase, so there is no data to roll back. `git revert` of this phase's commit(s) on
`feature/dword-connector` is sufficient and self-contained; it does not affect Phases 1-5's own
commits.
