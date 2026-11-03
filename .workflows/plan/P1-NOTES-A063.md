> Adopted from `/home/miftah/.worktrees/mcp-notes/session-note-links/.workflows/orchestration/session-note-links/PLAN.md` phase 1. Source: `.workflows/plan/session-note-links/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Server: link table, link_note/unlink_note, made ∪ linked detail

**Plan set:** `docs/plans/SESSION_NOTE_LINKS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-142651-L7NK_code_analyzer.md`
**Satisfies:** R1 — link an existing note (5-BW7) into a session (5U-I7) so it is listed with that session's notes
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/` (db, notes, sessions, mcp), `drizzle/`, `claude/skills/n`

---

## Goal

A note can be linked to (and unlinked from) any Claude Code session with the MCP tools
`link_note` / `unlink_note`, stored in a new `note_session_links` table that never touches the
note's `origin`. Session detail (`session_get`, `GET /api/sessions/:nodeId`) lists the notes made
in a session together with the notes linked to it, once each, newest first, and every entry says
how it got there: `kind: "made" | "linked"`.

## Interface Contract

**Deletes:** local `type NoteRow` in `src/sessions/readModel.ts:220` (replaced by `NoteRefRow` in `view.ts`)
**Renames:** none
**Creates:**
- table `note_session_links` (`note_id` → `notes.id` on delete cascade, `session_id` → `cc_sessions.session_id` on delete cascade, `linked_at timestamptz not null default now()`, PK `(note_id, session_id)`, index `note_session_links_session_idx` on `session_id`) — `drizzle/0009_note_session_links.sql`, `drizzle/meta/0009_snapshot.json`, journal entry idx 9
- `noteSessionLinks` (`src/db/schema.ts`)
- module `src/notes/sessionLinks.ts`: `LinkedSession`, `findSessionByNodeId`, `insertLink`, `deleteLink`
- `SessionLinkResult` and `NotesService.linkSession(noteIdInput, nodeId)` / `NotesService.unlinkSession(noteIdInput, nodeId)` (`src/notes/service.ts`), both `Promise<SessionLinkResult | null>` (null = no session with that node id)
- `NoteRefKind`, `NoteRefRow`, `toNoteRef` (`src/sessions/view.ts`)
- MCP tools `link_note({note_id, node_id})`, `unlink_note({note_id, node_id})` (`src/mcp/sessionTools.ts`)
**Wire changes (consumed by Phase 2):** every `SessionDetail.notes[]` entry (`session_get` and `GET /api/sessions/:nodeId`) gains `kind: "made" | "linked"`. Exact shape: `{ id: string, excerpt: string, tags: string[], created_at: string | null, kind: "made" | "linked" }`. A note both made in and linked to a session appears once, as `"made"`. Linked notes are included; soft-deleted notes are not; ordered by `notes.created_at desc`; at most `DETAIL_MAX_NOTES` (50) over the union.
**MCP result shape (both tools):** `{ note_id: "A-B32", node_id: "A0-3G", session_id: "<uuid>", linked: boolean, changed: boolean, made: boolean }` — `linked` is the state after the call (`true` for link_note, `false` for unlink_note), `changed` is whether this call inserted/deleted the row, `made` is whether the note was saved from that session (it is then listed as `"made"` regardless of the link).
**MCP errors:** `invalid_node_id: …` (malformed node id), `not_found: no session ZZ-ZZ. …` (unknown node), `invalid_id: …` (malformed note id), `not_found: Note X does not exist.` (unknown note), `deleted: Note X is deleted, so it cannot be linked to a session. Call restore("X") first.` (link_note on a soft-deleted note), `SESSIONS_OFF` text when the server has no session read model. `unlink_note` accepts a soft-deleted note (removing a link is always allowed).
**Signature changes:** `interface NoteRef` gains required `kind: NoteRefKind`.
**Requires (from earlier phases):** none
**Leaves alone (owned by others):** everything under `web/` and `.claude/skills/verify-notesd/` (Phase 2), including `features/projects.md`. `src/chat/status.ts` `SESSION_TOOL_NAMES` is NOT extended (the chat bar keeps its five read-only session tools).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts:35` and `:583` | modify | header comment line about 0009; new `noteSessionLinks` table before `ccSessionEmbeddings` |
| `drizzle/0009_note_session_links.sql` | create (generated) | `CREATE TABLE note_session_links`, 2 FKs, 1 index |
| `drizzle/meta/0009_snapshot.json` | create (generated) | drizzle-kit snapshot |
| `drizzle/meta/_journal.json` | modify (generated) | entry idx 9 `0009_note_session_links` |
| `tests/integration/setup.ts:50` | modify | `truncateAll` adds `note_session_links` |
| `src/notes/sessionLinks.ts` | create | session lookup by node id, idempotent insert/delete of a link |
| `src/notes/service.ts:19`, `:147`, `:460` | modify | import, `SessionLinkResult`, `linkSession` / `unlinkSession` |
| `src/sessions/view.ts:113`, `:357` | modify | `NoteRefKind`, `NoteRef.kind`, `NoteRefRow`, `toNoteRef` |
| `src/sessions/readModel.ts:17-50`, `:220`, `:326-330`, `:350-355` | modify | imports, drop local `NoteRow`, union query, `toNoteRef` mapping |
| `src/mcp/sessionTools.ts:1-9`, `:21`, `:104-110`, `:218` | modify | `noteIdField`, `link_note`, `unlink_note`, `session_get` description |
| `src/mcp/instructions.ts:58` | modify | Sessions paragraph mentions linked notes and the two tools |
| `README.md:679-688`, `:971` | modify | "Asking about sessions" text + MCP tool table rows |
| `claude/skills/n/SKILL.md:3`, `:245` | modify | description trigger; new `## Sessions` section mapping "/n link … into …" |
| `tests/unit/sessions.view.test.ts:1-18`, end | modify | `toNoteRef` test |
| `tests/unit/sessions/linkNoteTool.test.ts` | create | tool boundary: SESSIONS_OFF, invalid_node_id, not_found, pass-through, errors |
| `tests/unit/mcp.instructions.test.ts:129` | modify | Sessions paragraph must name `link_note`, `unlink_note` |
| `tests/integration/sessions.noteLinks.int.test.ts` | create | real DB through MCP: every behavior listed in the scope |

## Implementation Steps

### Step 0: Install dependencies in the worktree
**File:** none
**Change:** the worktree has no `node_modules`. Run `cd /home/miftah/.worktrees/mcp-notes/session-note-links && npm ci` once before anything else.
**Impact:** none on the tree.

