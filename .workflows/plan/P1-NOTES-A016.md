> Adopted from `docs/plans/CONNECTORS_PLAN.md` phase 5. Source: `.workflows/plan/connectors/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Chat bar + /n for connectors

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R3 — the chat bar allows and captions the 15 connector tools, and `/n` routes spending/runs/Seer questions to them and answers with an opinion, not a tally
**Depends on:** Phase 1 (only `src/connectors/names.ts`, exactly as written in the index contract)
**Difficulty:** NORMAL
**Package:** `src/chat`, `claude/skills/n`

---

## Goal

After this phase the chat bar's Agent SDK run may call all 15 connector tools (`mcp__notes__expenses_*`, `mcp__notes__runs_*`, `mcp__notes__seer_*`) and the panel's status line says "reading expenses" / "reading runs" / "reading seer" while they run. The chat system prompt names the three read-only systems, tells the agent to prefer curated tools over `_sql`, and asks data answers to say what the data shows plus the agent's own read and a suggestion, in the apps' units. The `/n` skill routes the same questions to the same tools with the same answer rule.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `CONNECTOR_CAPTIONS: Record<SystemId, string>` (`src/chat/status.ts`, exported; derived from phase 1's `SYSTEM_META[id].caption`, the single source of the three captions)
- `connectorCaption(tool: string): string | null` (`src/chat/status.ts`, module-private)
- new section "Spending, runs and Seer" in `claude/skills/n/SKILL.md`
- new README subsection "Spending, runs and Seer" under "Using it from Claude Code" (+ one TOC line)
**Signature changes:** none. `allowedChatTools(): string[]` and `captionForToolUse(name, input): string | null` keep their signatures; `allowedChatTools()` now returns 30 names (13 notes + 15 connector + 2 web) in that order.
**Requires (from earlier phases):**
- Phase 1: `src/connectors/names.ts` exports `CONNECTOR_SYSTEMS`, `SystemId`, `CONNECTOR_TOOL_NAMES`, `ALL_CONNECTOR_TOOL_NAMES` exactly as in the index contract (15 names, order expenses → runs → seer), plus `SYSTEM_META` with `caption` = `reading expenses` / `reading runs` / `reading seer`. `names.ts` has no imports at all, so `src/chat` does not pull in `pg`, `node:sqlite` or any connector runtime.
- Phase 1: `README.md` already has the "Connectors: spending, runs, Seer" section (anchor `#connectors-spending-runs-seer`), its TOC line `- [Connectors: spending, runs, Seer](#connectors-spending-runs-seer)` right after `- [The chat bar](#the-chat-bar)`, and the rewritten Tests/Configuration/MCP-tools/Limitations text. This phase quotes README as phase 1 leaves it and edits only the hunks named in Step 6.
- Phase 1: the 15 tools are registered on the same `notes` MCP server (so the SDK sees them as `mcp__notes__<name>`). This phase's unit tests do not need that; the manual acceptance does.
- Phases 2–4 (concurrent with this phase, not prerequisites): the curated tools' names are the contract's; the skill quotes their parameters exactly as phases 2–4 define them (`expenses_spending` `from`/`to`/`categories`/`top`, `expenses_months` `months`/`to_month`/`categories`, `expenses_get` `id`, `runs_list` `from`/`to`, `runs_get` `id` xor `date`, `runs_review` `scope`/`key`, `seer_positions` `strategy`/`include_pending`, `seer_sera_best` `limit`/`status`/`only_eligible`). No unit test here depends on them.
**Leaves alone (owned by others):** `src/connectors/**`, `src/mcp/**` incl. `instructions.ts` (Phase 1), `src/chat/agent.ts` (no change needed: it already calls `allowedChatTools()` and `captionForToolUse()`), `web/**` (Phase 6), the README connectors section, MCP tools table and Configuration/Tests sections (Phase 1).

## Files

