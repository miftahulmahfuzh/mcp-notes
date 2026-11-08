# Code Analysis: Neon network-transfer (egress) sources in notesd

**Type:** Bug Investigation (quota exhausted) + Refactor (polling/read paths)
**Date:** 2026-11-08 08:35 WIB
**Session ID:** 20261108-083559-NE01
**Plan:** `.workflows/plan/NEON_EGRESS_REDUCTION_PLAN.md` (5 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/neon-egress-reduction`, branch `feature/neon-egress-reduction` (base `HEAD` = `main` @ f03583f, clean, not ahead of origin)

---

## User Input

### Original User Request
Neon free-plan network transfer quota (5 GB/month) for the mcp-notes project was exhausted (5.54 GB used by Nov 8, 2026, project 9 days old); every DB query now fails with "Your account or project has exceeded the quota" (code 53000). Find, rank and plan fixes for what pulls the most data from Neon in notesd. Prior read-only findings (unmeasured, verify them): (1) web/src/hooks/useSessionGraph.ts polls /api/projects/:repo/sessions every 10s (GRAPH_POLL_MS) and graphForRepo in src/sessions/readModel.ts:332 re-reads up to 2000 rows (GRAPH_DEFAULT_LIMIT) from Neon each time; the ETag only saves browser bytes, not DB egress. (2) web/src/hooks/useNotes.ts refetches up to 2000 full-body notes every 60s and on every SSE note event, per tab, hidden tabs included. (3) src/sessions/summaryWorker.ts listIdle scans up to 5000 sessions every 60s and keeps relisting sessions that stay pending. (4) the note/image/reply embedding drains and session ingest sweep run every 60s; check whether failures cause repeated re-reads of bodies. (5) a second machine shares the same database and runs the same loops. Also check useProjects, useAdversary pollers and the adversary service. Deliver: a measured or estimated bytes/day per source, a ranked list, and a phased plan (poll only on change/visibility, lighter 'changed since' checks, backoff for perpetually-pending rows, optional egress logging). Do not edit code during analysis. The DB is currently over quota, so cannot run pg_stat_statements; estimate from code and row sizes.

### User-Provided Files
None (`@`).

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Poll only on change / visibility: fix the web pollers (graph, notes, projects, adversary) |
| R2 | Lighter "changed since" checks: stop re-reading full payloads from Neon when nothing changed (graph, notes list) |
| R3 | Verify finding (4) and the ingest path: what the session ingest and drains re-read from Neon |
| R4 | Backoff for perpetually-pending rows (summary worker scan, other drains) |
| R5 | Optional egress logging, so the next quota question is answered by measurement |
| R6 | Per-source bytes/day estimate, ranked list (this document + the plan index) |

---

## Detailed Requirements Understanding

**Problem:** Neon bills "network transfer" as bytes leaving the database to the client. Everything notesd reads is egress, including reads the browser never sees (the 304 case). 5.54 GB in 9 days is ~0.6 GB/day averaged. Nothing in the code measures it; no query logs bytes.

**Success:** every steady-state read that returns an unchanged result costs tens of bytes instead of hundreds of KB; hidden/idle tabs cost nothing; the next quota incident is diagnosable from one endpoint.

**Constraints:** the DB is over quota, so no `pg_stat_statements`; all numbers below are estimates from code and column caps. Real row counts are unknown (offline). Local evidence: `~/.claude/projects` holds 668 session transcripts and 935 subagent transcripts on this machine (the second machine adds more rows to the same table).

**Assumptions:** the daemon and wall tab(s) on both machines run most of the day; node-postgres/Neon wire overhead is ignored (adds ~20-30% to JSON-heavy rows).

---

## Findings against the prior hypotheses

| # | Prior finding | Verdict |
|---|---|---|
| 1 | Graph polled every 10s, 2000 rows, ETag saves no DB egress | **Confirmed**, with a correction: the poll is already visibility-gated (`useSessionGraph.ts:46`), runs only while `view === 'projects'`. `graphForRepo` (`readModel.ts:332`) runs the full node query + `count(*)` per request, then `graphEtag` hashes the payload *after* the DB read (`sessionsApi.ts:159-171`). |
| 2 | Notes refetch 2000 full notes every 60s and per SSE event, hidden tabs too | **Confirmed**. `useNotes` is mounted in `App.tsx:66` for every view. `POLL_MS = 60_000` has no visibility check; `fetchNotes()` = `GET /api/notes?limit=2000` (`web/src/api.ts:31`) plus `fetchTags()`; server path is `service.list` → `listNotes` (`select()` all columns) + `imagesForNotes` + `filesForNotes` (3 queries). No ETag on `/api/notes` at all. |
| 3 | listIdle scans 5000 every 60s, relists pending | **Confirmed but small.** Returns light candidate rows (~150-200 B). The in-memory `seen` map stops *processing* repeats (so no body reads) but not the SQL relist; sessions with no summary input / embed text stay in the result forever. `seen`/`retryAt` are lost on every restart (`tsx watch` restarts often in dev). |
| 4 | Embedding drains / ingest sweep re-read bodies on failure | **Mostly refuted for drains**, **new hot spot found in ingest write path**. Note/image/reply `listPending` use DB-side backoff (`next_attempt_at`, `retryDelayMs` 30s→1h) and return rows only for pending items (limit 16); an idle sweep returns 0 rows. Image worker keeps an in-memory unavailable set (1h). The ingest *sweep* only stats files; but every transcript append calls `ensureSession` (full row SELECT) + `lock` (`SELECT … FOR UPDATE` full row) + `UPDATE … RETURNING` full row, and subagent appends lock the parent row too. See below. |
| 5 | Second machine runs the same loops | **Confirmed.** Same code, same DB. Everything below doubles with a second daemon + wall tab. Fixes must ship to both (`scripts/install.sh`). |

---

## Current Dataflow (per source)

### S1. Notes wall poll
**Trigger:** `useNotes` effect (`web/src/hooks/useNotes.ts:34-85`): `load()` on mount, `setInterval(load, 60_000)`, `subscribeEvents('note'|'open', schedule)` (250 ms debounce).
**Path:** `fetchNotes()` + `fetchTags()` → `GET /api/notes?limit=2000` (`src/http/api.ts:154`) → `NoteService.list` (`service.ts:269`) → `repo.listNotes` (`select * from notes … order by updated_at desc limit 2001`, `notes/repo.ts:155`) → `toNotes` (`service.ts:935`: `imagesForNotes`, `filesForNotes`) → JSON.
**Egress per call:** N_notes × (body + tags + origin jsonb + legacy image_meta + ids/timestamps) + image rows + file rows + tag counts. Body is unbounded text.
**Not gated:** hidden tabs, minimised windows, non-notes views (`view !== 'wall'`).
**Event amplification:** every note write (including each `/n` capture hook exchange via `POST /api/capture/claude-code`) emits an SSE `note` event; each open tab refetches everything.

### S2. Projects graph poll
**Trigger:** `useSessionGraph` (`web/src/hooks/useSessionGraph.ts`), `GRAPH_POLL_MS = 10_000`, visible tab only, only on the projects view; ETag via `If-None-Match`.
**Path:** `GET /api/projects/:repo/sessions` (`sessionsApi.ts:159`) → `graphForRepo` (`readModel.ts:332`): `NODE_SELECT` (`first_prompt` ≤400 chars, `summary_head` ≤600 chars, titles, cwd, branch, host, 10 numeric columns, parent join, correlated `child_count`) for up to `limit+1 = 2001` rows, in parallel with `count(*)`. Then `unfinished.annotate` (local swarm script, no DB), `graphEtag` (sha1 over payload), 304 if equal.
**Egress per poll:** ~1.0-1.5 KB × min(rows in repo, 2000). The 304 saves browser bytes only.

### S3. Session ingest write path
**Trigger:** chokidar watcher on `~/.claude/projects` (debounce 500 ms, `ingest.ts:70,753`) for each transcript/subagent append, plus a 60 s full sweep that only `stat`s files (`ingest.ts:713`).
**Path per applied append:** `SessionsRepo.upsertFromTranscript` (`repo.ts:417`):
1. `ensureSession` → `getBySessionId` (`repo.ts:212,235`): `SELECT SESSION_COLUMNS` (every column but `search_tsv`, so `prompts`, `commits`, `files_edited`, `plan_docs`, `final_message`, `summary`, `models` jsonb included).
2. `lock` (`repo.ts:260`): the same select `FOR UPDATE`.
3. `UPDATE … RETURNING SESSION_COLUMNS` (`repo.ts:449`): the full row again.
4. `writePromptRows` does `select max(seq)`; inserts are ingress.
Subagent appends (`repo.ts:599`) lock the parent row (`select SESSION_COLUMNS … for update`) plus the subagent row. `dbLinkStore.sessionsByIds/ByNames` also select `SESSION_COLUMNS` per linker batch (`links.ts:711-721`).
**Row size caps** (`types.ts`): prompts up to 100 × 2000 chars, final message 8000, commits ≤200, files_edited ≤500 paths, plan_docs ≤100. A busy session row is roughly 20-150 KB; a fresh one is a few KB.
**Egress:** 3 × row size per applied pass (ingest returns the row but the caller mostly ignores it beyond `row.transcriptOffset`). A live session appends every few seconds; swarm runs and subagents multiply passes.

### S4. Summary worker scan
`startSummaryWorker` (`summaryWorker.ts:277`): `drain` on a 60 s `setInterval` → `listRequested` (limit 100) + `listIdle` (limit 5000, `host = this host`, idle ≥ 15 min, needs summary or embedding) → candidate rows (7 light columns). `seen`/`attempts`/`retryAt` are process memory only. Rows stuck pending (embed text null, summary input null, summarizer failing, unsummarizable) are relisted each minute for the life of the process; after a restart each is `load`ed again (full prompts/commits/summary bodies, in batches of 20) before being skipped.

### S5. Embedding drains (notes, images, replies)
`startEmbeddingWorker` / `startImageEmbeddingWorker` / reply worker: `drain` on a 60 s interval and on events. `listPending` returns only rows needing work, `limit` = batch (16). Failure → `recordFailure` sets `next_attempt_at`; the next listing excludes it until due. Each idle sweep returns 0 rows (cost: DB CPU, ~0 egress). Failure loops are bounded to one 16-row batch of bodies per due-retry, with 1 h cap.

### S6. Projects list poll
`useProjects(enabled = view==='projects')`, 60 s: `listProjects` = one grouped aggregate (~one row per repo, ~150 B). Plus selection GET on entry. ~293 project dirs locally ⇒ ≤ ~45 KB per poll worst case if every dir is a repo; realistically far fewer.

### S7. Adversary
Browser: `useAdversary` polls overview + toggle (+ method) every 60 s while `view === 'adversary'`, and on SSE `adversary` events. Daemon: one pass per 10 min (`ADVERSARY_POLL_MS = 600_000`) — `seer.roster/candidates/verdictsFrom/previews` read **Seer's own database** (a different Neon project with its own quota; check it separately), and the notes DB only for the toggle and `reviews.recent` (7-day window of `adversary_reviews`, small). Negligible for *this* quota.

### Other readers
`claude/hooks/notes-prompt.mjs` → `GET /api/sessions/context?ids=` only when a prompt contains a node id (I/O-free otherwise). `unfinished.annotate` uses the local swarm script, not the DB. MCP tools are per-call.

---

## Estimated egress per source (assumptions stated; no measurement possible)

Row-size assumptions: graph node ≈ 1.2 KB; note ≈ 1.5 KB body + 0.5 KB tags/origin/meta = 2 KB (wire); session row ≈ 40 KB average for a live session. Rows: graph repo ≈ 300 sessions (this machine has 668 transcripts overall; mcp-notes is the busiest repo); notes N ≈ 150-400 (unknown, **the least certain input**).

| Rank | Source | Formula | Per tab / per host per day | Conditions |
|---|---|---|---|---|
| 1 | S1 notes poll | (1440 polls + SSE refetches) × N × 2 KB | N=150: **~0.45 GB**; N=400: **~1.2 GB** | wall tab open all day; hidden tabs count; ×2 hosts |
| 2 | S2 graph poll | 8640 polls × 300 × 1.2 KB | **~3.1 GB per fully-visible day**; ~0.13 GB per visible hour | projects view visible only; 4 h/day ≈ 0.5 GB |
| 3 | S3 ingest write path | passes × 3 × 40 KB | 1 live session, ~1 pass / 5 s, 4 h ≈ 2900 passes ≈ **0.35 GB**; a 3-session swarm day ≈ **1 GB+** | scales with concurrent Claude work |
| 4 | S4 summary scan | 1440 sweeps × stuck_rows × 180 B | stuck 100-300 ⇒ **26-78 MB** (+ one extra body load of the stuck rows per restart) | per host, always on |
| 5 | S6 projects list | 1440 × ≤ 15-45 KB (visible only) | ≤ **20-60 MB** | projects view only |
| 6 | S5 drains | idle sweeps return 0 rows | **< 1 MB** (+ ≤16 bodies per due retry) | per host |
| 7 | S7 adversary (this DB) | 144 passes × ~10 KB | **~1.5 MB** (+ web 60 s while on the page: ~5-10 MB) | Seer DB billed separately |

Calibration: 5.54 GB / 9 days ≈ 0.62 GB/day total. That fits "one wall tab always open on one or two machines" (S1) plus some hours on the projects view (S2) plus daily Claude Code ingest (S3) — no single source needs to be exotic. The ranking by *expected* bytes is S1 > S2 ≈ S3 > the rest; by *worst case per open hour* S2 is highest. **Treat these as estimates until phase 5 adds the meter.**

---

## Key Data Structures
- `NODE_SELECT` / `NodeRow` (`readModel.ts:223`), `GraphPayload` (`types.ts` in sessions), `graphEtag` (`sessionsApi.ts:95`).
- `SESSION_COLUMNS` (`repo.ts:85`): all `cc_sessions` columns except `search_tsv`.
- `SummaryStore.listIdle` / `SummaryCandidate` (`summaryWorker.ts:41-78`).
- `Db = NodePgDatabase & { $client: pg.Pool }` (`src/db/client.ts:14`); the single place every query passes through (`$client.query`).

## Dependencies
Env: `DATABASE_URL` (pooled Neon), `ADVERSARY_POLL_MS`, `NOTESD_SESSIONS`, `NOTESD_ADVERSARY`, `OPENROUTER_API_KEY` (embedding workers on/off). No config exists for poll intervals today.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `GRAPH_POLL_MS` | `web/src/hooks/useSessionGraph.ts:9` | def | web |
| `useSessionGraph` | `web/src/hooks/useSessionGraph.ts:21`; used in `web/src/pages/ProjectsPage.tsx` (via store) | def/call | web |
| `POLL_MS` (notes) | `web/src/hooks/useNotes.ts:26,70` | def/call | web |
| `useNotes` | `web/src/App.tsx:66` | call | web |
| `fetchNotes` | `web/src/api.ts:31` | def | web |
| `PROJECTS_POLL_MS` | `web/src/hooks/useProjects.ts:6,59` | def/call | web |
| `ADVERSARY_POLL_MS` (web) | `web/src/hooks/useAdversary.ts:6,40` | def/call | web |
| `graphForRepo` | `src/sessions/readModel.ts:332`; route `src/http/sessionsApi.ts:159` | def/call | src/sessions, src/http |
| `graphEtag` | `src/http/sessionsApi.ts:95,166` | def/call | src/http |
| `GRAPH_DEFAULT_LIMIT` | `src/http/sessionsApi.ts:28` | def | src/http |
| `GET /api/notes` | `src/http/api.ts:154` | route | src/http |
| `NoteService.list`, `toNotes` | `src/notes/service.ts:269,935` | def | src/notes |
| `listNotes` | `src/notes/repo.ts:155` | def | src/notes |
| `upsertFromTranscript`, `ensureSession`, `lock`, `getBySessionId` | `src/sessions/repo.ts:417,212,260,235` | def | src/sessions |
| `upsertFromSubagentTranscript` (parent lock) | `src/sessions/repo.ts:~590-610` | def | src/sessions |
| `dbLinkStore.sessionsByIds/ByNames` | `src/sessions/links.ts:711-721` | def | src/sessions |
| `listIdle`, `startSummaryWorker`, `DEFAULT_SUMMARY_SWEEP_MS`, `SUMMARY_SCAN_LIMIT`, `seen/retryAt` | `src/sessions/summaryWorker.ts:142,277,23,31,291-293` | def | src/sessions |
| `retryDelayMs` | `src/embeddings/state.ts:57-71` | def | src/embeddings |
| `listPending` (notes / images / replies) | `src/embeddings/repo.ts:68`, `imageRepo.ts:60`, `sessions/replyEmbeddings.ts:66` | def | embeddings, sessions |
| `createDb` | `src/db/client.ts:33` | def | src/db |
| `startBackground` | `src/background.ts:43` | wiring | src |
| Adversary pass | `src/adversary/service.ts:443,489` | def | src/adversary |

## Impact Points
1. `web/src/hooks/useNotes.ts`, `useSessionGraph.ts`, `useProjects.ts`, `useAdversary.ts` + new `web/src/lib/usePageActive.ts` — phase 1.
2. `src/http/api.ts` (`/api/notes`), `src/http/sessionsApi.ts`, `src/sessions/readModel.ts`, new `src/notes/fingerprint.ts` — phase 2.
3. `src/sessions/repo.ts` (ensure/lock/returning narrowing) — phase 3.
4. `src/sessions/summaryWorker.ts` (scan gating, persistent skip, restart behaviour) — phase 4.
5. `src/db/client.ts`, new `src/db/meter.ts`, `src/http/debugApi.ts`/route mount in `src/http/app.ts` (or wherever routes are assembled), `src/config.ts` — phase 5.

**This document describes. The plan files prescribe.**