### Step 1: Add the `noteSessionLinks` table to the schema
**File:** `src/db/schema.ts:583` (insert immediately before the doc comment `/**\n * One row per session that has (or had) a summary to embed (migration 0007).` that precedes `export const ccSessionEmbeddings`, i.e. after `ccSubagentTranscripts` ends at line 581). `primaryKey`, `index`, `text`, `timestamp`, `pgTable` are already imported (lines 2-18).
**Code:**
```ts
/**
 * An explicit link from an existing note to a Claude Code session (migration 0009), made with the
 * `link_note` MCP tool. Session detail lists the notes made in a session (`notes.origin
 * ->> 'claude_session'`) together with the notes linked here; a link never rewrites the note's
 * origin. Written only by src/notes/sessionLinks.ts through NotesService. Purging a note or
 * removing a session drops its links.
 */
export const noteSessionLinks = pgTable(
  'note_session_links',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.sessionId] }), index('note_session_links_session_idx').on(t.sessionId)],
)

```
Also extend the file header comment, `src/db/schema.ts:35` — after the line
` * only writer of the three \`cc_*\` tables and of \`app_settings\`.` insert:
```ts
 * Migration 0009 (session note links) adds `note_session_links`; src/notes/sessionLinks.ts,
 * called only by NotesService, is its only writer.
```
**Impact:** schema only; nothing reads it until Step 3.

### Step 2: Generate migration 0009
**File:** `drizzle/0009_note_session_links.sql`, `drizzle/meta/0009_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** generate, do not hand-write. `drizzle.config.ts` throws without a direct (non-`-pooler`) URL even though `generate` never connects, so pass a dummy one:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-note-links
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5999/gen npx drizzle-kit generate --name note_session_links
```
The planner ran exactly this against a scratch copy with Step 1 applied; the expected SQL is:
```sql
CREATE TABLE "note_session_links" (
	"note_id" text NOT NULL,
	"session_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_session_links_note_id_session_id_pk" PRIMARY KEY("note_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "note_session_links" ADD CONSTRAINT "note_session_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_session_links" ADD CONSTRAINT "note_session_links_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_session_links_session_idx" ON "note_session_links" USING btree ("session_id");
```
and the journal gains `{ "idx": 9, "version": "7", "when": <now>, "tag": "0009_note_session_links", "breakpoints": true }`. If the output differs (any statement touching another table), stop: the schema has drifted from the 0008 snapshot. Verify with `git status drizzle/` showing exactly the three files.
**Impact:** additive. The journal-counting tests (`schema.int.test.ts:188`, `migration0002.int.test.ts:278`) count entries dynamically and need no change.

### Step 3: Truncate the new table in integration tests
**File:** `tests/integration/setup.ts:50`
**Code (full function replacement):**
```ts
/** Empties every app table. Call in `beforeEach` of any file that writes. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table note_session_links, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
}
```
**Impact:** none beyond explicitness (`cascade` would have reached it anyway).

### Step 4: Link repo module
**File:** `src/notes/sessionLinks.ts` (new)
**Code:**
```ts
import { and, eq } from 'drizzle-orm';
import { ccSessions, noteSessionLinks } from '../db/schema.js';
import type { Executor } from './repo.js';

/**
 * Rows of `note_session_links` (migration 0009): explicit note -> Claude Code session links.
 * Only NotesService calls these; session detail reads the table in src/sessions/readModel.ts.
 */

/** The session a canonical node id names. */
export interface LinkedSession {
  sessionId: string;
  nodeId: string;
}

export async function findSessionByNodeId(db: Executor, nodeId: string): Promise<LinkedSession | null> {
  const rows = await db
    .select({ sessionId: ccSessions.sessionId, nodeId: ccSessions.nodeId })
    .from(ccSessions)
    .where(eq(ccSessions.nodeId, nodeId))
    .limit(1);
  return rows[0] ?? null;
}

/** Inserts the link; true when this call created it, false when it already existed. */
export async function insertLink(db: Executor, noteId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .insert(noteSessionLinks)
    .values({ noteId, sessionId })
    .onConflictDoNothing()
    .returning({ noteId: noteSessionLinks.noteId });
  return rows.length > 0;
}

/** Deletes the link; true when this call removed it, false when there was none. */
export async function deleteLink(db: Executor, noteId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(noteSessionLinks)
    .where(and(eq(noteSessionLinks.noteId, noteId), eq(noteSessionLinks.sessionId, sessionId)))
    .returning({ noteId: noteSessionLinks.noteId });
  return rows.length > 0;
}
```
**Impact:** new module, no callers yet.

### Step 5: `linkSession` / `unlinkSession` on NotesService
**File:** `src/notes/service.ts`

5a. Import, after line 22 (`import * as bin from './binRepo.js';`):
```ts
import * as sessionLinks from './sessionLinks.js';
```

5b. Result type, after `export interface GetResult { … }` (ends line 147), before `interface Mutation`:
```ts
/** What link_note / unlink_note report (src/mcp/sessionTools.ts returns it as is). */
export interface SessionLinkResult {
  note_id: string;
  node_id: string;
  session_id: string;
  /** Whether the link exists after the call: true after linkSession, false after unlinkSession. */
  linked: boolean;
  /** Whether this call inserted or deleted the row; false when it already was that way. */
  changed: boolean;
  /** The note was saved from this session (origin.claude_session), so session detail lists it as kind "made" either way. */
  made: boolean;
}
```

5c. Methods, inserted after `restore()` (ends line 460, right before the doc comment of `attachImage`):
```ts
  /**
   * Links a live note to the session whose node id is `nodeId` (canonical: the caller ran
   * normalizeNodeId). Idempotent: an existing link is kept (`changed: false`). Never writes the
   * note's body, origin or updated_at, and emits no event: the note itself did not change.
   * Unknown note -> NoteError('not_found'); deleted note -> NoteError('deleted');
   * no session with that node id -> null.
   */
  async linkSession(noteIdInput: string, nodeId: string): Promise<SessionLinkResult | null> {
    const id = this.requireId(noteIdInput);
    return this.db.transaction(async (tx): Promise<SessionLinkResult | null> => {
      // The row lock keeps a concurrent purge from removing the note between the check and the insert.
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt !== null) {
        throw new NoteError('deleted', `Note ${id} is deleted, so it cannot be linked to a session. Call restore("${id}") first.`);
      }
      const session = await sessionLinks.findSessionByNodeId(tx, nodeId);
      if (session === null) return null;
      const changed = await sessionLinks.insertLink(tx, id, session.sessionId);
      return {
        note_id: id,
        node_id: session.nodeId,
        session_id: session.sessionId,
        linked: true,
        changed,
        made: cur.origin?.claude_session === session.sessionId,
      };
    });
  }

  /**
   * Removes the link between a note and the session whose node id is `nodeId` (canonical).
   * Idempotent: no link -> `changed: false`. Works on a deleted note too. Never touches a note
   * made in that session (origin is not a link), and emits no event.
   * Unknown note -> NoteError('not_found'); no session with that node id -> null.
   */
  async unlinkSession(noteIdInput: string, nodeId: string): Promise<SessionLinkResult | null> {
    const id = this.requireId(noteIdInput);
    const cur = await repo.findNoteById(this.db, id);
    if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
    const session = await sessionLinks.findSessionByNodeId(this.db, nodeId);
    if (session === null) return null;
    const changed = await sessionLinks.deleteLink(this.db, id, session.sessionId);
    return {
      note_id: id,
      node_id: session.nodeId,
      session_id: session.sessionId,
      linked: false,
      changed,
      made: cur.origin?.claude_session === session.sessionId,
    };
  }
```
**Impact:** the service stays the single writer (invariant 3); `origin` is never written (invariant 2); no SSE event.