| File | Action | What changes |
|---|---|---|
| `src/chat/status.ts` (whole file, 80 lines) | modify | import connector names; allow list = 13 + 15 + 2; connector captions |
| `src/chat/prompt.ts:19`, `:21`, `:29`, new section after `:27` | modify | section 1 names the three systems; date line covers connector tools; new data-answer section; "say so plainly" covers a failing system |
| `tests/unit/chat-status.test.ts` (whole file) | modify | count 30; connector names present; 15-row captions table; unknown connector name gives null |
| `tests/unit/chat-prompt.test.ts:38` (append tests before final `});`) | modify | assertions for the systems, curated-first rule, opinion rule, units, failure rule, no link instruction |
| `tests/unit/chat-agent.test.ts` | none | `:278` compares against `allowedChatTools()` itself and the caption test uses notes tools only; nothing breaks. Do not edit. |
| `claude/skills/n/SKILL.md:3`, `:9-12`, new section after `:86`, `:105-117` | modify | description triggers; routing section; reply rule; failure rule |
| `README.md` (as phase 1 leaves it): TOC line after `  - [Editing a note, live on the wall](…)`; new subsection before `### More things to ask`; first two paragraphs of `## The chat bar` | modify | `/n` subsection with examples; chat bar paragraphs mention the connectors and their captions |
| `docs/plans/CHAT_BAR_BRAIN_PLAN.md:76` | modify | one sentence noting invariant 4 is superseded |

## Implementation Steps

### Step 1: Allow list and captions for the connector tools
**File:** `src/chat/status.ts` (replace the whole file; current file is 80 lines)
**Change:** import `CONNECTOR_SYSTEMS`, `CONNECTOR_TOOL_NAMES`, `ALL_CONNECTOR_TOOL_NAMES`, `SYSTEM_META` and `SystemId` from Phase 1's `src/connectors/names.ts`. Allow list appends the 15 connector names (prefixed) between the notes tools and the web tools. Captions: exact membership in `CONNECTOR_TOOL_NAMES[system]`, so a made-up `expenses_foo` still gets `null` (the panel names only the real surface, as it does for notes tools today). Every one of the 15 contract names starts with its system id, so "every `expenses_*` tool" and "every name in `CONNECTOR_TOOL_NAMES.expenses`" are the same set.
**Code:**
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
 * Notes tool names match src/mcp/tools.ts and src/mcp/imageTools.ts; connector tool names come
 * from src/connectors/names.ts. Claude Code exposes all of them as `mcp__notes__<name>` because
 * the daemon registers its one MCP server under the name `notes`.
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
  'revisions',
  'revert',
  'create_image',
  'view_images',
] as const;

export type NotesToolName = (typeof NOTES_TOOL_NAMES)[number];

export const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

/** Status-line caption for every tool of one read-only system ('reading expenses' / 'reading runs' / 'reading seer'). */
export const CONNECTOR_CAPTIONS = Object.fromEntries(
  CONNECTOR_SYSTEMS.map((id) => [id, SYSTEM_META[id].caption]),
) as Record<SystemId, string>;

const MCP_PREFIX = `mcp__${NOTES_MCP_SERVER}__`;

