# Phase 2: Wall URL into MCP instructions, skill link rule, tmux + docs

**Plan set:** `NOTE_ID_DEEPLINKS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-180927-N8LK_code_analyzer.md`
**Satisfies:** R2, R4 — a note id in a Claude Code reply is a Ctrl+clickable markdown link to the wall, built from the daemon's configured port; the WSL2 + tmux setting that lets it through is documented
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/mcp` (plus `src/http/app.ts`, `claude/skills/n`, `README.md`, `docs/INSTALL.md`)

---

## Goal

After this phase the `notes` MCP server's instructions carry a `Links.` paragraph naming the wall
URL (`http://localhost:<Config.port>`) and the exact link form `[A-B32](<wall>/?note=A-B32)`, so
every Claude Code session, with or without `/n`, writes note ids as clickable links. The `/n`
skill says the same, takes the URL from those instructions (fallback: `claude mcp get notes`
minus `/mcp`), and no longer hard-codes `7317`. README and `docs/INSTALL.md` explain the feature
and the one tmux line (`terminal-features ... hyperlinks`) this machine needs for OSC 8 to reach
Windows Terminal.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `wallUrlForPort(port: number): string | undefined` (`src/mcp/instructions.ts`) — `http://localhost:<port>` for an integer port 1..65535, else `undefined` (port 0 = "any free port" in tests).
- `DEFAULT_WALL_URL` const (`src/mcp/instructions.ts`) = `http://localhost:7317` (built from `DEFAULT_PORT`).
- `mcpToolDeps(deps: AppDeps): ToolDeps` (`src/http/app.ts`) — the `ToolDeps` the `/mcp` route uses, now including `wallUrl`.
- `ToolDeps.wallUrl?: string` (`src/mcp/tools.ts`).
- Instructions paragraph starting with `Links.` (exactly one).
- Docs: README subsection `### Clickable note ids` (+ its Contents entry), `docs/INSTALL.md` section `## 8. Clickable ids under WSL2 + tmux`.

**Signature changes:** `buildInstructions(timeZone?: string)` -> `buildInstructions(timeZone?: string, wallUrl?: string)` (second parameter optional, all existing callers compile unchanged).
**Requires (from earlier phases):** nothing. The instructions say the wall scrolls to `?note=<id>`; Phase 1 makes that true, but nothing in this phase's code or tests depends on Phase 1.
**Link form (shared with Phases 1 and 3, Invariant 4):** `[<ID>](<wall>/?note=<ID>)`, `<ID>` canonical upper-case `A-B32` with the dash, `<wall>` without trailing slash.
**Leaves alone (owned by others):** `web/**` and the README paragraph under "A tour of the wall" (Phase 1); `claude/mods/**` and the README "Repository layout" line (Phase 3); `scripts/install.sh` (its `PORT=7317` stays, out of scope); `~/.tmux.conf.local` and every other dotfile; `src/daemon.ts` and `src/config.ts` (read, not changed).

## Files

| File | Action | What changes |
|---|---|---|
| `src/mcp/instructions.ts` | modify | import `DEFAULT_PORT`; add `wallUrlForPort`, `DEFAULT_WALL_URL`; `buildInstructions` gains `wallUrl` and a `Links.` paragraph after `Ids.` (line 20) |
| `src/mcp/tools.ts` | modify | `ToolDeps.wallUrl?: string` (lines 10-17) |
| `src/mcp/server.ts` | modify | line 14: `buildInstructions(undefined, deps.wallUrl)` |
| `src/http/app.ts` | modify | new exported `mcpToolDeps(deps)`; line 41 uses it |
| `tests/unit/mcp.instructions.test.ts` | modify | Links paragraph tests, non-default port test (4321 present, 7317 absent), `wallUrlForPort`, `mcpToolDeps`, and an in-process `initialize` through `handleMcpRequest` (no port bound) |
| `claude/skills/n/SKILL.md` | modify | Saving (line 51-53), Deleting (192-194), Replies (200-202), failure section (211-213) |
| `README.md` | modify | Contents entry (after line 26), new `### Clickable note ids` before `### Spending, runs and Seer` (line 296), `NOTESD_PORT` row (line 527) |
| `docs/INSTALL.md` | modify | new `## 8. Clickable ids under WSL2 + tmux` before `## Uninstall` (line 331) |

