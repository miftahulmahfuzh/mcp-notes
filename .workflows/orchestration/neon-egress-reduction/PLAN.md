# Plan: Cut notesd's Neon network transfer (egress)

**Slug:** neon-egress-reduction
**Date:** 2026-11-08 08:35 WIB
**Analysis:** `.workflows/analyze/20261108-083559-NE01_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/neon-egress-reduction`
**Branch:** `feature/neon-egress-reduction` (base: `HEAD` = main @ `f03583f`, checkout was clean and not ahead of origin)
**Phases:** 5
**Status:** phase 1/5 complete
**Coordinator:** —

---

## Why

Neon free-plan network transfer quota (5 GB/month) for the mcp-notes project was exhausted (5.54 GB used by Nov 8, 2026, project 9 days old); every DB query now fails with "Your account or project has exceeded the quota" (code 53000). Find, rank and plan fixes for what pulls the most data from Neon in notesd. Prior read-only findings (unmeasured, verify them): (1) web/src/hooks/useSessionGraph.ts polls /api/projects/:repo/sessions every 10s (GRAPH_POLL_MS) and graphForRepo in src/sessions/readModel.ts:332 re-reads up to 2000 rows (GRAPH_DEFAULT_LIMIT) from Neon each time; the ETag only saves browser bytes, not DB egress. (2) web/src/hooks/useNotes.ts refetches up to 2000 full-body notes every 60s and on every SSE note event, per tab, hidden tabs included. (3) src/sessions/summaryWorker.ts listIdle scans up to 5000 sessions every 60s and keeps relisting sessions that stay pending. (4) the note/image/reply embedding drains and session ingest sweep run every 60s; check whether failures cause repeated re-reads of bodies. (5) a second machine shares the same database and runs the same loops. Also check useProjects, useAdversary pollers and the adversary service. Deliver: a measured or estimated bytes/day per source, a ranked list, and a phased plan (poll only on change/visibility, lighter 'changed since' checks, backoff for perpetually-pending rows, optional egress logging). Do not edit code during analysis. The DB is currently over quota, so cannot run pg_stat_statements; estimate from code and row sizes.

## Ranked sources (estimates; no measurement was possible, see the analysis for assumptions)

| Rank | Source | Estimated egress | Fixed by |
|---|---|---|---|
| 1 | Notes wall poll: 2000 full notes + images + files + tags every 60 s and on every SSE note event, hidden tabs included, no ETag | ~0.45-1.2 GB/day per always-open tab | P1 (visibility, 300 s), P2 (fingerprint 304) |
| 2 | Projects graph poll: ≤2001 node rows + count every 10 s while the projects view is visible | ~0.13 GB per visible hour (~3 GB if visible all day) | P1 (30→120 s adaptive), P2 (fingerprint + server cache) |
| 3 | Session ingest write path: three full-row reads per transcript append, parent row read per subagent append | ~0.35 GB per 4 h of one live session; 1 GB+ on swarm days | P3 |
| 4 | Summary worker idle scan, relisting settled rows every 60 s, body reload per restart | 26-78 MB/day per host | P4 |
| 5 | Projects list poll (60 s, visible) | ≤20-60 MB/day | P1 |
| 6 | Embedding drains (notes/images/replies): DB-side backoff, idle sweep returns 0 rows | < 1 MB/day (finding 4 refuted for drains) | none needed; metered by P5 |
| 7 | Adversary (this DB only; Seer's reads hit a different Neon project) | ~2-10 MB/day | P1 (web cadence); check Seer's own quota separately |

The second machine runs the same loops on the same database, so every figure scales with the number of daemons and wall tabs. **All phases must be deployed to both machines (`scripts/install.sh`) to take effect.**

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Poll only on change / visibility (web pollers: graph, notes, projects, adversary) | 1 |
| R2 | Lighter "changed since" checks instead of full re-reads (graph, notes list) | 2 |
| R3 | Verify finding 4 and the ingest path; fix what re-reads bodies/rows | 3 |
| R4 | Backoff for perpetually-pending rows (summary worker scan) | 4 |
| R5 | Optional egress logging (plus a quota circuit breaker) | 5 |
| R6 | Bytes/day per source and ranked list | analysis + this index (no phase) |

## Scope

**In scope:** web poll cadence and visibility; server-side fingerprints and 304s for `/api/notes`, `/api/tags` and the session graph; narrowing the ingest write-path reads; summary scan gating; an in-process egress meter, a loopback debug endpoint and a quota breaker.
**Out of scope:** schema changes and migrations; replacing polling by SSE for sessions; raising the 2000-note page size or paging the wall (a bigger UX change, noted as a follow-up); Seer's own database quota; upgrading the Neon plan; the connectors (read other apps' DBs on demand, not polled).

