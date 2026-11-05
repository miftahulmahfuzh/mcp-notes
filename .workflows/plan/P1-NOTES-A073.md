> Adopted from `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/plan/SEER_ADVERSARIAL_PLAN.md` phase 7. Source: `.workflows/plan/seer-adversarial/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: Go live: land Seer, config, install/restart, first review

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R7: the feature runs for real. Seer's twins trade on paper in production, notesd reviews live decisions, and the owner can see it on the wall.
**Depends on:** Phase 2, 3, 6. Through them, 1, 4 and 5 as well. The mcp-notes set (4-6) must have been landed on `~/mcp-notes` `main` by the orchestrator before Part C.
**Difficulty:** NORMAL (an ops runbook with no feature code, but it writes to production: Neon, `origin/main` of both repos, and the live daemon)
**Package:** both repos. The only file edits are mcp-notes `README.md` and `CLAUDE.md` (one Architecture bullet).

---

## Goal

When this phase is done, Seer's `feature/seer-adversarial` is on `origin/main`, migration 027 is applied on
Neon (`strategies.twin_of`, `strategy_candidates`, `adversary_*` tables, the `A-GT` row), and the README's
configuration table documents every reviewer env key. The live notesd on 7317 is running the landed
mcp-notes `main` with `drizzle/0011` applied and the adversary job started. There is either a first live
verdict written to `adversary_verdicts` or a recorded reason why none could be written yet, along with
the date and time the first twins and verdicts are due. A dated go-live note records what is live and
what the GPD laptop still needs.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:** README.md configuration rows for exactly the seven keys phase 4's `src/config.ts`
`parseAdversary` reads (reconciled against phase-4 plan Step 1): `NOTESD_ADVERSARY`, `ADVERSARY_DAILY_CAP`,
`ADVERSARY_GATHER_MODEL`, `ADVERSARY_VERDICT_MODEL`, `ADVERSARY_GATHER_MAX_TURNS`,
`ADVERSARY_STOCK_TIMEOUT_MS`, `ADVERSARY_POLL_MS`; one CLAUDE.md Architecture bullet for `src/adversary/*`
(phase 4's handoff). Also one mcp-notes note (the go-live note, tags `#seer #adversary #golive`).
On Neon it applies `db/migrations/027_adversary.sql` (phase 1's file) and writes nothing else directly.
**Signature changes:** none
**Requires (from earlier phases):**
- Phase 1: `db/migrations/027_adversary.sql` per C1, including the `A-GT` row (`paper_start` NULL), plus `seer_engine.dates.session_open_utc(d) -> datetime` (UTC, tz-aware).
- Phase 2: `store.ensure_twins` (with the pure planner `roster.plan_twins`) runs inside `paper`'s night transaction. Twin rows have ids `<ID>-CX` and are never seeded by migration.
- Phase 3: web reads `twin_of`. Its suite is green.
- Phase 4: env keys parsed in `src/config.ts` `parseAdversary` (reconciled, phase-4 plan Step 1): `NOTESD_ADVERSARY` (on by default via `parseSwitch`; `DEFAULT_ADVERSARY_CONFIG` used by hand-built test configs is off), `ADVERSARY_DAILY_CAP` (15), `ADVERSARY_GATHER_MODEL` (`sonnet`), `ADVERSARY_VERDICT_MODEL` (`opus`), `ADVERSARY_GATHER_MAX_TURNS` (20), `ADVERSARY_STOCK_TIMEOUT_MS` (420000), `ADVERSARY_POLL_MS` (600000). No other env key. Data-tool keys (`FINNHUB_API_KEY`, `MASSIVE_API_KEY`, `SEC_CONTACT_EMAIL`) are read from `SEER_DIR/.env.local`, the same way the writer's URL is, and not from mcp-notes' `.env.local`. The job logs one `[notesd] adversary …` line at startup (on, off, or idle because 027 is missing). It also needs `drizzle/0011_adversary_reviews.sql`.
- Phase 5: `POST /api/adversary/review-now` (same-origin) and `GET /api/adversary/overview`, `GET /api/adversary/toggle`.
- Phase 6: the `/adversary` wall page, plus verify-notesd `features/adversary.md`.
- Orchestrator: lands mcp-notes `feature/seer-adversarial` (phases 4-7, including this phase's README commit) on `~/mcp-notes` `main` and pushes it.

**Leaves alone (owned by others):** all feature code in both repos (`src/**`, `web/**`, `engine/**`,
`db/migrations/**`, `drizzle/**`), `scripts/install.sh`, `deploy/notesd.service`, verify-* feature maps
(updated by phases 1-3 and 6), Seer's `nightly.yml`. A defect found while running this phase goes into
**Follow-ups** in the go-live note and gets a task card. It is never edited here.

## Decisions taken in this phase

- **P7-a. Apply 027 from the laptop, right after the push. Do not wait for the next nightly.** The
  nightly `Migrate` step (`.github/workflows/nightly.yml`, the step after `Install engine`) applies
  pending migrations on every run, so 027 would land at the next 06:17 UTC anyway. Running it locally is
  documented practice: `docs/runbooks/data-pipeline.md` lists `engine/.venv/bin/python -m seer_engine migrate`
  with "Neon stays the default (`.env.local`) for `migrate` …", and `~/seer/engine/.venv` exists (Python
  3.12, editable install of `~/seer/engine/src`). Applying now lets Part D drive notesd against the real
  schema today. Afterwards the nightly's `Migrate` step logs `skip 027_adversary.sql`. A dry-run goes first.
  It does not run while a nightly job holds the `seer-db-writer` concurrency group.
- **P7-b. `scripts/install.sh` gets no new step.** Reviewer keys come from `.env.local` (mcp-notes) and
  `SEER_DIR/.env.local` (Seer secrets), and both are read at runtime. The unit file does not change.
  `install.sh` has never run `db:migrate`. The README already says to run it "again after a pull that adds
  drizzle/*.sql" (README.md:832, docs/INSTALL.md:19), so this phase runs `npm run db:migrate` by hand once.
- **P7-c. No `.env.local` edit in `~/mcp-notes`.** All defaults are the intended ones (on, cap 15,
  sonnet/opus). The one exception: if phase 4 shipped `NOTESD_ADVERSARY` default **off**, add
  `NOTESD_ADVERSARY=on` (Step C2 checks this).
- **P7-d. The go-live record is an mcp-notes note, not a `docs/plans` file.** Part C runs after the set
  has landed on `main`. A docs file would need a second commit straight to `main` from an ops step, while
  a note is searchable by `/n` and the chat bar from both machines. Tags: `#seer #adversary #golive`.
- **P7-e. Integrate Seer by merging `origin/main` into the feature branch, then fast-forward `main`.**
  The full suite and verify-seer then run on exactly the tree that lands. `main` only ever moves by
  fast-forward.

## Files

| File | Action | What changes |
|---|---|---|
| `README.md` (mcp-notes worktree) | modify, after line 930 (`TEST_CONNECTORS_URL` row) | seven configuration rows for the reviewer |
| `CLAUDE.md` (mcp-notes worktree) | modify, `## Architecture` list | one bullet for `src/adversary/*` (phase 4 handoff) |

Nothing else is edited. Everything else in this phase is a command.

## Implementation Steps

Every step has a **Check**. A failed check means **STOP**: do no later step, write what failed and its
output into the go-live note's Follow-ups (Part E still runs, recording the stop), and report back.
Never use `--force`, `git commit -a`, or a broad pathspec.

Shell note: the Bash tool runs zsh. Run multi-line blocks through `bash -c '…'` or as here-doc scripts in
the scratchpad. Never `source` any `.env.local`, because Seer's `DATABASE_URL` holds an unquoted `&`. Raw
`psql` to Neon hangs from WSL (IPv6), so every Neon read goes through Seer's Python.

---

### Part A: README configuration rows (mcp-notes worktree, before landing)

#### Step A1: List the reviewer keys phase 4 actually reads
**File:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/src/config.ts`, `src/adversary/*.ts` (read only)
**Change:** none. Read the key names and their defaults from the code.
**Code:**
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
grep -ohE 'env\.(NOTESD_ADVERSARY|ADVERSARY_[A-Z0-9_]+)' src/config.ts | sed 's/^env\.//' | sort -u
grep -nE 'env\.(NOTESD_ADVERSARY|ADVERSARY_[A-Z0-9_]+)' src/config.ts
```
(Only `env.` reads count: `src/` also holds constants such as `ADVERSARY_TOGGLE_KEY`,
`ADVERSARY_MCP_SERVER`, `ADVERSARY_SUBDIR` and phase 5's `ADVERSARY_TOOL_NAMES`, which are not env keys.)
**Check:** the first command prints exactly `ADVERSARY_DAILY_CAP`, `ADVERSARY_GATHER_MAX_TURNS`,
`ADVERSARY_GATHER_MODEL`, `ADVERSARY_POLL_MS`, `ADVERSARY_STOCK_TIMEOUT_MS`, `ADVERSARY_VERDICT_MODEL`,
`NOTESD_ADVERSARY`. For each key, read its default and meaning off the
`parse*` call in `src/config.ts`. If a key's default differs from the rows below, the code wins: write
the code's default.

#### Step A2: Add the rows
**File:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/README.md:930`. Insert directly after the line
`| \`TEST_CONNECTORS_URL\` | set by \`test:int\` | Connector test container (admin URL). |` and before
the `NOTESD_SESSIONS` row.
**Change:** add these seven rows (one per key A1 printed; if A1 printed a key not below, phase 4 drifted
from its plan: add a row in the same style and record it in the go-live note).
**Code:**
```markdown
| `NOTESD_ADVERSARY` | on | `off` stops the Seer Adversarial reviewer on this machine: no reviews, no `paused` marks, no leases. It is the deploy-free kill switch. The ON/OFF toggle on the wall's `/adversary` page is a different switch, kept in the shared database, which both machines obey; while it is off the reviewer still writes `paused` marks. |
| `ADVERSARY_DAILY_CAP` | `15` | Deep reviews (one per Seer decision: a strategy's candidates for one session) per WIB day across this machine. A's candidates go first, then book decisions by earliest open, then early looks at book previews. A decision over the cap is left unreviewed, so its twin copies the original, and it is logged as `skipped_budget`. |
| `ADVERSARY_GATHER_MODEL` | `sonnet` | Claude model alias for the gathering stage (reads news, filings and prices through the reviewer's tools). The exact model id the SDK used is stored with each review. |
| `ADVERSARY_VERDICT_MODEL` | `opus` | Claude model alias that writes the verdict (agree, object, can't tell) from what was gathered. Its exact id is stored on every `adversary_verdicts` row, and a change shows as a dated revision on the page. |
| `ADVERSARY_GATHER_MAX_TURNS` | `20` | Turn cap of the gathering stage for one stock. A stock that runs out of turns is judged on what was gathered so far. |
| `ADVERSARY_STOCK_TIMEOUT_MS` | `420000` | Wall-clock limit for one stock, both stages together. A stock that times out gets no verdict, so its twin copies the original. |
| `ADVERSARY_POLL_MS` | `600000` | Pause between automatic review passes (10 minutes). "Review now" on the wall starts a pass at once. |
```

**File:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/CLAUDE.md`, `## Architecture`, append after the
**Claude Code sessions** bullet:
```markdown
- **Seer Adversarial** (`src/adversary/*`): a background reviewer that reads Seer's `strategy_candidates` and writes Claude's verdicts, `paused` marks and leases into Seer's DB through `seerWriter.ts` only (a table allow-list; the read-only connector guard stays read-only). `adversary_reviews` (`drizzle/0011`) is its attempt and usage log, written only by `reviewsRepo.ts`. Only verdicts decided before the session's open (`sessions.ts`, mirrors Seer's `session_open_utc`) count. Routes: `src/http/adversaryApi.ts`; MCP: `src/mcp/adversaryTools.ts`; web: `/adversary`. `NOTESD_ADVERSARY=off` starts nothing; tests use `DEFAULT_ADVERSARY_CONFIG` (off).
```
**Check (the lever, reusable by the reconciler and verifier):** every reviewer key in the code has a
README row. This must print nothing:
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
bash -c "comm -23 <(grep -ohE 'env\.(NOTESD_ADVERSARY|ADVERSARY_[A-Z0-9_]+)' src/config.ts | sed 's/^env\.//' | sort -u) \
                  <(grep -oE '\`(NOTESD_ADVERSARY|ADVERSARY_[A-Z0-9_]+)\`' README.md | tr -d '\`' | sort -u)"
```
**Impact:** docs only.

#### Step A3: Commit the README on the feature branch
**Code:**
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
npm run typecheck && npm test
git add README.md CLAUDE.md
git commit -m "docs: configuration rows and architecture note for the Seer Adversarial reviewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
**Check:** `git show --stat HEAD` lists only `README.md` and `CLAUDE.md`. Then hand back to the orchestrator, which lands the
mcp-notes set on `main`. Part B can run in parallel with the landing. Part C must wait for it.

---

### Part B: Land Seer and migrate Neon

#### Step B1: Preconditions
**Code:**
```sh
W=/home/miftah/.worktrees/seer/seer-adversarial
git -C "$W" status --porcelain                                  # must print nothing
git -C "$W" branch --show-current                               # feature/seer-adversarial
git -C /home/miftah/seer status --porcelain --untracked-files=no # must print nothing
git -C /home/miftah/seer branch --show-current                  # main
docker start seer-pg >/dev/null 2>&1 || docker run -d --name seer-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
[ -x "$W/engine/.venv/bin/python" ] || (cd "$W" && python3.12 -m venv engine/.venv && engine/.venv/bin/pip install -e 'engine[dev]')
[ -d "$W/web/node_modules" ] || (cd "$W/web" && npm ci --no-audit --no-fund)
```
(This machine has no `python3.11`. `~/seer/engine/.venv` is 3.12, so the worktree venv uses 3.12 too.)
**Check:** the two `status` lines are empty and the branches are as commented. **Stop** if `~/seer` has
tracked changes, because someone else's work is in flight there.

#### Step B2: Bring origin/main into the feature branch
**Code:**
```sh
W=/home/miftah/.worktrees/seer/seer-adversarial
git -C "$W" fetch origin
git -C "$W" log --oneline feature/seer-adversarial..origin/main    # what landed meanwhile
git -C "$W" diff --name-only feature/seer-adversarial...origin/main -- db/migrations
git -C "$W" merge --no-edit origin/main
```
**Conflict rules:**
- `origin/main` added a migration numbered `027` or higher: **STOP**. Renumbering 027 changes phase 1's
  file and its tests. It goes back to phase 1 as a follow-up.
- Conflicts in `engine/src/seer_engine/paper/roster.py`, `engine/tests/test_paper_roster.py` (`PINS`,
  `SEED_ROWS`), `commands/paper.py` or `paper_check.py`: **STOP**, because main changed the roster or
  the night under the twins. Hand it back to phase 2.
- `lab/lab.sqlite` / `web/data/lab.json`: the feature branch never touches them. Take `origin/main`'s
  copy (`git checkout --theirs lab/lab.sqlite web/data/lab.json`).
- Anything else (README, runbook, a feature map): resolve by keeping both texts. Then
  `git add <each resolved path>` and `git commit --no-edit`.

**Check:** `git -C "$W" log -1 --format=%s` is the merge, or the merge was a no-op ("Already up to date").
`git -C "$W" status --porcelain` is empty.

#### Step B3: Full Seer suite on the tree that will land
**Code:**
```sh
cd /home/miftah/.worktrees/seer/seer-adversarial
export PG_TEST_URL=postgresql://postgres:pg@localhost:55432/postgres
OUT=$(mktemp)
engine/.venv/bin/ruff check engine
engine/.venv/bin/pytest engine/tests -q -rs | tee "$OUT"
! grep -q "^SKIPPED .*: PG_TEST_URL is not set" "$OUT"
(cd web && npx tsc --noEmit && npm test)
```
**Check:** ruff exit 0. Pytest ends `N passed` with 0 failed, and the grep guard passes, which means the DB
tests ran rather than skipped (the same guard CI uses, `.github/workflows/engine-ci.yml`). tsc and vitest exit 0.
**Stop** on any red: do not push. A failure a peer reported is re-run here before it is believed
(Seer CLAUDE.md "Concurrency").

#### Step B4: verify-seer proof on the tree that will land
**Code:**
```sh
cd /home/miftah/.worktrees/seer/seer-adversarial
V=.claude/skills/verify-seer/scripts/verify.sh
$V up --no-web --empty          # note RUN=
$V doctor "$RUN"                # "database ok ... (27 migrations, strategies: N)" where N = 24 (23 + A-GT)
                                # unless features/engine-night.md (as phases 1-2 left it) states another count
```
Then run every journey that `features/engine-night.md` now lists for twins and candidates (phases 1-2 added
them, e.g. a paper night on test data that creates `A-GT-CX`, `RAW35-FR-GT-CX`, `COSK-FR-GT-CX` and
`paper_check` ok). Run each command as written there and compare to its stated end state. Then:
```sh
$V down "$RUN"
$V up                           # demo data, web
$V doctor "$RUN"
```
Then run the journeys in `features/leaderboard.md` and `features/today.md` as phase 3 left them. At minimum:
```sh
$V api "$RUN" GET /leaderboard  # a twin card labelled Paper next to its original (text as leaderboard.md states)
$V api "$RUN" GET /             # Today: no "+Claude" name anywhere
$V shoot "$RUN" --theme dark --width 1280 /leaderboard
$V down "$RUN"
```
**Check:** every journey's end state matches its entry. Read the leaderboard PNG. **Stop** on a mismatch
that is the app's fault. Do not push. It goes back to the owning phase (2 for engine, 3 for web).

#### Step B5: Fast-forward Seer main and push
**Code:**
```sh
cd /home/miftah/seer
git fetch origin
git merge --ff-only origin/main                       # local main == origin/main
git merge --ff-only feature/seer-adversarial
git push origin main
gh run list --repo miftahulmahfuzh/seer --branch main --limit 5 --json name,status,conclusion,headSha,createdAt
```
**Check:** both `--ff-only` succeed. If the second fails, `origin/main` moved after B2: go back to B2 and
re-run B3-B4. `git push` succeeds without force. Wait until the `engine-ci` run for the pushed `headSha`
finishes: `gh run watch <id> --repo miftahulmahfuzh/seer --exit-status`, or poll `gh run list` with
Monitor. **Stop** before B6 if it is red: Neon does not get migrated under a red main. Record it as a
follow-up.

#### Step B6: Apply 027 on Neon
**Code:**
```sh
cd /home/miftah/seer
gh run list --repo miftahulmahfuzh/seer --workflow nightly.yml --limit 3 --json status,createdAt,conclusion
engine/.venv/bin/python -m seer_engine --dry-run migrate     # "would apply 027_adversary.sql" and nothing else
engine/.venv/bin/python -m seer_engine migrate               # "apply 027_adversary.sql"
```
**Check:** no nightly run has `status` `in_progress` or `queued`. If one does, wait for it to finish,
because it shares the `seer-db-writer` group. The dry run lists exactly `027_adversary.sql`. **Stop** if
it lists anything else (Neon is behind or ahead of what you think). The real run exits 0. If the nightly
already applied it, both print `skip 027_adversary.sql`, and that is fine.

#### Step B7: Read the schema back from Neon (read-only)
**Code:**
```sh
cd /home/miftah/seer
engine/.venv/bin/python - <<'PY'
from seer_engine import db
conn = db.connect()
conn.read_only = True
q = lambda sql, *a: conn.execute(sql, a).fetchall()
print("027 applied:", q("select name, applied_at from schema_migrations where name like '027%%'"))
print("twin_of:", q("select column_name from information_schema.columns where table_name='strategies' and column_name='twin_of'"))
print("tables:", sorted(r[0] for r in q("select table_name from information_schema.tables where table_schema='public' and table_name in ('strategy_candidates','adversary_verdicts','adversary_marks','adversary_leases')")))
print("next_decision_session:", q("select column_name from information_schema.columns where table_name='book_previews' and column_name='next_decision_session'"))
print("A-GT:", q("select id, engine, rules_id, object_name, status, paper_start, twin_of from strategies where id='A-GT'"))
print("twins:", q("select id, twin_of, status from strategies where twin_of is not null order by id"))
conn.rollback(); conn.close()
PY
```
**Check:** one `027_adversary.sql` row. `twin_of` is present. All four tables are listed.
`next_decision_session` is present. `A-GT` is one row with `status='active'` and `paper_start=None`. The
`twins` row list is empty, which is expected: phase 2 creates twins on the next paper night, not in the
migration (decision D4).

---

### Part C: Rebuild and restart the live notesd (after the mcp-notes set lands)

#### Step C1: Preconditions
**Code:**
```sh
cd /home/miftah/mcp-notes
git status --porcelain --untracked-files=no      # must print nothing
git fetch origin && git merge --ff-only origin/main
ls src/adversary/ drizzle/0011_adversary_reviews.sql web/src/pages/AdversaryPage.tsx >/dev/null
grep -c 'ADVERSARY_DAILY_CAP' README.md          # >= 1 (the Part A commit landed)
```
**Check:** all succeed. **Stop** (and tell the orchestrator) if the set is not on `main` yet, because this
phase never lands mcp-notes itself.

#### Step C2: Config
**Code:**
```sh
cd /home/miftah/mcp-notes
grep -nE "NOTESD_ADVERSARY" src/config.ts       # read the default
grep -E '^(NOTESD_ADVERSARY|ADVERSARY_)' .env.local || echo "no reviewer keys in .env.local (defaults apply)"
grep -cE '^(FINNHUB_API_KEY|MASSIVE_API_KEY|SEC_CONTACT_EMAIL|DATABASE_URL_UNPOOLED)=.+' /home/miftah/seer/.env.local   # 4
```
**Change:** none expected: phase 4's `loadConfig` reads `NOTESD_ADVERSARY` with `parseSwitch`, default on
(index Decision D18). `DEFAULT_ADVERSARY_CONFIG` has `enabled: false`; that constant is only for hand-built
test configs and does not mean the daemon defaults off. Only if `parseSwitch('NOTESD_ADVERSARY', …)` itself
defaults off (phase 4 drifted) append one line
to `~/mcp-notes/.env.local` (gitignored, never committed):
```sh
printf '\nNOTESD_ADVERSARY=on\n' >> /home/miftah/mcp-notes/.env.local
```
**Check:** the Seer key count is 4, meaning the reviewer's data tools and writer have what they need. If
it is lower, record which key is empty as a follow-up and continue. The reviewer must degrade on its own
(a missing data key gives "can't tell", per phase 4).

#### Step C3: Migrate the notes DB, build, restart
**Code:**
```sh
cd /home/miftah/mcp-notes
[ package-lock.json -nt node_modules/.package-lock.json ] && npm ci
npm run db:migrate                               # applies drizzle/0011 on the direct Neon host
npm run build
systemctl --user restart notesd
for i in $(seq 1 30); do curl -fsS --max-time 2 http://127.0.0.1:7317/health && break; sleep 1; done
systemctl --user is-active notesd
```
**Check:** `db:migrate` exits 0. `build` exits 0 and `dist/main.js` exists. `/health` returns
`{"ok":true,"service":"notesd"}` and `is-active` prints `active`. **Stop** on a failed health check and
attach `journalctl --user -u notesd -n 80 --no-pager`.

#### Step C4: The adversary job started
**Code:**
```sh
journalctl --user -u notesd --since "-3 min" --no-pager | grep -i adversary
curl -fsS http://127.0.0.1:7317/api/adversary/toggle
curl -fsS http://127.0.0.1:7317/api/adversary/overview | head -c 2000
```
**Check:** at least one `adversary` log line saying the job is running, not "off: NOTESD_ADVERSARY=off" and
not "idle: migration 027 missing". The toggle answers `on` (absent setting = on, C4). The overview answers
200 JSON listing the Seer originals read from `strategies`, including `A-GT`. Twins may still be absent at
this point.

---

### Part D: First twins and first review

#### Step D1: When the first twins and the first review window are
**Code (read-only):**
```sh
cd /home/miftah/seer
engine/.venv/bin/python - <<'PY'
from datetime import datetime, timezone
from seer_engine import db, dates
now = datetime.now(timezone.utc)
rd = dates.run_dates(now)
conn = db.connect(); conn.read_only = True
last = conn.execute("select max(session_date) from runs where status='success'").fetchone()[0]
cand = conn.execute("select strategy_id, session_date, kind, count(*) from strategy_candidates where session_date >= %s group by 1,2,3 order by 2,1", (rd.session_date,)).fetchall()
twins = conn.execute("select id, paper_start from strategies where twin_of is not null and status='active' order by id").fetchall()
conn.rollback(); conn.close()
print("now", now.isoformat(), "| last successful bars session", last, "| run_dates", rd)
print("candidates for sessions >= ", rd.session_date, ":", cand)
print("active twins:", twins)
nxt = rd.session_date if last is None or last < rd.data_date else dates.next_session(rd.session_date)
print("next paper night decides", nxt, "; its session opens", dates.session_open_utc(nxt).isoformat())
PY
```
(`runs` and `status='success'` are the bars-run table and state `paper` gates on, see engine-night.md. If the
column names differ, read `\d runs` through the same Python and adjust only this read.)

**What the output means (write it into the go-live note):**
- Twins (`*-CX`) and `A-GT`'s start are created by the **first paper night after 027 is on Neon**: the
  nightly cron `17 6 * * 2-6` (06:17 UTC = 13:17 WIB, Tue-Sat), with retries at 09:41 and 12:41 UTC.
  That same night writes `strategy_candidates` for every original's next session `S`. The reviewer then
  has until `session_open_utc(S)` (14:30 UTC in US winter, e.g. 2026-11-06 → `2026-11-06T14:30:00Z`
  = 21:30 WIB) to write verdicts.
- A twin decides `S` one night late (D1, lag form). Its first trade decision therefore appears on the
  night **after** `S`, and `A-GT-CX` starts no earlier than `A-GT`'s own `paper_start`.
- Example: if 027 is applied on Thu 2026-11-05 after the 06:17 UTC run, the first paper night with twins
  is Fri 2026-11-06 06:17 UTC (deciding the Fri 11-06 session, open 14:30 UTC). The first twin decisions
  are written Sat 2026-11-07 06:17 UTC.

#### Step D2: Review now
Only if D1 printed candidates for a session whose open is still in the future. Otherwise skip to D3 with
reason "no candidates yet: first paper night is <date> 06:17 UTC".
**Code:**
```sh
curl -sS -X POST http://127.0.0.1:7317/api/adversary/review-now \
  -H 'Origin: http://127.0.0.1:7317' -H 'content-type: application/json' -d '{}' ; echo
```
(If phase 5's plan or README HTTP table gives `review-now` a body, such as `{strategy_id, session_date}`,
send that instead. The `Origin` must equal the request origin exactly, `src/http/sameOrigin.ts:14-31`.)
Then wait for the run, using Monitor with an until-loop on the journal, at most 30 min (one deep review is
a few minutes, and the daily cap is 15):
```sh
journalctl --user -u notesd -f --no-pager | grep -i --line-buffered 'adversary'
```
**Check:** the POST answers 2xx (403 `forbidden_origin` means the header is wrong; fix it and retry once).
Log lines show reviews starting and finishing, or a clear skip reason (lease held by another host,
budget, toggle).

#### Step D3: Read the results back
**Code (read-only):**
```sh
cd /home/miftah/seer
engine/.venv/bin/python - <<'PY'
from seer_engine import db
conn = db.connect(); conn.read_only = True
for r in conn.execute("""select strategy_id, session_date, symbol, verdict, left(reason,120), jsonb_array_length(sources),
                                model, host, decided_at from adversary_verdicts order by decided_at desc limit 40""").fetchall():
    print(r)
print("marks:", conn.execute("select * from adversary_marks order by created_at desc limit 10").fetchall())
print("leases:", conn.execute("select * from adversary_leases order by claimed_at desc limit 10").fetchall())
conn.rollback(); conn.close()
PY
curl -fsS http://127.0.0.1:7317/api/adversary/overview | head -c 2000
```
For the notes-side attempt log (`adversary_reviews`), use the MCP tool or the HTTP route phase 5 exposes
for it (`adversary_verdicts` / `GET /api/adversary/decision`), not raw SQL on the notes DB.
**Check (pass = either):**
- at least one `adversary_verdicts` row with `decided_at` before its session's open, a non-empty `sources`
  for every agree/object, and `host` = this machine; or
- zero rows, and the reason is recorded: no candidates yet (D1), every attempt `failed` (with the
  `error` from the attempt log), `skipped_budget`, a lease held by the GPD host, or the toggle off
  (then `adversary_marks` holds `paused` rows).

A verdict that looks wrong is a follow-up for phase 4's lens or prompt. It is never hand-edited, and
verdicts are append-only (trigger, C1).

---

### Part E: Go-live note

#### Step E1: Write the note through notesd
**Change:** create one note, via the notes MCP `create` tool with origin
`{cwd: "/home/miftah/mcp-notes", repo: "mcp-notes"}`, or via HTTP if MCP is not available in the
session. Fill every `<…>` from the outputs above. Never write a number that was not read back in B7/D1/D3.
**Code (HTTP form):**
```sh
curl -sS -X POST http://127.0.0.1:7317/api/notes -H 'content-type: application/json' --data-binary @- <<'JSON'
{"body": "Seer Adversarial go-live, <YYYY-MM-DD HH:MM WIB>\n\nLive now:\n- Seer main <short sha> (feature/seer-adversarial merged), engine-ci <green|red>.\n- Neon: migration 027 applied <applied_at>; strategies.twin_of, strategy_candidates, adversary_verdicts/marks/leases present; A-GT active, paper_start not yet set.\n- notesd on Lenovo: mcp-notes main <short sha>, drizzle 0011 applied, restarted <time>, adversary job <on|off|idle> (log: <line>).\n- Reviewer config: NOTESD_ADVERSARY=<v>, ADVERSARY_DAILY_CAP=<v>, gather <model>, verdict <model>.\n\nFirst twins: the paper night of <date> 06:17 UTC (13:17 WIB) creates the -CX twins and starts A-GT; candidates for <session> must be reviewed before <open UTC> (<open WIB>). First twin decisions the night after.\n\nFirst review: <N verdicts (agree/object/unsure counts) for <strategy> <session>, host <host>> OR <none: reason>.\n\nFollow-ups:\n- GPD laptop: cd ~/mcp-notes && git pull --ff-only && scripts/install.sh (it builds and restarts; no db:migrate, the database is shared). Check that ~/seer/.env.local exists there so its reviewer can reach Seer; the lease keeps the two machines from reviewing the same decision.\n- <any stop or defect from this runbook, with the owning phase>\n\n#seer #adversary #golive"}
JSON
```
**Check:** the response holds an `id` like `A-B32` and `tags` contains `seer`, `adversary`, `golive`. Quote
it in the report as a link `[A-B32](http://localhost:7317/?note=A-B32)`.

## Principles applied

- Prove it works: every part ends with a read-back from the real artifact. B7 reads Neon's
  `information_schema`, C3/C4 check `/health`, the journal and `/api/adversary/overview`, and D3 reads
  `adversary_verdicts`. "The command exited 0" is never the check.
- Sequence into verifiable units: there are four gates that can fail, and each one blocks the next. B3/B4
  (suite and verify-seer) must pass before the push, B5 (CI green) before the Neon migrate, B6 (dry run
  lists exactly 027) before the real migrate, and C1 (set on main) before the restart. A red gate stops
  the run rather than being worked around.
- Build the lever: the README completeness check in A2 (a `comm` of env keys in `src` against keys in the
  README) replaces eyeballing the table. The reconciler and verifier can re-run it.
- Laziness protocol: there is no new `install.sh` step and no `.env.local` change unless the default
  forces one (P7-b, P7-c). The go-live record is a note rather than a new docs file on `main` (P7-d).

## Verification

**Build:** `cd /home/miftah/mcp-notes && npm run build` (Part C), and `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && npm run typecheck` (Part A)
**Tests:** Seer: `ruff check engine && pytest engine/tests -q -rs` (with `PG_TEST_URL=postgresql://postgres:pg@localhost:55432/postgres`) and `cd web && npx tsc --noEmit && npm test`. mcp-notes: `npm run typecheck && npm test` in the worktree before the README commit.
**Proof:** the production artifacts themselves, read back:
- Harness: `.claude/skills/verify-seer` (Seer, Step B4, on the tree that lands). For the live notesd there
  is no harness, because verify-notesd never touches the live daemon on 7317 by design. The live checks
  instead are `curl` on 7317, `journalctl --user -u notesd`, and read-only Python reads of Neon.
- Feature-map entries: Seer `features/engine-night.md`, `features/leaderboard.md`, `features/today.md`
  (as phases 1-3 left them). The notesd `features/adversary.md` is run by phase 6's verifier, not here.
- Journeys:
  1. README completeness: the A2 `comm` command prints nothing.
  2. Seer landed: `git -C /home/miftah/seer merge-base --is-ancestor feature/seer-adversarial origin/main && echo landed` prints `landed`; `gh run list --repo miftahulmahfuzh/seer --branch main --limit 1 --json conclusion` shows `success` for engine-ci.
  3. Neon schema: the B7 script prints one `027_adversary.sql` row, `twin_of`, the four tables, `next_decision_session`, and `A-GT` active.
  4. notesd live: `curl -fsS http://127.0.0.1:7317/health` returns `{"ok":true,"service":"notesd"}`, `curl -fsS http://127.0.0.1:7317/api/adversary/overview` returns 200 JSON containing `"A-GT"`, and `journalctl --user -u notesd --since "-1 h" | grep -i adversary` shows the job running.
  5. First review: the D3 script prints ≥ 1 verdict row with `decided_at` before the open and sources ≥ 1 for agree/object, or the go-live note states the reason for none.
  6. Record: notes MCP `search` "Seer Adversarial go-live" (or `GET /api/notes?tags=golive`) returns the note.
- Neighbor check: the Seer nightly itself is the thing most likely to break. After the next 06:17 UTC run,
  `gh run list --repo miftahulmahfuzh/seer --workflow nightly.yml --limit 1 --json conclusion` must be
  `success`, and D1's script must then list active `*-CX` twins and candidates for the next session. That
  run comes after this phase, so record the command in the note for whoever checks next. On the notes
  side: the wall at `http://127.0.0.1:7317/` still answers 200, and `curl -fsS 'http://127.0.0.1:7317/api/notes?limit=1'` returns a note.
- Cost: Step D2 spends real Claude subscription turns: at most `ADVERSARY_DAILY_CAP` deep reviews (gather
  sonnet + verdict opus), usually one decision's worth. Nothing else is paid. verify-seer runs offline
  (no `--net`, no `--llm`).

**Exit criteria:** Seer `origin/main` contains `feature/seer-adversarial` with engine-ci green. Neon has 027
(B7 output). The live notesd serves landed mcp-notes `main` with the adversary job running. Either a first
verdict exists in `adversary_verdicts`, or the go-live note records why not and when the first review
window opens. The go-live note exists with the GPD follow-up.

## Handoffs

- **Orchestrator:** lands mcp-notes `feature/seer-adversarial` (including this phase's README commit) on
  `main` between Part A and Part C. This phase never merges mcp-notes.
- **Phase 1:** renumbering, if `origin/main` gained migration 027 or higher meanwhile (B2 stop).
- **Phase 2/3:** any red test or verify-seer journey found in B3/B4, and conflicts in roster or night code (B2 stop).
- **Phase 4:** the startup log line `[notesd] adversary …` that C4 greps for, the `NOTESD_ADVERSARY` default
  (on), and the seven keys (reconciled: A2 lists exactly phase 4's `parseAdversary` keys).
- **Phase 5:** the exact `review-now` request body, and the route that exposes `adversary_reviews` attempts.
- **GPD laptop (owner's other machine, cannot be reached from here):** `cd ~/mcp-notes && git pull --ff-only && scripts/install.sh`.
  No `db:migrate`, because the database is shared. `~/seer/.env.local` must be present there. This is recorded
  in the go-live note as a follow-up.

## Rollback

- notesd: `NOTESD_ADVERSARY=off` in `~/mcp-notes/.env.local`, then `systemctl --user restart notesd`, stops
  the reviewer with no deploy. The wall toggle (shared) stops both machines' reviews, though marks are still
  written. Code: check out the previous `main` sha, `npm run build`, and restart. `drizzle/0011` is additive
  and stays.
- Seer: do not revert the merge while 027 is on Neon and twins may exist, because an active row whose object
  no longer resolves stops the night. Follow the plan index's rollback: a migration 028 retires `A-GT` and every
  `*-CX` row (history kept) first, then the code revert. Before the first paper night after B6, the only new
  production row is `A-GT` with `paper_start` NULL.
- README: `git revert` the Part A commit.