`src/daemon.ts` needs no change: it calls `createApp(deps, { chat })` (line ~94) with the full `Config`, and `createApp` is where `ToolDeps` is built.

## Implementation Steps

### Step 1: Wall URL and the `Links.` paragraph in the instructions
**File:** `src/mcp/instructions.ts:1` (import), `:8-12` (new helpers above `buildInstructions`), `:12` (signature), `:20` (insert the paragraph right after the `Ids.` paragraph)
**Change:** add `wallUrlForPort` and `DEFAULT_WALL_URL`; `buildInstructions` takes an optional `wallUrl` (trailing slashes stripped) and inserts a `Links.` paragraph. The `Ids.` paragraph is unchanged.
**Code:** the whole file after the change:
```ts
import { DEFAULT_PORT } from '../config.js';
import { CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES } from '../connectors/names.js';

/** Local IANA timezone of the daemon, e.g. Asia/Jakarta. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The wall's base URL for a daemon port, as Claude should write it in links: `localhost` (what
 * Windows reaches through WSL2 localhost forwarding), no trailing slash. Undefined for port 0
 * ("any free port", tests) or anything that is not a real TCP port.
 */
export function wallUrlForPort(port: number): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://localhost:${port}`;
}

/** The wall URL when the caller does not know the port (the default `NOTESD_PORT`). */
export const DEFAULT_WALL_URL = `http://localhost:${DEFAULT_PORT}`;

/**
 * MCP server instructions: Claude reads these once per session. Phase 5 appends one paragraph
 * about image notes to `sections`. Iteration 5 phase 1 appends the connectors paragraph.
 * `wallUrl` is the wall's base URL (from `Config.port` via `wallUrlForPort`); it goes into the
 * Links paragraph so note ids in replies become clickable links to the wall.
 */