## Invariants

1. The tree builds and `npm run typecheck`, `npm test` and `npm run test:int` pass at the end of every phase.
2. No payload shape changes: the wall, the projects page and every API/MCP response look identical to a client.
3. No migration and no change to what is written to Neon (phase 3 changes only what is read back).
4. Staleness bounds after this set: a note or session change made on the other machine shows within 5 min on a visible wall tab (60 s after the tab regains focus) and within 2 min on the projects view, and a local write still refetches immediately through SSE.
5. `NOTESD_EGRESS_METER=off` restores pre-change DB behaviour exactly.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Web pollers: visible-only, slower, adaptive | R1 | `web/` | 6 (+tests) | — | NORMAL | `.workflows/plan/neon-egress-reduction/phase-1.md` | P1-NOTES-A085 | — |
| 2 | Fingerprint 304s for notes and graph | R2 | `src/notes`, `src/sessions`, `src/http` | 6 (+tests) | — | HARD | `.workflows/plan/neon-egress-reduction/phase-2.md` | P1-NOTES-A086 | — |
| 3 | Ingest write path: one row read per append | R3 | `src/sessions` | 3 (+tests) | — | HARD | `.workflows/plan/neon-egress-reduction/phase-3.md` | P1-NOTES-A087 | — |
| 4 | Summary worker scan gating and settled-row exclusion | R4 | `src/sessions` | 1 (+tests) | — | NORMAL | `.workflows/plan/neon-egress-reduction/phase-4.md` | P1-NOTES-A088 | — |
| 5 | Egress meter and quota circuit breaker | R5 | `src/db`, `src/http`, `src/config.ts` | 6 (+tests, README) | — | NORMAL | `.workflows/plan/neon-egress-reduction/phase-5.md` | P1-NOTES-A089 | — |

### Phase 1 — Web pollers
**Satisfies:** R1
**Owns:** `web/src/lib/pageActive.ts` (new), `useNotes`, `useSessionGraph`, `useProjects`, `useAdversary` and their tests.
**Does not touch:** `src/`.
**Exit criteria:** no `setInterval` in the four hooks; hidden tabs make zero requests; cadences 300 s / 30→120 s / 120 s / 120 s; web tests and typecheck green.

### Phase 2 — Fingerprint 304s
**Satisfies:** R2
**Owns:** `src/notes/fingerprint.ts`, `src/sessions/graphCache.ts`, the `/api/notes` and `/api/tags` handlers in `src/http/api.ts`, `graphForRepo`/`repoFingerprint` in `src/sessions/readModel.ts`, and the `updatedAt` audit of `cc_sessions` writers (set clauses only).
**Does not touch:** `web/`, migrations, the write-path read narrowing of phase 3.
**Exit criteria:** an unchanged poll of the three endpoints issues one aggregate query; every write invalidates; payloads unchanged; all suites green.

### Phase 3 — Ingest write path
**Satisfies:** R3
**Owns:** `ensureSessionRow`, `SessionRef`/`REF_COLUMNS` and the narrow `RETURNING`, the narrow parent select in `upsertFromSubagentTranscript`, optionally `LINK_COLUMNS` in `links.ts`.
**Does not touch:** `merge.ts`, parsing, the `updatedAt` set clauses phase 2 audits (different hunks of `repo.ts`).
**Exit criteria:** one full-row read per main-transcript append; stored data identical; all suites green.