### Step 6: `NoteRef.kind` and a pure row mapper
**File:** `src/sessions/view.ts`

6a. Replace `export interface NoteRef { … }` at line 113 with:
```ts
/** How a note belongs to a session: saved from it (origin.claude_session) or linked to it with link_note. */
export type NoteRefKind = 'made' | 'linked';

export interface NoteRef {
  id: string;
  excerpt: string;
  tags: string[];
  created_at: string | null;
  /** "made" wins when a note was both saved from the session and linked to it. */
  kind: NoteRefKind;
}

/** One row of session detail's notes query (src/sessions/readModel.ts sessionDetail). */
export interface NoteRefRow {
  id: string;
  body: string;
  tags: string[] | null;
  created_at: Date | string | null;
  kind: string;
}
```

6b. After `export function excerpt(…) { … }` (ends line 357), add:
```ts
/** A session-detail note row as the wire NoteRef. Any kind other than "made" reads as "linked". */
export function toNoteRef(r: NoteRefRow): NoteRef {
  return {
    id: r.id,
    excerpt: excerpt(r.body, NOTE_EXCERPT_CHARS) ?? '',
    tags: Array.isArray(r.tags) ? r.tags : [],
    created_at: iso(r.created_at),
    kind: r.kind === 'made' ? 'made' : 'linked',
  };
}
```
(`NOTE_EXCERPT_CHARS` is declared in this file at line 22; `iso` at line 312.)
**Impact:** `NoteRef.kind` is required, so the only builder (readModel) must be updated in Step 7 in the same commit.

### Step 7: Session detail = made ∪ linked
**File:** `src/sessions/readModel.ts`

7a. Import list (lines 17-50): remove `NOTE_EXCERPT_CHARS,` and `excerpt,` (no other use in this file); add `toNoteRef,` after `toNodeRef,` and `type NoteRefRow,` after `type NodeRow,`.

7b. Delete line 220: `type NoteRow = { id: string; body: string; tags: string[] | null; created_at: Date | string | null };`

7c. Replace the notes query (lines 326-330) inside the `Promise.all` with:
```ts
    // Made (origin.claude_session) or linked (note_session_links), each note once: one row per
    // note, so a note that is both comes back once with kind 'made'. The limit caps the union.
    rd.db.execute<NoteRefRow>(sql`
      select n.id, n.body, n.tags, n.created_at,
        case when n.origin ->> 'claude_session' = ${row.session_id} then 'made' else 'linked' end as kind
      from notes n
      where n.deleted_at is null
        and (
          n.origin ->> 'claude_session' = ${row.session_id}
          or exists (select 1 from note_session_links l where l.note_id = n.id and l.session_id = ${row.session_id})
        )
      order by n.created_at desc, n.id desc
      limit ${DETAIL_MAX_NOTES}`),
```

7d. Replace the mapping (lines 350-355):
```ts
    notes: notes.rows.map(toNoteRef),
```
**Impact:** `session_get` and `GET /api/sessions/:nodeId` now carry `kind` and include linked notes. Existing tests that check `body.notes.map((n) => n.id)` (`sessions.api.int.test.ts:206`) and `toEqual([])` (`:234`) still pass. The web client ignores unknown fields until Phase 2 reads `kind`.

### Step 8: MCP tools `link_note` and `unlink_note`; `session_get` description
**File:** `src/mcp/sessionTools.ts`

8a. Imports (lines 1-9): add
```ts
import type { SessionLinkResult } from '../notes/service.js';
```

8b. After `nodeIdField` (ends line 21), add:
```ts
const noteIdField = z
  .string()
  .min(1)
  .describe('Note id like A-B32: one character, a dash, three characters. Case-insensitive; the dash may be omitted. Not a session node id (A0-3G).');
```

8c. `session_get` description (lines 107-109) becomes:
```ts
      description:
        'One Claude Code session by node id (like A0-3G): { session: { node_id, session_id, repo, title, name, branch, cwd, started_at, last_active_at, host, available, live, status, tokens, cost_usd, summary, first_prompt, last_prompt, final_message, transcript_path, url, ... }, ' +
        'prompts, commits, files_edited, plan_docs, notes, parent, children (sessions it spawned) }. notes are the notes saved from that session and the notes linked to it with link_note, newest first, each { id, excerpt, tags, created_at, kind: "made" | "linked" }; a note that is both is listed once as "made". ' +
        'available: false means it ran on the other machine (host).',
```

8d. Insert before `registerSessionResumeTool(server, deps);` (line 219), still inside `registerSessionTools`:
```ts
  /** Shared tail of link_note / unlink_note: node id at the boundary, then the service. */
  async function linkCall(
    rawNodeId: string,
    op: (nodeId: string) => Promise<SessionLinkResult | null>,
  ): Promise<CallToolResult> {
    if (rd === undefined) return fail(SESSIONS_OFF);
    const nodeId = normalizeNodeId(rawNodeId);
    if (nodeId === null) return badNodeId(rawNodeId);
    try {
      const res = await op(nodeId);
      return res === null ? notFound(nodeId) : jsonResult(res);
    } catch (err) {
      return errorResult(err);
    }
  }

  server.registerTool(
    'link_note',
    {
      title: 'Link a note to a Claude Code session',
      description:
        "Link an existing note to a Claude Code session, so session_get and the wall's project graph list it with that session's notes as kind \"linked\" (\"/n link A-B32 into A0-3G\"). " +
        'note_id is a note id like A-B32, node_id a session node id like A0-3G; both are case-insensitive and the dash may be omitted. The note itself (body, tags, origin) does not change. ' +
        'Linking again is a no-op. A deleted note cannot be linked: restore it first. ' +
        'Returns { note_id, node_id, session_id, linked: true, changed, made }: changed false means the link already existed; made true means the note was saved from that session, so it is listed there as "made" anyway.',
      inputSchema: { note_id: noteIdField, node_id: nodeIdField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => linkCall(args.node_id, (nodeId) => deps.service.linkSession(args.note_id, nodeId)),
  );

  server.registerTool(
    'unlink_note',
    {
      title: 'Unlink a note from a Claude Code session',
      description:
        'Remove a link made with link_note between a note (note_id like A-B32) and a Claude Code session (node_id like A0-3G). The note itself does not change, and a note saved from that session stays listed there as "made" (origin is not a link). ' +
        'Unlinking what is not linked is a no-op. Returns { note_id, node_id, session_id, linked: false, changed, made }: changed false means there was no link.',
      inputSchema: { note_id: noteIdField, node_id: nodeIdField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => linkCall(args.node_id, (nodeId) => deps.service.unlinkSession(args.note_id, nodeId)),
  );
```
**Impact:** two new MCP tools on `/mcp`. They are not added to `SESSION_TOOL_NAMES` (`src/chat/status.ts:43`), so the chat bar's allowlist and `tests/unit/chat-status.test.ts:11` (`toHaveLength(5)`) and the "read-only except session_resume" assertion in `sessions.mcp.int.test.ts:68-71` are unaffected.