export function buildInstructions(timeZone: string = localTimeZone(), wallUrl: string = DEFAULT_WALL_URL): string {
  const wall = wallUrl.replace(/\/+$/, '');
  const sections = [
    `mcp-notes is the user's personal note store: plain-text notes kept in Postgres and shared by every Claude Code session on this machine (and the user's other laptop, which uses the same database). Use these tools whenever the user asks to save, find, read, change, summarise or compare their notes, usually through the /n skill.`,

    `Notes. A note is a single plain-text body: no title, no fields, no other structure. Put everything in the body. Tags are the #hashtags written in the body (#seer, #v250, #from_phone); the server re-parses them from the body on every write and lower-cases them. To tag a note, write the hashtag into its body (update or append); to untag it, remove the hashtag from the body. Tag filters accept "seer" or "#seer". Every note returned has id, body, tags, created_at and updated_at (ISO 8601, UTC), origin (where it was saved from: cwd, repo, claude_session; may be null) and images (an array, empty for text notes).`,

    `Ids. Ids look like A-B32: one character from 0-9/A-Z, a dash, three characters from 0-9/A-Z. The server generates them; never invent one. Lookup is case-insensitive and tolerates a missing dash, so "ab32", "a-b32" and "AB32" all find A-B32. When you mention a note to the user, quote its id in the canonical A-B32 form.`,

    `Links. The wall, the user's web page for these notes, is at ${wall}, and ${wall}/?note=A-B32 opens it scrolled to note A-B32. Every time you mention a note id to the user, write it as a markdown link in exactly this form: [A-B32](${wall}/?note=A-B32), with the canonical id (upper case, with the dash) as both the link text and the note value, so the user's terminal shows it as a link they can click. Links are for your replies only: never put them in note bodies and never in tool arguments (ids you pass to tools stay bare, A-B32), and do not write one inside a code span or code block, where it would not render.`,

    `Writing. create needs a non-empty body; when saving from a repository pass origin {cwd, repo, claude_session} so the note remembers where it came from. update replaces the whole body (read the note first with get, then send the full new text); append adds text at the end after a blank line. Every body change keeps the previous body as a revision: revisions(id) lists them and revert(id, revision) brings one back, keeping the body it replaces as a new revision. delete is soft: the note leaves list, search and tags but restore(id) brings it back; list with deleted="only" finds deleted notes.`,

    `Reading. get takes one or several ids. list returns notes newest first, filtered by tags (tags_any: at least one; tags_all: every one) and a date range (from/to, on the created or updated date), with paging via limit and next_cursor. search understands meaning, not only words: by default (mode "hybrid") it blends word matches, closeness in meaning, matching tags and recency, so "ArangoDB credentials" finds a note that says "arango root password is in the vault" and "have we seen auth failures after resume?" finds "the login broke after the laptop slept". Pass the user's question in plain words; a note id or code token that appears word for word still ranks first. For exact-word search pass mode "text": the "simple" configuration, exact words and code tokens, no stemming, "quoted phrases", OR and -exclusions, ranked by relevance, then recency. Every search result says which mode it used; when it carries a fallback, meaning search was unavailable and only word matches came back, so tell the user. tags lists every tag with its note count and the time it was last used.`,

    `Related. related(id) returns the notes closest in meaning to one note, most similar first with a similarity score (1 = same meaning, near 0 = unrelated), never the note itself or a deleted note; use it for "what else do I have on this?" or "what other notes are related to A-B32?".`,

    `Dates. from and to accept YYYY-MM-DD or a full ISO 8601 datetime. A YYYY-MM-DD value means the whole day in the daemon's local timezone, ${timeZone}: from starts at that day's midnight and to includes the whole day. Datetimes are exact.`,

    `Comparisons and summaries ("this week vs last week", "#seer vs #v250", "what was my last note about X") are your job, not the server's: call list or search once per side with the right filters, page with next_cursor if needed, then compare or summarise the results yourself.`,

    `Images. A note can hold several images: photos or screenshots saved on the laptop that stored them. Every note returned by get/list/search has an images array, empty for text notes, otherwise one entry per image in the order they were added, each {id, note_id, position, mime, width, height, bytes, taken_at, original_name, host, available, urls}. An image id looks like a note id; a note's first image shares the note's id. To look at pictures, find the ids first, then call view_images with up to 8 note ids or image ids: a note id shows every image of that note, at most 8 images come back per call, and a last line lists the image ids left for the next call. "Show me pictures I saved on 30 oct" means list with has_image: true (notes with at least one image) and from/to for that day, then view_images on the ids. "Photos taken last week" uses taken_from/taken_to (the camera's EXIF date; a note matches when any of its images was taken then). To save a local image file (for example a screenshot path you have), call create_image with its absolute path and optional body text; it becomes a new note, the file is copied, not moved, and saving a file that already lives in a note returns that note. available: false means that image's file lives on another machine (host): the note's text is still there, but that picture cannot be viewed here.`,

    `Attaching. A note can hold several images, in attach order; each entry of a note's images has its own id (image ids look like note ids; the first image of a note saved from a picture has the note's own id). attach_image(id, path) adds a local image file to an existing note: the file is copied, not moved. If the same file already lives in a note (that one or another), nothing is copied and that note comes back with attached: false, so tell the user where the picture already is. remove_image(image_id) takes one image out of its note: it is soft, the image goes to the recycle bin with its file untouched, and restore_image(image_id) puts it back at its old position (restoring its note too if the note was deleted). Nothing you can call deletes a note or an image permanently; only the user can, from the recycle bin in the web page.`,
    `Connectors. The same server also reads three of the user's own apps, strictly read-only (nothing there can be changed from here): expenses_* is expense-tracking (spending parsed from pasted text, in rupiah, with categories and receipt photos), runs_* is run-insights (Apple Watch runs with pace, distance, heart rate and splits, weekly and monthly reviews, and the coach Nina), seer_* is Seer (a quantitative trading lab: strategies, positions, trades, a leaderboard, and Sera, the method lab, in lab.sqlite). Prefer the curated tools (${CONNECTOR_SYSTEMS.flatMap((id) => CONNECTOR_TOOL_NAMES[id].slice(2)).join(', ')}); use <system>_sql (one read-only SELECT, row-capped; seer_sql takes source "db" or "lab") only when they don't answer, and call <system>_schema before writing SQL so the table and column names are real. Dates are calendar days in Asia/Jakarta (WIB), money is whole rupiah (Seer: US dollars), and run units are the app's own (metres, seconds, sec/km, bpm). If a system is not reachable the tool returns a short error; say so and answer from the rest.`,
  ];
  return sections.join('\n\n');
}
```
**Impact:** every MCP `initialize` answer gains one paragraph. `src/chat/prompt.ts` imports only `localTimeZone` from this file; unaffected. `src/config.ts` exports `DEFAULT_PORT` already (line 16) and has no import of `src/mcp/*`, so no cycle. The chat bar's agent also reaches this server, so its answers get the same link rule; the wall's `extractUsedIds` matches ids anywhere in the text, so a linked id is still cited (it appears twice in the markdown: link text and URL; `extractUsedIds` returns a set — if Phase 1 or a reviewer finds double counting, that is a wall concern, see Handoffs).

### Step 2: `ToolDeps.wallUrl`
**File:** `src/mcp/tools.ts:10-17`
**Change:** add the optional field.
**Code:**
```ts
export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
  /** Connectors for the connector tools. Omitted: defaultConnectors() (sibling repos, read per call). Tests inject their own. */
  connectors?: Connectors;
  /**
   * The wall's base URL (`http://localhost:<port>`, no trailing slash) named in the instructions'
   * Links paragraph. Omitted: `DEFAULT_WALL_URL` (port 7317), e.g. a daemon on port 0 in tests.
   */
  wallUrl?: string;
}
```
**Impact:** optional; `toolImageDeps`, `toolAttachDeps` and the integration tests that build `ToolDeps` literals (`tests/integration/search.hybrid.int.test.ts:293`) compile unchanged.

### Step 3: Pass it into the instructions
**File:** `src/mcp/server.ts:11-15`
**Code:**
```ts
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(undefined, deps.wallUrl) },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  // Lazy: nothing is read or connected until a connector tool is called.
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  return server;
}
```
**Impact:** `undefined` for either argument selects its default (`localTimeZone()`, `DEFAULT_WALL_URL`).

### Step 4: Build `ToolDeps` from `Config` in one exported place
**File:** `src/http/app.ts:1-9` (imports), new function above `createApp` (after line 32), line 41
**Change:** add imports `type ToolDeps` from `../mcp/tools.js` and `wallUrlForPort` from `../mcp/instructions.js`; add `mcpToolDeps`; `createApp` uses it.
**Code:** imports block after the change:
```ts
import { Hono, type MiddlewareHandler } from 'hono';
import type { ChatBackend } from '../chat/backend.js';
import type { AppDeps } from '../deps.js';
import { wallUrlForPort } from '../mcp/instructions.js';
import { handleMcpRequest } from '../mcp/server.js';
import type { ToolDeps } from '../mcp/tools.js';
import { apiRoutes } from './api.js';
import { imageRoutes } from './images.js';
import { revealRoutes, type RevealDeps } from './reveal.js';
import { isLoopbackUrl } from './sameOrigin.js';
import { staticRoutes } from './static.js';
```
New function, inserted between `CreateAppOptions` and the `createApp` doc comment:
```ts
/**
 * What POST /mcp hands the MCP server. `wallUrl` comes from `Config.port` (`NOTESD_PORT`), so the
 * instructions' Links paragraph names the port this daemon is configured for. Port 0 (tests: "any
 * free port", only known after listen) leaves it unset and the instructions fall back to 7317.
 */