### Phase 4 — Summary worker
**Satisfies:** R4
**Owns:** scan gating, `fingerprint`/`changedSince`/`excludeIds` on `SummaryStore`, settled-row exclusion, tests.
**Does not touch:** `src/embeddings/*`, schema.
**Exit criteria:** idle scan at most every 5 min unless the host's sessions changed, a retry is due or a kick arrived; summaries and embeddings produced as before.

### Phase 5 — Meter and breaker
**Satisfies:** R5
**Owns:** `src/db/meter.ts`, `src/db/quota.ts`, `src/db/client.ts` instrumentation, `src/http/debugApi.ts` and its mount, hourly log line in `src/background.ts`, README rows.
**Does not touch:** query sites.
**Exit criteria:** `/api/debug/egress` shows rows/bytes per query shape; a 53000 answer pauses queries for 30 min; env switch restores old behaviour.

## Reconciliation Log

| Conflict | Phases | Resolution |
|---|---|---|
| `src/sessions/repo.ts` edited by P2 (audit adding `updatedAt` to `set` clauses) and P3 (ensure/lock/returning/subagent parent select) | 2, 3 | Different hunks, no shared symbol; P2 owns only `.set({...})` clauses, P3 owns `ensureSessionRow`, the `RETURNING`, and the subagent parent select. Phases stay concurrent; the integrator resolves any textual overlap. |
| `src/http/app.ts` / `sessionsApi.ts`: P2 edits the graph route and its helpers; P5 mounts a new router in `app.ts` and imports `loopbackReadGuard` from `sessionsApi.ts` | 2, 5 | `loopbackReadGuard` is exported today and P2 does not rename or remove it; P5 touches only the mount line in `app.ts`. No ordering needed. |
| `summaryWorker.ts` tests vs P2's graph cache | 2, 4 | Disjoint files. |
| P1 relies on 304-cheap polls for the graph, but P2 may land later | 1, 2 | P1 is safe alone (slower cadence, backoff, visible-only); P2 is an additional saving, not a prerequisite. |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Persist "settled, nothing to do" markers for stuck sessions in a new column (needs migration) vs in-memory exclusion with TTL | In-memory exclusion + TTL + `changedSince`; accept one body load per stuck row per restart | 1: invariant 3 (no migration) |
| Graph cache key staleness for cross-repo parent links / `child_count` | 5 min max age; fingerprint covers this repo's rows only | 3: phase-2 plan (cheap fingerprint) over perfect freshness; bounded staleness stated in invariant 4 |
| Notes poll: 300 s visible-only vs keep 60 s | 300 s visible, 60 s stale-on-focus, SSE for local writes | 5: user's "poll only on change/visibility" |
| Breaker scope: whole DB vs background loops only | Whole DB at the pool choke point, 30 min cool-down, first query after it is the probe | 5: user's "optional egress logging" plus the observed failure mode (every loop retrying on both machines) |
| Embedding drains (finding 4) | No change; verified DB-side backoff and 0-row idle sweeps | 5: evidence in analysis |
| Launch execution after planning vs stop at the plan | Launch (command default, `--no-orchestrate` not passed) | 1: command definition |

## Open Questions

None. (No fork here is irreversible: no data deletion, no migration, no history rewrite.)

## Rollback

Per phase: `git revert` the phase's merge commit; phases are independent. P1 and P4 revert to the old cadence/scan; P2 reverts to unconditional list queries; P3 restores the three reads; P5 off-switch `NOTESD_EGRESS_METER=off` without redeploy. Whole set: revert the integration merge on `main`, run `scripts/install.sh` on both machines.

## Operational notes (not code)

- Neon's usage resets on the billing-cycle date; until then every query fails with 53000. Stop the daemon on both machines (`systemctl --user stop notesd`) and close wall tabs before the reset so the new quota is not burned at once, and install the new build on both machines first.
- Seer's database is a different Neon project: check its usage page for the same quota.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/NEON_EGRESS_REDUCTION_PLAN.md --phase 1

Or run the whole set as a swarm (all five phases are independent and run concurrently):

    /analyze-orchestrator -f .workflows/plan/NEON_EGRESS_REDUCTION_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/NEON_EGRESS_REDUCTION_PLAN.md
