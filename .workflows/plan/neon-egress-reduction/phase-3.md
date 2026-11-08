# Phase 3 — Session ingest write path: read the full row once per append, not three times

**Satisfies:** R3 · **Depends on:** — · **Package:** `src/sessions` · **Difficulty:** HARD
**Does not touch:** `merge.ts` semantics, transcript parsing, the sweep/watch logic in `ingest.ts` beyond one call-site option, `drizzle/`, the prompts/replies side tables' write logic.

## Goal
`SessionsRepo.upsertFromTranscript` (`src/sessions/repo.ts:417`) reads the whole `cc_sessions` row (`SESSION_COLUMNS`: prompts ≤100×2000 chars, commits ≤200, files_edited ≤500, final_message ≤8000, summary, models…) three times per applied append: `ensureSession` → `getBySessionId` (`:212,:235`), `lock` (`:260`, `FOR UPDATE`), and `UPDATE … RETURNING SESSION_COLUMNS` (`:449`). Only the lock read is needed (`mergeTranscriptPatch` merges prompts/commits/files/models from it). Subagent appends read the parent row with `SESSION_COLUMNS FOR UPDATE` (`:599`) though they use only tokens, models, commits, host, `lastActiveAt`. This phase cuts ingest egress by about two thirds on the main path and trims the subagent path, without changing what is written.

## Edits (all in `src/sessions/repo.ts` unless noted)

### 1. Existence check without reading the row
Add beside `ensureSession`:
```ts
/** Makes sure a row exists without reading it back. Hot path of the ingester: the row is read once, under the lock. */
async ensureSessionRow(sessionId: string, host: string): Promise<void> {
  assertSessionId(sessionId);
  assertHost(host);
  const found = await this.db.execute<{ one: number }>(sql`select 1 as one from cc_sessions where session_id = ${sessionId} limit 1`);
  if (found.rows.length > 0) return;
  await this.ensureSession(sessionId, host); // first sighting only: existing loop (node id retry), full row returned and ignored
}
```
In `upsertFromTranscript` replace `await this.ensureSession(patch.sessionId, patch.host);` with `await this.ensureSessionRow(patch.sessionId, patch.host);`. `ensureSession` itself stays for its other callers (hooks etc.).

### 2. Light result
Add to `src/sessions/types.ts` (or beside `TranscriptUpsertResult` wherever it is declared; grep it):
```ts
/** What the ingester needs back from a transcript write. */
export type SessionRef = Pick<SessionRow, 'sessionId' | 'nodeId' | 'host' | 'transcriptOffset' | 'transcriptSize'>;
```
Change `TranscriptUpsertResult` so that the `applied: true` and the two refused variants carry `row: SessionRef` instead of `SessionRow`. In the repo:
```ts
const REF_COLUMNS = {
  sessionId: ccSessions.sessionId, nodeId: ccSessions.nodeId, host: ccSessions.host,
  transcriptOffset: ccSessions.transcriptOffset, transcriptSize: ccSessions.transcriptSize,
};
function toRef(row: SessionRow): SessionRef { return { sessionId: row.sessionId, nodeId: row.nodeId, host: row.host, transcriptOffset: row.transcriptOffset, transcriptSize: row.transcriptSize }; }
```
- The two early returns (`other_host`, `offset_mismatch`) return `row: toRef(row)`.
- The update ends `.returning(REF_COLUMNS)` and returns `{ applied: true, row: next }`.
- First grep every consumer of `TranscriptUpsertResult.row` in `src/` and `tests/` (`rg "upsertFromTranscript" src tests`). `ingest.ts` uses only `result.row.host` (`:537`) and `storedOffset`. Tests that read other fields from `result.row` switch to `repo.getBySessionId(id)` for the assertion — a test-only read.
- `IngestStore`'s `Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'>` keeps working; fakes in `tests/unit/sessions/*` that return a full `SessionRow` still satisfy `SessionRef` (structural subtype), so only fakes that build the object literal inline need `row:` trimmed or left as is.

### 3. Subagent path reads the parent narrowly
In `upsertFromSubagentTranscript` replace the parent select with:
```ts
const parents = await tx
  .select({
    sessionId: ccSessions.sessionId, host: ccSessions.host,
    inputTokens: ccSessions.inputTokens, outputTokens: ccSessions.outputTokens,
    cacheReadTokens: ccSessions.cacheReadTokens, cacheWriteTokens: ccSessions.cacheWriteTokens,
    models: ccSessions.models, commits: ccSessions.commits, lastActiveAt: ccSessions.lastActiveAt,
  })
  .from(ccSessions).where(eq(ccSessions.sessionId, patch.sessionId)).for('update');
```
The remaining body uses exactly these fields (`parent.host`, the four token columns, `models`, `commits`, `lastActiveAt`); confirm with the typechecker, which will flag any other field.

### 4. Linker reads (`src/sessions/links.ts:711-721`)
`dbLinkStore.sessionsByIds/sessionsByNames` select `SESSION_COLUMNS`. Check which `SessionRow` fields the link logic (`links.ts`, `parentResolve`/heuristic) actually reads (id, host, name, custom_title, cwd, repo, started_at, last_active_at, parent link, node_id, tmux). If the set is small, introduce `LINK_COLUMNS` in `repo.ts`, export it, and select only those; if the type contract requires `SessionRow`, define `LinkSessionRow = Pick<…>` and thread it through the `LinkStore` interface. Skip this step (and say so in the commit message) if it would change more than ~30 lines; it is the smaller win.

## Tests
- Update `tests/unit/sessions/*repo*` / integration `tests/integration/sessions.*.int.test.ts` for the narrowed `result.row`.
- Add `tests/integration/sessions.ingestReads.int.test.ts`: wrap `db.$client.query` (pg.Pool) with a counter that records `rowCount` and SQL text; ingest a new transcript (first sighting) then append once; assert that on the append, no more than one statement matching `from "cc_sessions"` returns the `prompts` column (the lock) — i.e. one full row read, not three — and that the stored row afterwards equals the row produced by the pre-change code path (compare to a fixture built with `mergeTranscriptPatch`).
- Subagent: append to a subagent transcript, assert parent tokens and commits identical to before the change (existing `sessions.subagents.int.test.ts` should pass unmodified; run it).

## Verification
```sh
npm run typecheck
npm test
npm run test:int
```
verify-notesd: start the throwaway daemon, write a transcript fixture under its `CLAUDE_HOME`, append twice, confirm `/api/sessions/:nodeId` shows the merged prompts, tokens and commits.

## Exit criteria
One full-row read per applied main-transcript append; subagent appends read only the narrow parent columns; no change to stored data; all suites green; tree builds.