export function mcpToolDeps(deps: AppDeps): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  };
}
```
`createApp` body, line 41 changes from the inline object literal to:
```ts
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const toolDeps = mcpToolDeps(deps);

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', imageRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', staticRoutes(deps));
  return app;
}
```
**Impact:** production (`NOTESD_PORT` unset) produces `http://localhost:7317`, identical to the default. A non-default `NOTESD_PORT` now reaches Claude. Why `localhost` and not `config.host` (`127.0.0.1`): the README, INSTALL and the `claude mcp add` URL all use `localhost`, and Windows reaches the WSL daemon through localhost forwarding; the URL is for the Windows browser.

### Step 5: Unit tests
**File:** `tests/unit/mcp.instructions.test.ts` — replace the import block (lines 1-5) and add two `describe` blocks after the existing `describe('buildInstructions', ...)` (before `describe('toFilter', ...)`, line 71). Existing tests stay as they are.
**Code:** import block:
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { loopbackOnly, mcpToolDeps } from '../../src/http/app.js';
import { DEFAULT_WALL_URL, buildInstructions, wallUrlForPort } from '../../src/mcp/instructions.js';
import { handleMcpRequest } from '../../src/mcp/server.js';
import { toFilter, type ToolDeps } from '../../src/mcp/tools.js';
import type { NotesService } from '../../src/notes/service.js';
```
New blocks:
```ts
function linksParagraphs(text: string): string[] {
  return text.split('\n\n').filter((p) => p.startsWith('Links.'));
}