### Step 9: MCP instructions
**File:** `src/mcp/instructions.ts:58` (the `Sessions.` paragraph)
**Change:** two textual edits inside the template string.
- Replace `the notes saved from it, tokens and cost,` with `the notes saved from it or linked to it (each with kind "made" or "linked"), tokens and cost,`
- After the sentence ending `answers token and cost questions.` insert:
```
link_note(note_id, node_id) links an existing note to a session ("/n link A-B32 into A0-3G"), so session_get and the wall list it with that session's notes as kind "linked"; the note's origin and text are not changed, linking twice is harmless, a deleted note must be restored first, and unlink_note(note_id, node_id) removes the link.
```
(one space before it, one space after it, inside the same paragraph; the paragraph must stay the last one, starting with `Sessions.`).
**Impact:** `tests/unit/mcp.instructions.test.ts` still passes; Step 13 tightens it.

### Step 10: README
**File:** `README.md`
10a. Lines 679-688 ("### Asking about sessions" body): replace the paragraph and code block with:
````markdown
The MCP server and the chat bar have the same five tools for reading sessions (listed under
[MCP tools](#mcp-tools)), so from Claude Code or the wall:

```
/n which session added the recycle bin, and what did it change?
/n how many tokens did I spend on mcp-notes sessions in October?
/n show me the transcript of A0-3G around the migration error
/n resume A0-3G and ask it to rerun the integration tests
/n link 5-BW7 into A0-3G
```

A session's notes are the ones saved from it plus the ones linked to it. `link_note` (Claude Code
only, not the chat bar) links any existing note to a session without changing the note; it then
shows in that session's panel on the graph and in `session_get`, marked as linked. `unlink_note`
removes the link.
````
(keep the following paragraph "`session_transcript` reads the transcript file, …" unchanged).

10b. MCP tool table: replace the `session_get` row (line 971) with the two lines below, and insert the `link_note, unlink_note` row right after `session_resume` (line 974):
```markdown
| `session_get` | One session by node id (`A0-3G`, any case, dash optional): summary, prompts, commits, plan docs, files edited, its notes (saved from it or linked to it, each with `kind: "made" \| "linked"`), tokens and cost, parent and children, `host` and `available` |
```
```markdown
| `link_note`, `unlink_note` | Link an existing note (`note_id`) to a session (`node_id`) so it is listed with that session's notes as `linked`, and remove the link. The note's text and origin never change; both are idempotent; a deleted note cannot be linked |
```

### Step 11: `/n` skill
**File:** `claude/skills/n/SKILL.md`
11a. Line 3 (`description:`): replace `look at, attach or remove pictures in them (` with `look at, attach or remove pictures in them, or link a note to a Claude Code session (` and, inside that parenthesis, insert `"link 5-BW7 into 5U-I7", ` right after `"attach this screenshot to note A-B32", `.

11b. Insert before `## Deleting` (line 245):
```markdown
## Sessions

Claude Code sessions are nodes with ids like `A0-3G` (two characters, a dash, two characters).
Note ids look like `A-B32` (one character, a dash, three). Never swap the two and never invent
either.

- "Which session did X", "what did A0-3G do" → `sessions_search`, then `session_get`. A
  session's `notes` are the notes saved from it (`kind: "made"`) and the notes linked to it
  (`kind: "linked"`).
- "Link 5-BW7 into 5U-I7", "link note A-B32 to session A0-3G", "put this note under that
  session" → `link_note` with `note_id` = the note id and `node_id` = the session's node id.
  Linking twice is harmless (`changed: false`). It never edits the note, so do not `update` or
  `append` anything to "make" the link. A deleted note must be restored first; ask before
  restoring it.
- "Unlink A-B32 from A0-3G" → `unlink_note`. A note saved from that session (`made: true`)
  stays listed there; say so.
- Reply with both ids as links (the note as described under Replies, the session with the
  `url` that `session_get` returns) and whether anything changed.

```
**Impact:** docs only; `install.sh` symlinks the skill, so the live skill updates on deploy.

### Step 12: Unit test for `toNoteRef`
**File:** `tests/unit/sessions.view.test.ts`
Add `toNoteRef,` to the import list (after `toGraphNode,`, line 13), and append at the end of the file:
```ts
describe('toNoteRef', () => {
  it('maps a session-detail note row to the wire NoteRef with its kind', () => {
    expect(
      toNoteRef({ id: 'A-B32', body: '  hello \n  world #x ', tags: ['x'], created_at: new Date('2026-11-03T00:00:00Z'), kind: 'made' }),
    ).toEqual({ id: 'A-B32', excerpt: 'hello world #x', tags: ['x'], created_at: '2026-11-03T00:00:00.000Z', kind: 'made' });
    expect(toNoteRef({ id: 'A-B33', body: '', tags: null, created_at: null, kind: 'linked' })).toEqual({
      id: 'A-B33',
      excerpt: '',
      tags: [],
      created_at: null,
      kind: 'linked',
    });
  });
});
```

### Step 13: Unit tests for the tool boundary
**File:** `tests/unit/sessions/linkNoteTool.test.ts` (new)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/db/client.js';
import { SESSIONS_OFF, registerSessionTools } from '../../../src/mcp/sessionTools.js';
import type { NotesService, SessionLinkResult } from '../../../src/notes/service.js';
import { NoteError } from '../../../src/notes/types.js';
import type { SessionsReadDeps } from '../../../src/sessions/readModel.js';

type LinkFn = (noteIdInput: string, nodeId: string) => Promise<SessionLinkResult | null>;

const RESULT: SessionLinkResult = {
  note_id: 'A-B32',
  node_id: 'A0-3G',
  session_id: 'sess-root',
  linked: true,
  changed: true,
  made: false,
};

async function connect(link: LinkFn, unlink: LinkFn, sessions: SessionsReadDeps | undefined) {
  const service = { linkSession: link, unlinkSession: unlink } as unknown as NotesService;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSessionTools(server, {
    service,
    dataDir: '/nowhere',
    db: {} as Db,
    ...(sessions !== undefined ? { sessions } : {}),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function text(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content[0] ?? { text: '' }).text;
}

const rd = { wallUrl: 'http://localhost:7317' } as SessionsReadDeps;

describe('link_note / unlink_note tools', () => {
  it('link_note gives the service the raw note id and the canonical node id, and returns its result', async () => {
    const link = vi.fn<LinkFn>(async () => RESULT);
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'ab32', node_id: 'a03g' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual(RESULT);
    expect(link).toHaveBeenCalledWith('ab32', 'A0-3G');
    await close();
  });

  it('unlink_note returns the service result', async () => {
    const unlink = vi.fn<LinkFn>(async () => ({ ...RESULT, linked: false, changed: false }));
    const { client, close } = await connect(vi.fn<LinkFn>(), unlink, rd);
    const res = await client.callTool({ name: 'unlink_note', arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
    expect(JSON.parse(text(res))).toMatchObject({ linked: false, changed: false });
    expect(unlink).toHaveBeenCalledWith('A-B32', 'A0-3G');
    await close();
  });

  it('an unknown node answers not_found: no session', async () => {
    const { client, close } = await connect(vi.fn<LinkFn>(async () => null), vi.fn<LinkFn>(async () => null), rd);
    for (const name of ['link_note', 'unlink_note']) {
      const res = await client.callTool({ name, arguments: { note_id: 'A-B32', node_id: 'zz-zz' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/^not_found: no session ZZ-ZZ/);
    }
    await close();
  });

  it('a malformed node id answers invalid_node_id without reaching the service', async () => {
    const link = vi.fn<LinkFn>();
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'A-B32', node_id: 'A-B32' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^invalid_node_id:/);
    expect(link).not.toHaveBeenCalled();
    await close();
  });

  it('service errors come back as code: message', async () => {
    const link = vi.fn<LinkFn>(async () => {
      throw new NoteError('deleted', 'Note A-B32 is deleted, so it cannot be linked to a session. Call restore("A-B32") first.');
    });
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^deleted: Note A-B32 is deleted/);
    await close();
  });

  it('without the session read model both tools answer SESSIONS_OFF', async () => {
    const link = vi.fn<LinkFn>();
    const { client, close } = await connect(link, vi.fn<LinkFn>(), undefined);
    for (const name of ['link_note', 'unlink_note']) {
      const res = await client.callTool({ name, arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(SESSIONS_OFF);
    }
    expect(link).not.toHaveBeenCalled();
    await close();
  });

  it('both tools are writes, idempotent, not destructive', async () => {
    const { client, close } = await connect(vi.fn<LinkFn>(), vi.fn<LinkFn>(), rd);
    const { tools } = await client.listTools();
    for (const name of ['link_note', 'unlink_note']) {
      const t = tools.find((x) => x.name === name);
      expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    await close();
  });
});
```
Also `tests/unit/mcp.instructions.test.ts:129`: add `'link_note', 'unlink_note'` to the word array, i.e.
```ts
    for (const word of ['sessions_search', 'session_get', 'session_transcript', 'sessions_usage', 'link_note', 'unlink_note', 'not_on_this_machine', 'A0-3G', 'A-B32']) {
```

### Step 14: Integration tests on a real database
**File:** `tests/integration/sessions.noteLinks.int.test.ts` (new)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpToolDeps } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { DETAIL_MAX_NOTES } from '../../src/sessions/view.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedGraph, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';
import { truncateAll } from './setup.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type LinkResult = { note_id: string; node_id: string; session_id: string; linked: boolean; changed: boolean; made: boolean };
type DetailNotes = { notes: Array<{ id: string; kind: string; excerpt: string }> };

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  commitLinks: async () => new Map(),
  live: async () => [],
  search: async () => ({ mode: 'text', fallback: null, hits: [] }),
};

let h: ApiHarness;
let client: Client;
let transcript: { file: string; cleanup: () => Promise<void> };
const seen: NoteEvent[] = [];

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false, text(r)).toBe(false);
  return JSON.parse(text(r)) as T;
}

async function detailNotes(nodeId = 'A0-3G'): Promise<DetailNotes['notes']> {
  return (await callJson<DetailNotes>('session_get', { node_id: nodeId })).notes;
}

async function linkRows(noteId: string): Promise<number> {
  const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_session_links where note_id = ${noteId}`);
  return res.rows[0]?.n ?? 0;
}

async function backdate(id: string, iso: string): Promise<void> {
  await h.deps.db.execute(sql`update notes set created_at = ${iso}::timestamptz where id = ${id}`);
}

beforeAll(async () => {
  h = await createApiHarness();
  transcript = await writeTranscript();
  h.events.on((e) => seen.push(e));
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'note-links-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await truncateAll(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
  seen.length = 0;
});

describe('link_note / unlink_note', () => {
  it('links a note (any id case, no dash) and session_get lists it as linked, without touching the note', async () => {
    const note = await h.notes.create({ body: 'a finding from elsewhere #links', origin: { cwd: '/elsewhere' } });
    seen.length = 0; // drop the create's own event: only link_note's (none) should follow
    const res = await callJson<LinkResult>('link_note', { note_id: note.id.replace('-', '').toLowerCase(), node_id: 'a03g' });
    expect(res).toEqual({ note_id: note.id, node_id: 'A0-3G', session_id: 'sess-root', linked: true, changed: true, made: false });
    expect(await detailNotes()).toEqual([expect.objectContaining({ id: note.id, kind: 'linked', excerpt: 'a finding from elsewhere #links' })]);
    const after = await h.notes.getOne(note.id);
    expect(after?.origin).toEqual(note.origin);
    expect(after?.updated_at).toBe(note.updated_at);
    expect(after?.body).toBe(note.body);
    expect(seen).toEqual([]);
  });

  it('linking twice is a no-op success', async () => {
    const note = await h.notes.create({ body: 'twice' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    const again = await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(again).toMatchObject({ linked: true, changed: false });
    expect(await linkRows(note.id)).toBe(1);
    expect((await detailNotes()).map((n) => n.id)).toEqual([note.id]);
  });

  it('unlink removes the link; unlinking again is a no-op success', async () => {
    const note = await h.notes.create({ body: 'unlink me' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    const off = await callJson<LinkResult>('unlink_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(off).toMatchObject({ note_id: note.id, node_id: 'A0-3G', linked: false, changed: true });
    expect(await detailNotes()).toEqual([]);
    const again = await callJson<LinkResult>('unlink_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(again).toMatchObject({ linked: false, changed: false });
    expect(await linkRows(note.id)).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ op: 'created' })]);
  });

  it('an unknown or malformed note id is refused', async () => {
    const unknown = await call('link_note', { note_id: 'Z-ZZZ', node_id: 'A0-3G' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^not_found: Note Z-ZZZ does not exist/);
    const bad = await call('link_note', { note_id: 'not a note', node_id: 'A0-3G' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid_id:/);
    const unlinkUnknown = await call('unlink_note', { note_id: 'Z-ZZZ', node_id: 'A0-3G' });
    expect(text(unlinkUnknown)).toMatch(/^not_found: Note Z-ZZZ does not exist/);
  });

  it('a deleted note cannot be linked, drops out of session detail, and can still be unlinked', async () => {
    const gone = await h.notes.create({ body: 'deleted before linking' });
    await h.notes.delete(gone.id);
    const res = await call('link_note', { note_id: gone.id, node_id: 'A0-3G' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(new RegExp(`^deleted: Note ${gone.id} is deleted`));
    expect(await linkRows(gone.id)).toBe(0);

    const later = await h.notes.create({ body: 'deleted after linking' });
    await callJson<LinkResult>('link_note', { note_id: later.id, node_id: 'A0-3G' });
    await h.notes.delete(later.id);
    expect(await detailNotes()).toEqual([]);
    expect(await callJson<LinkResult>('unlink_note', { note_id: later.id, node_id: 'A0-3G' })).toMatchObject({ changed: true });
  });

  it('an unknown node answers not_found, a note id as node id answers invalid_node_id', async () => {
    const note = await h.notes.create({ body: 'x' });
    for (const name of ['link_note', 'unlink_note']) {
      const missing = await call(name, { note_id: note.id, node_id: 'ZZ-ZZ' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/^not_found: no session ZZ-ZZ/);
      const bad = await call(name, { note_id: note.id, node_id: 'A-B32' });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/^invalid_node_id:/);
    }
    expect(await linkRows(note.id)).toBe(0);
  });

  it('made ∪ linked: newest first, a note both made and linked is listed once as made', async () => {
    const made = await h.notes.create({ body: 'made here', origin: { claude_session: 'sess-root' } });
    const linked = await h.notes.create({ body: 'linked here' });
    const both = await h.notes.create({ body: 'made and linked', origin: { claude_session: 'sess-root' } });
    const elsewhere = await h.notes.create({ body: 'made in a child', origin: { claude_session: 'sess-b1' } });
    await backdate(made.id, '2026-11-01T00:00:00Z');
    await backdate(linked.id, '2026-11-02T00:00:00Z');
    await backdate(both.id, '2026-11-03T00:00:00Z');
    await callJson<LinkResult>('link_note', { note_id: linked.id, node_id: 'A0-3G' });
    const bothRes = await callJson<LinkResult>('link_note', { note_id: both.id, node_id: 'A0-3G' });
    expect(bothRes).toMatchObject({ changed: true, made: true });

    expect((await detailNotes()).map((n) => [n.id, n.kind])).toEqual([
      [both.id, 'made'],
      [linked.id, 'linked'],
      [made.id, 'made'],
    ]);
    // Linking the child's note to the root does not move it out of the child.
    await callJson<LinkResult>('link_note', { note_id: elsewhere.id, node_id: 'A0-3G' });
    expect((await detailNotes('B1-22')).map((n) => [n.id, n.kind])).toEqual([[elsewhere.id, 'made']]);
    expect((await detailNotes()).find((n) => n.id === elsewhere.id)?.kind).toBe('linked');
    // The HTTP detail the wall reads (Phase 2's input) carries the same list and kinds.
    const app = new Hono();
    app.route('/', sessionsApiRoutes(h.deps, overrides));
    const res = await app.request('/api/sessions/A0-3G');
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailNotes;
    expect(body.notes.map((n) => [n.id, n.kind])).toEqual((await detailNotes()).map((n) => [n.id, n.kind]));
  });

  it('DETAIL_MAX_NOTES caps the union, not each half', async () => {
    await h.deps.db.execute(sql`
      insert into notes (id, body, origin, created_at, updated_at)
      select 'M-' || lpad(g::text, 3, '0'), 'made ' || g, '{"claude_session":"sess-root"}'::jsonb,
             '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 minute', now()
      from generate_series(1, ${DETAIL_MAX_NOTES}) g`);
    const newest = await h.notes.create({ body: 'newest, linked' });
    await callJson<LinkResult>('link_note', { note_id: newest.id, node_id: 'A0-3G' });
    const notes = await detailNotes();
    expect(notes).toHaveLength(DETAIL_MAX_NOTES);
    expect(notes[0]).toMatchObject({ id: newest.id, kind: 'linked' });
    expect(notes.some((n) => n.id === 'M-001')).toBe(false);
  });

  it('purging a note or removing a session drops its links', async () => {
    const note = await h.notes.create({ body: 'to be purged' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'B1-22' });
    expect(await linkRows(note.id)).toBe(2);
    await h.deps.db.execute(sql`delete from cc_sessions where session_id = 'sess-b1'`);
    expect(await linkRows(note.id)).toBe(1);
    await h.notes.delete(note.id);
    await h.notes.purgeNote(note.id);
    expect(await linkRows(note.id)).toBe(0);
  });
});
```
The HTTP block mounts `sessionsApiRoutes(h.deps, overrides)` exactly as `tests/integration/sessions.api.int.test.ts:43-44` does.

**Impact:** `npm run test:int` covers every behavior in the phase scope: link, double link, unlink, unknown note, deleted note, unknown node, bad node id, union dedupe (made wins), the union limit, purge and session cascades, no SSE event, origin untouched.

## Principles applied

- Boundary discipline: node ids are normalized once in the MCP tool (`linkCall` in `sessionTools.ts`) and the service takes a canonical node id; note ids keep the service's existing `requireId` boundary, so the service never re-validates node ids and the repo module trusts both.
- Laziness protocol: no new repo class and no `SessionsRepo` change; three small functions in `src/notes/sessionLinks.ts`, one shared `linkCall` for both tools, and the union is one `or exists` query that dedupes by construction instead of a two-query merge in TypeScript.
- Make illegal states unrepresentable: `kind` is the closed type `NoteRefKind = 'made' | 'linked'`, produced only by `toNoteRef` (anything else maps to `linked`); duplicate links are impossible by the `(note_id, session_id)` primary key rather than a runtime check; dangling links are impossible by the two `on delete cascade` FKs.
- Test behavior, not implementation: integration tests drive the real MCP tools against Postgres and assert what `session_get` returns and which rows exist; the unit tool test stubs only the service (not the unit under test) and asserts the boundary's observable answers.
- Prove it works: Proof drives `link_note` / `session_get` / `GET /api/sessions/:id` on a throwaway daemon with `verify-notesd`, then the After-landing step repeats the user's exact request on the live daemon.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-note-links && npm ci && npm run typecheck && npm run build`
**Tests:** `npm test` (includes `tests/unit/sessions/linkNoteTool.test.ts`, `tests/unit/sessions.view.test.ts`, `tests/unit/mcp.instructions.test.ts`) and `npm run test:int` (includes `tests/integration/sessions.noteLinks.int.test.ts`, plus the existing `sessions.mcp.int.test.ts`, `sessions.api.int.test.ts`, `schema.int.test.ts`).
**Proof:**
- Harness: `.claude/skills/verify-notesd` (server-only change: `up --sessions`, no `--web` needed; Phase 2 adds `--web` and the Playwright click).
- Feature-map entries: `features/projects.md` (Phase 2 owns the edit; this phase's journeys drive the MCP and HTTP surfaces it lists).
- Journeys: save this as `$SCRATCH/p1-proof.sh` (any scratch dir outside the repo) and run `bash $SCRATCH/p1-proof.sh` from anywhere. Every `jq -e` / `grep -q` is an assertion; the script exits non-zero on the first failed claim. It ends with `RESULT: PASS`.
```bash
#!/usr/bin/env bash
set -euo pipefail
cd /home/miftah/.worktrees/mcp-notes/session-note-links
V=.claude/skills/verify-notesd/scripts/verify.sh
up="$($V up --sessions)"; echo "$up"
RUN="$(sed -n 's/^RUN=//p' <<<"$up")"
trap '$V down "$RUN" >/dev/null 2>&1 || true' EXIT
$V doctor "$RUN"

# MCP tool -> its JSON (drop the "> tool args" echo line). Errors: use mcperr.
mcpj()   { $V mcp "$RUN" "$1" "$2" 2>/dev/null | sed 1d; }
mcperr() { $V mcp "$RUN" "$1" "$2" 2>/dev/null | sed 1,2d || true; }
sqlv()   { $V sql "$RUN" "$1" 2>/dev/null; }
lower()  { tr -d - <<<"$1" | tr 'A-Z' 'a-z'; }

# Wait for the background ingest of tests/fixtures/claude-home.
for _ in $(seq 1 30); do
  n="$(sqlv "select count(*) from cc_sessions where repo = 'mcp-notes'" | grep -Eo '^ *[0-9]+ *$' | tr -d ' ' | head -1)"
  [ "${n:-0}" -gt 0 ] && break; sleep 1
done
NODE="$(sqlv "select node_id from cc_sessions where repo = 'mcp-notes' order by started_at limit 1" | grep -Eo '[0-9A-Z]{2}-[0-9A-Z]{2}' | head -1)"
SID="$(sqlv "select session_id from cc_sessions where node_id = '$NODE'" | grep -Eo '[0-9a-f-]{36}' | head -1)"
echo "NODE=$NODE SID=$SID"; [ -n "$NODE" ] && [ -n "$SID" ]
$V mcp "$RUN" --list | grep -qx link_note
$V mcp "$RUN" --list | grep -qx unlink_note

# J1 link: lower-case ids, no dash; listed as linked over MCP and HTTP; origin untouched.
NOTE="$(mcpj create '{"body":"verify: linked from elsewhere #verify"}' | jq -r .note.id)"
mcpj link_note "{\"note_id\":\"$(lower "$NOTE")\",\"node_id\":\"$(lower "$NODE")\"}" \
  | jq -e --arg n "$NOTE" --arg s "$NODE" --arg sid "$SID" '.note_id==$n and .node_id==$s and .session_id==$sid and .linked==true and .changed==true and .made==false'
mcpj session_get "{\"node_id\":\"$NODE\"}" | jq -e --arg n "$NOTE" '[.notes[] | select(.id==$n)] | length==1 and .[0].kind=="linked"'
$V api "$RUN" GET "/api/sessions/$NODE" | sed 1,2d | jq -e --arg n "$NOTE" '[.notes[] | select(.id==$n)][0].kind=="linked"'
sqlv "select count(*) from note_session_links where note_id = '$NOTE' and session_id = '$SID'" | grep -Eq '^ *1 *$'
sqlv "select origin->>'claude_session' is null as untouched from notes where id = '$NOTE'" | grep -Eq '^ *t *$'
$V note "$RUN" "J1 link_note links $NOTE into $NODE; session_get + GET /api/sessions show kind=linked; origin untouched"

# J2 idempotent link.
mcpj link_note "{\"note_id\":\"$NOTE\",\"node_id\":\"$NODE\"}" | jq -e '.linked==true and .changed==false'
sqlv "select count(*) from note_session_links where note_id = '$NOTE'" | grep -Eq '^ *1 *$'
$V note "$RUN" "J2 second link_note is a no-op (changed=false, one row)"

# J3 errors: unknown note, malformed node id, unknown node, deleted note.
mcperr link_note "{\"note_id\":\"Z-ZZZ\",\"node_id\":\"$NODE\"}" | grep -q '^not_found: Note Z-ZZZ does not exist'
mcperr link_note "{\"note_id\":\"$NOTE\",\"node_id\":\"A-B32\"}" | grep -q '^invalid_node_id:'
mcperr link_note "{\"note_id\":\"$NOTE\",\"node_id\":\"ZZ-ZZ\"}" | grep -q '^not_found: no session ZZ-ZZ'
DEL="$(mcpj create '{"body":"verify: deleted #verify"}' | jq -r .note.id)"
mcpj delete "{\"id\":\"$DEL\"}" >/dev/null
mcperr link_note "{\"note_id\":\"$DEL\",\"node_id\":\"$NODE\"}" | grep -q "^deleted: Note $DEL is deleted"
$V note "$RUN" "J3 not_found / invalid_node_id / not_found session / deleted errors"

# J4 made wins: a note saved from the session and also linked appears once as made.
MADE="$(mcpj create "{\"body\":\"verify: made here #verify\",\"origin\":{\"claude_session\":\"$SID\"}}" | jq -r .note.id)"
mcpj link_note "{\"note_id\":\"$MADE\",\"node_id\":\"$NODE\"}" | jq -e '.made==true and .changed==true'
mcpj session_get "{\"node_id\":\"$NODE\"}" | jq -e --arg m "$MADE" '[.notes[] | select(.id==$m)] | length==1 and .[0].kind=="made"'
$V note "$RUN" "J4 made+linked note $MADE listed once as made"

# J5 unlink, twice.
mcpj unlink_note "{\"note_id\":\"$NOTE\",\"node_id\":\"$NODE\"}" | jq -e '.linked==false and .changed==true'
mcpj unlink_note "{\"note_id\":\"$NOTE\",\"node_id\":\"$NODE\"}" | jq -e '.linked==false and .changed==false'
mcpj session_get "{\"node_id\":\"$NODE\"}" | jq -e --arg n "$NOTE" '[.notes[] | select(.id==$n)] | length==0'
$V note "$RUN" "J5 unlink_note removes the link; second unlink is a no-op"

# J6 purge cascade through the wall's bin route.
PUR="$(mcpj create '{"body":"verify: purge me #verify"}' | jq -r .note.id)"
mcpj link_note "{\"note_id\":\"$PUR\",\"node_id\":\"$NODE\"}" | jq -e '.changed==true'
mcpj delete "{\"id\":\"$PUR\"}" >/dev/null
$V api "$RUN" DELETE "/api/bin/notes/$PUR" | sed -n 2p | grep -q 'HTTP 200'
sqlv "select count(*) from note_session_links where note_id = '$PUR'" | grep -Eq '^ *0 *$'
$V note "$RUN" "J6 delete forever of $PUR drops its link row"

# Neighbor: the rest of session detail and the projects graph still answer.
mcpj session_get "{\"node_id\":\"$NODE\"}" | jq -e --arg s "$NODE" '.session.node_id==$s and (.prompts|type=="array") and (.children|type=="array")'
$V api "$RUN" GET /api/projects/mcp-notes/sessions | sed -n 2p | grep -q 'HTTP 200'
$V note "$RUN" "Neighbor: session_get and the projects graph unchanged"
echo "RESULT: PASS"
```
  End state that passes: the script prints `RESULT: PASS`; evidence files `NN-mcp-link_note.txt`, `NN-mcp-session_get.txt`, `NN-api-GET_api_sessions_*.txt`, `NN-sql-query.txt` and `LOG.md` lines J1-J6 are under `~/.local/state/notesd-verify/<RUN>/evidence/`.
- Neighbor check: `session_get` on the same node still returns `session`, `prompts`, `children`, and `GET /api/projects/mcp-notes/sessions` answers 200 (last block of the script). `npm run test:int` also reruns `sessions.mcp.int.test.ts` and `sessions.api.int.test.ts` unchanged.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` are green; the Proof script prints `RESULT: PASS`; `drizzle/` has exactly the three generated 0009 files.

## After landing

Run on the live machine once this phase (and the set) is merged to `main` in `/home/miftah/mcp-notes`. These touch the live Neon DB and the live daemon on 7317; per the user's standing instruction, run them without asking.

```sh
cd /home/miftah/mcp-notes
git checkout main && git pull --ff-only

# 1. Migration 0009 on the live DB. install.sh does NOT migrate and the daemon does not
#    migrate on boot. drizzle.config.ts loads .env.local and picks whichever of
#    DATABASE_URL_UNPOOLED / DATABASE_URL is the direct (non "-pooler") Neon host.
#    The table is additive, so the old daemon keeps working until the restart.
npm ci
npm run db:migrate          # expect drizzle-kit to report applying 0009_note_session_links

# 2. Rebuild + restart: builds server and web, re-renders the systemd user unit,
#    restarts notesd.service, re-links the /n skill, health-checks 7317.
scripts/install.sh
systemctl --user is-active notesd.service      # -> active
curl -fsS http://127.0.0.1:7317/health         # -> {"ok":true}

# 3. The user's request: link 5-BW7 into 5U-I7 on the live daemon. Use the harness's MCP
#    client pointed at the live URL (a fresh MCP connection sees the new tools; the current
#    Claude Code session's tool list may predate the restart).
M=.claude/skills/verify-notesd/scripts/mcp.mjs
node $M http://127.0.0.1:7317/mcp --list | grep -x -e link_note -e unlink_note    # both present
node $M http://127.0.0.1:7317/mcp link_note '{"note_id":"5-BW7","node_id":"5U-I7"}'
#    -> {"note_id":"5-BW7","node_id":"5U-I7","session_id":"90906f13-cc88-40c5-8e60-64ef3191e204","linked":true,"changed":true,"made":false}

# 4. Confirm: session_get(5U-I7).notes contains 5-BW7 with kind "linked".
node $M http://127.0.0.1:7317/mcp session_get '{"node_id":"5U-I7"}' | sed 1d \
  | jq -e '[.notes[] | select(.id=="5-BW7")] | length==1 and .[0].kind=="linked"'
#    -> true (exit 0)
```
If step 1 fails with "No direct (unpooled) Postgres URL", `.env.local` is missing from the checkout: it lives at `/home/miftah/mcp-notes/.env.local`. If step 3 answers `not_found: no session 5U-I7`, the live ingester has not seen that session (check `journalctl --user -u notesd.service -n 50`); planner confirmed on 2026-11-03 that `session_get(5U-I7)` exists on the live daemon (session `90906f13-cc88-40c5-8e60-64ef3191e204`, `notes: []`). A `made: true` answer would mean 5-BW7 was saved from 5U-I7 and is already listed as "made"; the confirmation in step 4 would then show `kind: "made"`, which also satisfies the request.

## Handoffs

- **Phase 2** (R2): read `notes[].kind` (`"made" | "linked"`) from `GET /api/sessions/:nodeId` into `SessionNoteRef`, show the link icon for `linked`. Treat a missing `kind` as `"made"` only if it wants to tolerate an older daemon; the server always sends it after this phase.
- **Phase 2** (R1 docs surface it owns): update `.claude/skills/verify-notesd/features/projects.md` for this phase's user-facing change too, since this phase must not touch that directory: under Sub-features add "Link an existing note to a session (`link_note` / `unlink_note`); session notes = made ∪ linked with `kind`"; under How to get to it add `link_note`, `unlink_note`; under Driving add `$V mcp RUN link_note '{"note_id":"<id>","node_id":"<node>"}'` and `$V mcp RUN session_get '{"node_id":"<node>"}'`, with the gotcha that node ids are server-generated (read one with `$V sql RUN "select node_id from cc_sessions limit 1"`).
- **No phase (follow-up card if wanted):** adding `link_note` / `unlink_note` to the chat bar's allowlist (`SESSION_TOOL_NAMES` in `src/chat/status.ts`) would give the wall chat write access to links; out of scope here and would need `chat-status.test.ts` and `sessions.mcp.int.test.ts` updated.

## Rollback

Revert this phase's commit(s). On a database where 0009 was already applied (test DBs are recreated; the live Neon DB only after "After landing"), the leftover table is harmless to the reverted code, which never reads it. To remove it fully: `drop table note_session_links;` and `delete from drizzle.__drizzle_migrations where hash = '<hash of 0009>'` (the row with the highest `created_at`) on the direct URL, so a later re-apply is not skipped.