/**
 * Exactly the 13 notes tools, the 15 connector tools and WebSearch + WebFetch
 * (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
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

/**
 * The caption for one top-level `tool_use` block, or null for a tool the panel does not name.
 * `input` is the block's raw input; only `ids` (get, view_images) is read.
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
    case 'get':
      return counted(idCount(input), 'reading a note', (n) => `reading ${n} notes`, 'reading notes');
    case 'view_images':
      return counted(idCount(input), 'looking at a photo', (n) => `looking at ${n} photos`, 'looking at photos');
    case 'revisions':
      return 'reading history';
    case 'create':
    case 'create_image':
      return 'saving a note';
    case 'update':
    case 'append':
    case 'revert':
      return 'editing a note';
    case 'delete':
      return 'deleting a note';
    case 'restore':
      return 'restoring a note';
    default:
      return connectorCaption(tool);
  }
}
```
**Impact:** `src/chat/agent.ts:282` picks up the longer list with no change; SDK `permissionMode: 'dontAsk'` now lets the connector tools through. `src/chat/agent.ts:236` emits the new captions. `src/chat` now imports `src/connectors/names.ts` (a pure constants module), nothing else from `src/connectors`.

### Step 2: System prompt names the systems and asks for an opinion
**File:** `src/chat/prompt.ts:18-30` (the `sections` array)
**Change:** replace section 1 (`:19`), the date section (`:21`) and the last section (`:29`); insert a new data-answer section between the pictures section (`:27`) and the prose section. No link instructions (decided: Phase 6 renders links in the panel). The rest of the file (imports, `part`, the function signature, the `isoDate`/`weekday`/`longDate`/`time` lines, `return sections.join('\n\n')`) is unchanged.
**Code:** the full new `sections` array:
```ts
  const sections = [
    `You are the chat bar of mcp-notes, the personal note store of the person typing to you. They are the owner of every note in it, and you answer only them. A note is a plain-text body with #hashtag tags written into it; some notes are image notes (photos and screenshots). You reach the notes only through the notes tools (mcp__notes__*). The owner's three other apps are open to you read-only, each through its own tools on the same server: expense-tracking, their spending in rupiah (expenses_*); run-insights, their Apple Watch runs with the app's own analyses and weekly and monthly reviews, and their coach Nina (runs_*); and Seer, their trading lab with its paper strategies, leaderboard and open positions, plus Sera, the lab that searches for and tests trading methods (seer_*). For those systems use the curated tools first; use a system's _sql tool only when the curated tools do not answer, and call its _schema tool before you write SQL. You cannot change anything in those apps. You may also use WebSearch and WebFetch when the owner asks about something outside their notes and apps.`,

    `Today is ${weekday} ${isoDate} (${longDate}), ${time} in ${timeZone}. Resolve relative dates such as "today", "this week", "last week", "last month" or "30 oct" against that date in that timezone; weeks start on Monday. When a notes tool or one of the apps' tools takes a date, pass YYYY-MM-DD; the server reads it in ${timeZone}.`,

    `Whenever you use a note, quote its id in your answer exactly in the form A-B32: one character, a dash, three characters, upper case. The page highlights notes by finding those ids in your answer text, so every note you relied on must appear by id. Never invent an id.`,

    `You may change notes when the owner asks: edit, append, tag, untag, delete or restore. To tag a note, write the #hashtag into its body. Read a note with get before you update it, and send the whole new body. Do not create a note unless the owner asks for one, and never save your own answer as a note.`,

    `To look at pictures, find the image notes first (list with has_image, or search), then call view_images with their ids and comment on what you actually see.`,

    `When you answer from the owner's spending, runs or Seer, say what the data shows and what you think about it, not just a tally: name the patterns, compare with the previous period or with what is usual for them, point out what stands out, and end with one concrete suggestion. Say which dates you looked at. Give figures in the apps' own units: rupiah as whole numbers written like Rp 38.500 (dots between thousands, no decimals), distance in km, pace as m:ss /km, heart rate in bpm, and Seer money in USD.`,

    `Write plain prose for a small panel: short paragraphs separated by one blank line. No markdown headings, no tables, no bold or italics, no code blocks unless the owner asks for code. Use a list only when the owner asks for one. Answer first, then the supporting detail. If the notes do not hold the answer, say so plainly. If one of the apps' tools returns an error, say which app could not be read and do not guess its numbers.`,
  ];
```
**Impact:** existing assertions in `tests/unit/chat-prompt.test.ts` still pass ("mcp-notes", "owner of every note", "A-B32", "quote its id", "plain prose", "No markdown headings, no tables", "never save your own answer as a note", the date strings). The prompt grows by about 1.2 KB.

### Step 3: Status tests
**File:** `tests/unit/chat-status.test.ts` (replace the whole file)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../src/connectors/names.js';
import { NOTES_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 13 notes tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(13);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(13 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
});

describe('captionForToolUse', () => {
  it.each([
    [n('search'), {}, 'searching notes'],
    [n('list'), {}, 'searching notes'],
    [n('tags'), {}, 'searching notes'],
    [n('get'), { ids: ['A-B32'] }, 'reading a note'],
    [n('get'), { ids: ['A-B32', 'B-C43', 'C-D54'] }, 'reading 3 notes'],
    [n('get'), {}, 'reading notes'],
    [n('view_images'), { ids: ['A-B32'] }, 'looking at a photo'],
    [n('view_images'), { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }, 'looking at 4 photos'],
    [n('view_images'), null, 'looking at photos'],
    [n('revisions'), {}, 'reading history'],
    [n('create'), {}, 'saving a note'],
    [n('create_image'), {}, 'saving a note'],
    [n('update'), {}, 'editing a note'],
    [n('append'), {}, 'editing a note'],
    [n('revert'), {}, 'editing a note'],
    [n('delete'), {}, 'deleting a note'],
    [n('restore'), {}, 'restoring a note'],
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
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it('captions every connector tool in the contract', () => {
    for (const name of ALL_CONNECTOR_TOOL_NAMES) {
      expect(captionForToolUse(n(name), {})).toMatch(/^reading (expenses|runs|seer)$/);
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
**Impact:** the 15-row table is the explicit captions table the scope asks for; the loop test catches a name Phase 1 might add to `names.ts` without a caption.

### Step 4: Prompt tests
**File:** `tests/unit/chat-prompt.test.ts:38` — insert these `it` blocks after the `'uses the daemon timezone by default'` test (ending at `:37`) and before the final `});` at `:38`.
**Code:**
```ts
  it('names the three read-only apps and how to reach them', () => {
    expect(prompt).toContain('expense-tracking');
    expect(prompt).toContain('run-insights');
    expect(prompt).toContain('Seer');
    expect(prompt).toContain('Sera');
    expect(prompt).toContain('Nina');
    expect(prompt).toMatch(/read-only/);
    expect(prompt).toContain('expenses_*');
    expect(prompt).toContain('runs_*');
    expect(prompt).toContain('seer_*');
  });

  it('prefers curated tools and keeps _sql last, after _schema', () => {
    expect(prompt).toMatch(/curated tools first/);
    expect(prompt).toMatch(/_sql tool only when the curated tools do not answer/);
    expect(prompt).toMatch(/_schema tool before you write SQL/);
  });

  it('asks data answers for what the data shows and an opinion, not a tally', () => {
    expect(prompt).toMatch(/what the data shows and what you think about it, not just a tally/);
    expect(prompt).toMatch(/one concrete suggestion/);
  });

  it("asks for the apps' own units", () => {
    expect(prompt).toContain('Rp 38.500');
    expect(prompt).toContain('m:ss /km');
    expect(prompt).toContain('USD');
  });

  it('forbids guessing numbers when an app fails', () => {
    expect(prompt).toMatch(/say which app could not be read and do not guess its numbers/);
  });

  it('leaves link formatting to the panel', () => {
    expect(prompt).not.toMatch(/markdown link|bare URL/i);
  });
```
**Impact:** none outside the test.

### Step 5: `/n` skill routes data questions
**File:** `claude/skills/n/SKILL.md`

5a. **`:3`** — replace the `description:` line with:
```yaml
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server, which also reads the user's own apps read-only — expense-tracking (spending in rupiah), run-insights (Apple Watch runs, the app's run analyses and weekly/monthly reviews, coach Nina) and Seer (trading lab, leaderboard, positions, Sera methods). Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at pictures they saved ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct"), or ask about their spending, expenses, runs or Seer ("how is my spending this week", "how did yesterday's run go", "compare my running this month with last month", "what are the best Sera methods so far", "what's on the Seer leaderboard").
```

5b. **`:9-12`** — replace the opening paragraph with:
```markdown
The text after `/n` is a request for mcp-notes, the user's own notes store, or for one of the
user's apps that the same server reads. Do it with the `notes` MCP server's tools (they appear
as `mcp__notes__<tool>`). Do not answer from memory, from files in the current repo, or from
earlier conversation when the request is about notes, spending, runs or Seer: the notes and the
apps' tools are the source of truth.
```

5c. **After `:86`** (end of "Comparisons and summaries", before `## Images`) — insert this new section:
```markdown
## Spending, runs and Seer

The same server reads three of the user's own apps, read-only. Nothing you do through these
tools can change them, and you must not try. Questions about money spent, expenses, runs,
training, the Seer leaderboard, positions, strategies or Sera methods go to these tools, not to
the notes (unless the user asks about notes on those topics).

Each system has curated tools that compute what the app itself shows. Use them first. Use a
system's `_sql` tool only when no curated tool answers the question, and call its `_schema` tool
before writing SQL so you use real table and column names. `_sql` takes one `SELECT` and caps
the rows. Follow each tool's own schema for parameter names; it wins over anything here.

expense-tracking (spending, money in whole rupiah):
- `expenses_spending` — `from`/`to` (inclusive WIB days, up to 366): total, by category (slug
  plus Indonesian label), by day, by ISO week (Monday to Sunday, keyed by its Monday; weeks the
  range cuts are `partial`), and the largest items. Start here for "how much did I spend", "this
  week", "on meals in October", "which week was worst". Narrow with `categories`, a list of slugs:
  `["meals"]` is everyday meals only; all eating and drinking is
  `["meals", "jajan", "dining", "snacks", "drinks"]`. When comparing weeks, mind the partial ones.
- `expenses_months` — monthly totals for the last `months` (default 6) ending at `to_month`
  (`YYYY-MM`, default this month), zero-filled; the current month is `in_progress`. Use it for
  month-over-month trends. Takes the same `categories`.
- `expenses_get` — one expense group by `id` (from `expenses_spending`'s
  `largest_items[].group_id`): its items, note, original pasted text and photos. Use it to explain
  a big line or a specific purchase.
- `expenses_schema`, `expenses_sql` — anything the three above cannot answer.

run-insights (Apple Watch runs; metres, seconds, sec/km, bpm, each with a readable companion):
- `runs_list` — reviewed runs from `from` to `to` (default today) with their key metrics, the
  app's own headline for each, and period totals. Use it for "my runs this month", and call it
  once per period for "this month vs last month".
- `runs_get` — exactly one of `id` (from `runs_list`) or `date` (`YYYY-MM-DD`, every run that
  day): metrics, per-km splits, heart-rate zones, the runner's note and the app's own latest
  analysis of the run. Use `date` for "how did yesterday's run go".
- `runs_review` — `scope` `week` or `month`, `key` like `2026-W44`, `2026-10` or any day inside
  the period (default: the current one): the app's latest review for that period with its totals
  and runs. `review` is null when the app has not written one; the totals still hold.
- `runs_schema`, `runs_sql` — anything else (records, badges, the coach Nina's chat).

Seer (trading lab, money in USD; dates are New York trading sessions) and Sera (its method lab):
- `seer_leaderboard` — the paper strategies ranked the way the app ranks them, over a common
  window (name the window when you say who leads); the benchmark, retired and too-new strategies
  are listed apart with a reason.
- `seer_positions` — open bracket orders and book positions with marks and unrealised P&L.
  Optional `strategy` (an id from the leaderboard) and `include_pending`.
- `seer_sera_best` — the best dev variant of each Sera method by MAR, with the lab's metrics,
  recomputed hurdles and test trials. Use it for "best Sera methods". `eligible_at_run` is the
  verdict when the trial ran, so say "eligible when it ran", not "eligible". Optional `status`,
  `only_eligible`, `limit`.
- `seer_schema`, `seer_sql` — anything else; `seer_sql` reads either the Postgres database or
  the lab (`source` `db` or `lab`).

Dates: the user's days are WIB (Asia/Jakarta). A week runs Monday to Sunday; "this week" is
Monday until today; "yesterday" and "this month" are WIB calendar days. Pass dates as
`YYYY-MM-DD`. For a comparison, call the tool once per period and compare the results yourself.

The answer is not a tally. Say what the data shows, then what you think about it: the pattern,
how it compares with the previous period or with what is usual for the user, what stands out,
and at least one concrete suggestion. Give figures in the app's units: rupiah as whole numbers
written `Rp 38.500`, distance in km, pace as `m:ss /km`, heart rate in bpm, Seer money in USD.
State the date range you used. Keep it to short paragraphs.
```

5d. **`:105-110`** ("Replies") — replace the section body with (adds the last bullet):
```markdown
## Replies

- Quote note ids exactly (`A-B32`) every time you mention a note, so the user can copy them.
- Keep replies short. Show a note's body only when the user asks to see it or it is short.
- If the request is ambiguous between two readings, pick the likelier one, do it, and say which
  reading you took.
- Answers from spending, runs or Seer follow the rule in "Spending, runs and Seer": what the
  data shows plus your own read and a suggestion.
```

5e. **`:112-117`** (failure section) — replace with:
```markdown
## When the `notes` tools are missing or fail to connect

Say so plainly and suggest, in this order: `systemctl --user status notesd`,
`curl -s http://127.0.0.1:7317/health`, `journalctl --user -u notesd -n 50`, and re-running
`scripts/install.sh` from the mcp-notes checkout (`~/mcp-notes`). Do not fall back to writing
notes into files.

A connector tool that fails returns an error naming its system ("expense-tracking is not
reachable: …", "run-insights query failed: …"). Tell the user which system failed and why, in
one line. Do not guess or estimate its numbers, and do not reach into the app's repo or
database any other way. The notes and the other systems still work; answer what they can.
```

**Impact:** text only; the skill is symlinked into `~/.claude/skills/n` by `install.sh`, so it takes effect in new Claude Code sessions with no reinstall.

### Step 6: README chat bar and `/n` paragraphs
**File:** `README.md`, as phase 1 leaves it (this phase runs after phase 1, so line numbers below are not used; anchor on the quoted text). Do not touch the connectors section, MCP tools table, Tests, Configuration, Limitations or the Repository layout line (Phase 1 owns those). Phase 1's TOC line `- [Connectors: spending, runs, Seer](#connectors-spending-runs-seer)` sits after `- [The chat bar](#the-chat-bar)`, two lines below this phase's insertion; leave it in place. No hunk here overlaps a phase 1 hunk.

6a. **TOC, under "Using it from Claude Code"** — after `  - [Editing a note, live on the wall](#editing-a-note-live-on-the-wall)` and before `  - [More things to ask](#more-things-to-ask)` insert:
```markdown
  - [Spending, runs and Seer](#spending-runs-and-seer)
```

6b. **Before `### More things to ask`** (after the `cc-edit.gif` image line) — insert:
~~~~markdown
### Spending, runs and Seer

The same server reads three of your own apps, read-only: expense-tracking (spending in rupiah),
run-insights (Apple Watch runs, the app's analyses and reviews, coach Nina) and Seer (the trading lab's
leaderboard and positions, and the best Sera methods). `/n` sends questions about them to their
curated tools, falls back to a system's `_sql` tool only when those don't answer, and replies
with what the data shows plus Claude's own read and a suggestion, not a tally. The tools are
listed under [Connectors](#connectors-spending-runs-seer).

```
/n how are my spending this week? don't just tally the numbers and give me your inputs
/n i did a run yesterday. show me how it went. what are your thoughts on this run?
/n compare my running this month with last month
/n what are the best sera method that we have found up until now?
```

~~~~

6c. **The first two paragraphs of `## The chat bar`** (from `The pill at the bottom of the wall` through `Answers are not saved as notes.`; phase 1 does not change them) — replace with:
```markdown
The pill at the bottom of the wall is a natural-language command line. Its answer streams into a
panel that rises above it, which you can pin or dismiss. A terse status line ("searching
notes", "looking at 2 photos", "reading expenses", "reading runs", "reading seer", "searching
the web") shows what the agent is doing. Notes the answer mentions are outlined on the wall and
the rest dim. Chips under the answer jump to each note, switching the view if that note is
hidden.

Behind it is the Claude Agent SDK: headless Claude Code on your existing login, one run per
message, with the same tools `/n` uses: the `notes` tools, the read-only tools for
expense-tracking, run-insights and Seer, and web search. Ask it "how much did i spend on meals
in october, and which week was the worst?" and it answers with the numbers and an opinion. A
follow-up continues the same thread. Dismissing the panel starts a new one. Answers are not
saved as notes.
```

**Impact:** docs only. The anchor `#spending-runs-and-seer` is generated from the new heading.

### Step 7: Note on the superseded invariant
**File:** `docs/plans/CHAT_BAR_BRAIN_PLAN.md:76`
**Change:** append one sentence to the end of invariant 4's line, so it reads:
```markdown
4. The agent's tool surface is exactly the 13 `notes` MCP tools (`mcp__notes__*`) + `WebSearch` + `WebFetch`. No user settings, CLAUDE.md, hooks, plugins or other MCP servers are loaded into the SDK run. (Superseded by iteration 5, `CONNECTORS_PLAN.md` invariant 8: the surface also includes the 15 connector tools.)
```
**Impact:** none.

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command.
**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: `chat-status`, `chat-prompt`, `chat-agent` must pass). `npm run test:int` stays green (this phase changes nothing it exercises).
**Manual check:** with Phase 1–4 landed and notesd restarted, in the chat bar at http://localhost:7317 ask "how much did i spend on meals in october, and which week was the worst?" — the status line shows "reading expenses", the answer uses `Rp 38.500`-style figures, names the worst week and gives an opinion. In Claude Code run the four `/n` acceptance prompts from the index and check they call `expenses_spending`, `runs_get`, `runs_list` (twice) and `seer_sera_best` respectively, and answer with a read plus a suggestion.
**Exit criteria:** `allowedChatTools()` returns 30 names (13 notes + 15 connector + 2 web) and nothing else; `captionForToolUse` returns "reading expenses" / "reading runs" / "reading seer" for each of the 15 connector tools and null for unknown names; the chat system prompt names expense-tracking, run-insights, Seer and Sera, says curated first / `_sql` last / `_schema` before SQL, and asks for what the data shows plus an opinion in the apps' units; `/n` SKILL.md routes spending/runs/Seer questions to the named tools; typecheck and unit tests are green.

## Handoffs

- **Phase 1 (R1/R2):** `src/connectors/names.ts` must exist exactly as the index contract writes it, with no imports of runtime modules (so `src/chat/status.ts` and the unit test can import it without `pg`/`node:sqlite` side effects). If Phase 1 changes any of the 15 names, `tests/unit/chat-status.test.ts`'s explicit caption table must change with it.
- **Phase 1 (R2), reconciled:** the MCP instructions paragraph (`src/mcp/instructions.ts`, phase 1) now reads "Prefer the curated tools (…); use <system>_sql … only when they don't answer, and call <system>_schema before writing SQL", the same rule in the same order as this phase's prompt and skill (curated first, `_sql` last, `_schema` before SQL). The three texts stay separate on purpose.
- **Phase 1 (README), reconciled:** the connectors section, the 15 tool rows and their TOC line are phase 1's and land before this phase; this phase's three hunks touch other lines.
- **Phases 2–4 (R2), reconciled:** the skill's tool lines were aligned to phases 2–4's schemas (inputs above). `runs_get`'s analysis is the app's own `insights` row, not Nina's; Nina is the coach chat (`nina_*`), reached only through `runs_sql`.
- **Phase 6 (R4):** link rendering in the panel. This phase deliberately adds no link instruction to the prompt; a test asserts that.
- Not done, out of scope: `docs/INSTALL.md` (no chat/`/n` content changes needed), `src/chat/agent.ts` (no change needed).

## Rollback

Revert this phase's commit. It touches only `src/chat/status.ts`, `src/chat/prompt.ts`, two unit tests, the skill file, two README spots and one line in an old plan; nothing else imports the new export `CONNECTOR_CAPTIONS`. With the revert, the chat bar falls back to 13 + 2 tools (connector calls are denied by `dontAsk`), which is safe whether or not Phases 1–4 stay.