describe('Links paragraph', () => {
  it('has exactly one, after Ids, naming the default wall and the exact link form', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = linksParagraphs(text);
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(DEFAULT_WALL_URL).toBe('http://localhost:7317');
    expect(p).toContain('http://localhost:7317');
    expect(p).toContain('[A-B32](http://localhost:7317/?note=A-B32)');
    expect(p).toContain('Every time you mention a note id to the user');
    expect(p).toContain('canonical id');
    expect(p).toContain('never put them in note bodies');
    expect(p).toContain('never in tool arguments');
    expect(p).toContain('code span');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Links')).toBe(order.indexOf('Ids') + 1);
  });

  it('uses a non-default port everywhere and never mentions 7317', () => {
    const text = buildInstructions('Asia/Jakarta', 'http://localhost:4321');
    const p = linksParagraphs(text)[0]!;
    expect(p).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(p).toContain('is at http://localhost:4321,');
    expect(text).not.toContain('7317');
  });

  it('drops a trailing slash from the wall URL', () => {
    const p = linksParagraphs(buildInstructions('Asia/Jakarta', 'http://localhost:4321/'))[0]!;
    expect(p).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(p).not.toContain('4321//');
  });
});

describe('wall URL from the configured port', () => {
  it('wallUrlForPort builds localhost URLs and refuses port 0 and non-ports', () => {
    expect(wallUrlForPort(7317)).toBe('http://localhost:7317');
    expect(wallUrlForPort(4321)).toBe('http://localhost:4321');
    expect(wallUrlForPort(0)).toBeUndefined();
    expect(wallUrlForPort(-1)).toBeUndefined();
    expect(wallUrlForPort(70000)).toBeUndefined();
    expect(wallUrlForPort(1.5)).toBeUndefined();
  });

  function appDeps(port: number): AppDeps {
    // Only config.port, config.dataDir, service and db are read by mcpToolDeps.
    return { config: { port, dataDir: '/nonexistent' }, service: {}, db: {} } as unknown as AppDeps;
  }

  it('mcpToolDeps carries Config.port into ToolDeps.wallUrl, and leaves it out for port 0', () => {
    expect(mcpToolDeps(appDeps(4321)).wallUrl).toBe('http://localhost:4321');
    expect(mcpToolDeps(appDeps(7317)).wallUrl).toBe('http://localhost:7317');
    expect('wallUrl' in mcpToolDeps(appDeps(0))).toBe(false);
    expect(mcpToolDeps(appDeps(4321)).dataDir).toBe('/nonexistent');
  });

  async function initializeInstructions(deps: ToolDeps): Promise<string> {
    // In-process: handleMcpRequest takes a web Request, so nothing listens on any port.
    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit', version: '0' } },
        }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { instructions?: string } };
    return body.result?.instructions ?? '';
  }

  // Tool registration is lazy (no service, db or connector call happens on initialize), so fakes suffice.
  const fakeDeps = (wallUrl?: string): ToolDeps => ({
    service: {} as NotesService,
    dataDir: '/nonexistent',
    db: {} as Db,
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  });

  it('the MCP initialize answer names the configured wall URL', async () => {
    const custom = await initializeInstructions(fakeDeps('http://localhost:4321'));
    expect(custom).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(custom).not.toContain('7317');
    const fallback = await initializeInstructions(fakeDeps());
    expect(fallback).toContain('[A-B32](http://localhost:7317/?note=A-B32)');
  });
});
```
**Impact:** no port is bound (Invariant 2): `handleMcpRequest` and `mcpToolDeps` are called in-process. If the `initialize` test fails because something in tool registration touches `service`/`db` eagerly (not the case at `main` @ 2a8530e: `toolImageDeps` and `dbImageRecords` only build closures, connectors are lazy), switch `fakeDeps` to the `{} as never` casts already used and assert on `createMcpServer(...)` via `InMemoryTransport` instead — do not bind a port.

### Step 6: `/n` skill: link rule, no hard-coded port
**File:** `claude/skills/n/SKILL.md` — four edits. `~/.claude/skills/n` is a symlink to `~/mcp-notes/claude/skills/n` (made by `scripts/install.sh` step 8), so once this lands on `main` the installed skill is the new text with no re-install. Do not run `scripts/install.sh` from the worktree.

**6a. Saving, lines 51-53** — replace the bullet with:
```markdown
- Bodies are plain text. No markdown: no `#` headings (a `#word` heading becomes a tag), no
  `**bold**`, no backtick fences, no tables, no links. Line breaks and a plain `- ` at the start
  of a line are fine. Code tokens, paths, commands and ids are fine inline; write ids bare
  (`A-B32`), never as the wall links used in replies.
```

**6b. Deleting, lines 192-194** — replace the first paragraph with:
```markdown
Delete only when the user asks, and only the notes or images they named. `delete` (a note) and
`remove_image` (one image) are soft. Both land in the recycle bin on the wall ("Deleted." on the
wall, at the wall URL described under Replies). Reply with the ids and say `restore` /
`restore_image` brings them back.
```

**6c. Replies, lines 200-202** — replace the section heading's first bullet (`- Quote note ids exactly ...`) with these three bullets (the remaining Replies bullets stay):
```markdown
## Replies

- Write every note id you mention as a markdown link to the wall, in exactly this form:
  `[A-B32](<wall>/?note=A-B32)`. The id is canonical (upper case, with the dash) and is both
  the link text and the `note` value; `<wall>` has no trailing slash. A terminal that supports
  hyperlinks lets the user Ctrl+click it to open the wall on that note, and the link text is
  still the id they can copy.
- `<wall>` is the wall URL in the `notes` server's instructions (their "Links." paragraph,
  built from the daemon's port). If you cannot see it there, run `claude mcp get notes` and take
  its URL without the trailing `/mcp` (normally `http://localhost:7317`). Never guess another
  port.
- Links are for your replies only. Ids stay bare (`A-B32`) in note bodies, in tool arguments,
  and inside code spans or code blocks, where a link does not render.
- Keep replies short. Show a note's body only when the user asks to see it or it is short.
- If the request is ambiguous between two readings, pick the likelier one, do it, and say which
  reading you took.
- Answers from spending, runs or Seer follow the rule in "Spending, runs and Seer": what the
  data shows plus your own read and a suggestion.
```

**6d. Failure section, lines 211-214** — replace the first paragraph with:
```markdown
Say so plainly and suggest, in this order: `systemctl --user status notesd`,
`curl -s <wall>/health` (the wall URL from Replies; `http://localhost:7317` unless `NOTESD_PORT`
changed it), `journalctl --user -u notesd -n 50`, and re-running `scripts/install.sh` from the
mcp-notes checkout (`~/mcp-notes`). Do not fall back to writing notes into files.
```
**Impact:** the skill no longer contains a bare `7317` except as the stated default; the Deleting and failure lines no longer contradict a non-default port. The "Save this session's insights" section (line 66, "reply with the new id") inherits the link rule through Replies; no edit there.

### Step 7: README
**File:** `README.md` — three edits, nowhere else (Phase 1 owns the "A tour of the wall" paragraph, Phase 3 one "Repository layout" line).

**7a. Contents, after line 26** (`  - [Editing a note, live on the wall](#editing-a-note-live-on-the-wall)`) insert:
```markdown
  - [Clickable note ids](#clickable-note-ids)
```

**7b. New subsection, inserted before `### Spending, runs and Seer` (line 296)**:
```markdown
### Clickable note ids

`/n`, and any session that loads the `notes` server, writes every note id as a markdown link to
the wall, for example `[F-ZH5](http://localhost:7317/?note=F-ZH5)`. Claude Code draws a markdown
link as a terminal hyperlink (OSC 8), so Ctrl+click on the id (Cmd+click on macOS) opens the
wall in your browser on that note. The wall URL is not written into the skill: the daemon puts
`http://localhost:<NOTESD_PORT>` into the MCP server's instructions, so a different port needs no
edit. Ids inside note bodies and tool calls stay plain.

Inside tmux the link reaches the terminal only when tmux knows the terminal supports hyperlinks.
One line in your tmux config does it; see
[Clickable ids under WSL2 + tmux](docs/INSTALL.md#8-clickable-ids-under-wsl2--tmux).
```

**7c. Configuration table, line 527** — replace the `NOTESD_PORT` row with:
```markdown
| `NOTESD_PORT` | `7317` | HTTP port. The host is always `127.0.0.1`. The MCP instructions give Claude `http://localhost:<port>` as the wall URL for clickable note ids. `scripts/install.sh` registers the MCP server and checks health on 7317. |
```
**Impact:** docs only.

### Step 8: `docs/INSTALL.md` — tmux and clickable ids
**File:** `docs/INSTALL.md`, insert before `## Uninstall` (line 331), after the "Recycle bin" subsection of section 7.
**Code:**
````markdown
## 8. Clickable ids under WSL2 + tmux

Claude writes note ids as markdown links to the wall (`[F-ZH5](http://localhost:7317/?note=F-ZH5)`,
the port is `NOTESD_PORT`), and Claude Code prints each link as an OSC 8 hyperlink. Windows
Terminal supports OSC 8: Ctrl+click opens the URL in the Windows default browser, which reaches
`notesd` through WSL2 localhost forwarding. tmux sits in between and drops the hyperlink unless
it knows the outer terminal can show it.

Measured on this machine (2026-10-30): Windows Terminal, WSL2, tmux 3.4 with Oh my tmux,
`TERM=tmux-256color` inside tmux. `tmux list-clients -F '#{client_termname} #{client_termfeatures}'`
printed `xterm-256color bpaste,ccolour,clipboard,cstyle,focus,title`: no `hyperlinks`, so links
arrived as plain text. The server's `terminal-features` was
`xterm*:clipboard:ccolour:cstyle:focus:title`, and neither `~/.tmux.conf` nor
`~/.tmux.conf.local` mentioned `hyperlinks`.

The fix is one line (tmux 3.4 or later). Add it to `~/.tmux.conf.local` (with Oh my tmux, your
settings go there, not in `~/.tmux.conf`):

```tmux
set -as terminal-features ',xterm*:hyperlinks'
```

Then:

1. Reload: `tmux source ~/.tmux.conf` (Oh my tmux sources the `.local` file). `-a` appends, so
   reloading again adds a duplicate entry; that is harmless.
2. Detach and reattach (`prefix d`, then `tmux attach`). Terminal features are worked out per
   client when it attaches, so an already attached client keeps its old list.
3. Verify: `tmux list-clients -F '#{client_termfeatures}'` now includes `hyperlinks`.
4. Test the whole path in a pane:

   ```sh
   printf '\e]8;;http://localhost:7317/\e\\notes wall\e]8;;\e\\\n'
   ```

   `notes wall` should be underlined on hover, and Ctrl+click opens the wall in the browser.

`allow-passthrough` is not needed: it is for raw escape sequences wrapped in tmux's DCS
passthrough, and tmux forwards OSC 8 itself once the client has `hyperlinks`. Outside tmux
nothing is needed.

After this feature lands on `main`, restart the daemon from the main checkout so it serves the
new instructions (they are part of the compiled server):

```sh
cd ~/mcp-notes && scripts/install.sh
```

Never from a worktree (see section 3). Claude Code reads the MCP instructions when a session
connects, so sessions started before the restart keep the old text; start a new one. The `/n`
skill needs no re-install: `~/.claude/skills/n` is a symlink into this checkout.
````
**Impact:** docs only. The user's dotfiles are not edited (Decision in the index).

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/note-id-deeplinks && npm run typecheck`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/note-id-deeplinks && npx vitest run tests/unit/mcp.instructions.test.ts && npm test`
(`npm run test:int` is optional here; `tests/integration/daemon.int.test.ts` and `mcp.tools.int.test.ts` still pass because they only assert `A-B32` / `case-insensitive` / `Comparisons`, and they use port 0, which now yields the 7317 fallback paragraph.)
**Manual check:**
- `grep -n 7317 claude/skills/n/SKILL.md` shows only the two "normally / unless NOTESD_PORT changed it" defaults.
- `grep -n "Links\." src/mcp/instructions.ts` — one paragraph.
- Rendered README: the Contents link `#clickable-note-ids` and the cross link to `docs/INSTALL.md#8-clickable-ids-under-wsl2--tmux` resolve.
- Do not start the daemon on 7317 and do not run `scripts/install.sh` from the worktree. Post-merge (owner, from `~/mcp-notes`): `scripts/install.sh`, then in a fresh Claude Code session `/n show my last note` replies with `[X-XXX](http://localhost:7317/?note=X-XXX)` links.
**Exit criteria:** `npm run typecheck` and `npm test` pass; `buildInstructions` returns exactly one `Links.` paragraph whose URL follows the `wallUrl` argument (`4321` present and `7317` absent for a non-default port); `createApp` builds that URL from `Config.port`; the skill's Replies section requires a link for every id with the instructions as the URL source and the `claude mcp get notes` fallback; README and INSTALL document the feature and the `terminal-features ... hyperlinks` line with how to verify it.

## Handoffs

- **Phase 1 (R1):** the instructions and skill promise that `<wall>/?note=A-B32` opens the wall scrolled to that note. Phase 1 must accept exactly `?note=<canonical id>` (and the looser forms). The chat bar's agent also gets the Links paragraph, so its answers will contain `[A-B32](http://localhost:7317/?note=A-B32)`: Phase 1 should make sure the wall's answer panel renders/cites such ids sensibly (`extractUsedIds` sees the id twice, in the text and the URL; a set dedupes it, but if the panel shows raw markdown the URL text may look noisy). That is a `web/` concern; not touched here.
- **Phase 3 (R3):** replies will now already contain markdown links `[A-B32](http://localhost:<port>/?note=A-B32)`. The linkify function must not re-wrap an id that is already link text, nor the id inside a `?note=` URL. The mod should take the wall base from the same place (`claude mcp get notes` minus `/mcp`, default `http://localhost:7317`) and use the identical link form (Invariant 4).
- **Reconciler:** this phase adds a README Contents entry (`  - [Clickable note ids](#clickable-note-ids)`) besides the subsection and table row; if Phase 1 or 3 also edits the Contents list, merge both lines.
- **Out of scope, noted only:** `scripts/install.sh` `PORT=7317` (health URL, `claude mcp add` URL) still ignores `NOTESD_PORT`; `docs/INSTALL.md` lines 3, 42-52, 89, 167, 204, 316, 348-356 and README lines 5, 458-545 keep their `7317` literals (they describe the default install). A follow-up could make the installer honour `NOTESD_PORT`.

## Rollback

`git revert` this phase's commit. Code: `buildInstructions`' second parameter, `ToolDeps.wallUrl`, `wallUrlForPort`, `DEFAULT_WALL_URL` and `mcpToolDeps` disappear together; nothing else references them. The installed daemon keeps the Links paragraph until it is rebuilt and restarted from `~/mcp-notes` (`scripts/install.sh`). The skill reverts with the commit (symlink). No data, schema or dotfile changes to undo.
