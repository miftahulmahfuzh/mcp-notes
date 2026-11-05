> Adopted from `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/plan/SEER_ADVERSARIAL_PLAN.md` phase 4. Source: `.workflows/plan/seer-adversarial/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: mcp-notes reviewer job

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R4 — the reviewer inside notesd: discovery, lease, briefs, data tools, two-stage agent, writer, ON/OFF toggle, daily budget, paused marks
**Depends on:** Phase 1 (Seer migration 027: `strategies.twin_of`, `strategy_candidates`, `book_previews.next_decision_session`, `adversary_verdicts` / `_marks` / `_leases`)
**Difficulty:** HARD
**Package:** mcp-notes `src/adversary/` (plus `claude/adversary/briefs/`, `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/db/schema.ts`, `drizzle/0011_adversary_reviews.sql`)

Work only in `/home/miftah/.worktrees/mcp-notes/seer-adversarial` (invariant 7). The Seer worktree
`/home/miftah/.worktrees/seer/seer-adversarial` is read only, and only through its migrations (the
integration harness rebuilds the Seer schema from them, invariant 8).

---

## Goal

After this phase a notesd with `NOTESD_ADVERSARY=on` (the default) polls Seer's database, finds
every decision of every active original that has an active Claude twin (bracket candidates and book
rank/kickoff targets from `strategy_candidates`, early looks from `book_previews`), leases each
(strategy, session) across hosts by the DB clock, reviews each stock with a two-stage Claude Agent
SDK run (Sonnet gathers through in-process data tools, Opus decides with zod-validated structured
output, every agree/object citing a page the run actually fetched), writes the verdict into Seer
before the session opens, logs every attempt in the new mcp-notes table `adversary_reviews`, keeps
to a daily cap, and writes `paused` marks instead while the shared ON/OFF toggle is off. Phase 5
gets a public `AdversaryService` (`reviewNow`, `getToggle`, `setToggle`, `status`, `events`) on
`AppDeps.adversary`. Nothing is shown on the wall yet.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates (all new files):**
- `src/adversary/types.ts`: `DecisionKind`, `ReviewStage`, `Verdict`, `RosterRow`, `CandidateRow`,
  `PreviewRow`, `VerdictRef`, `MarkRef`, `Bar`, `LabMethod`, `Pick`, `Decision`, `Source`,
  `ReviewVerdict`, `ReviewUsage`, `ReviewOutcome`, `Lens`, `ReviewContext`, `StockReviewer`,
  class `ReviewFailure`.
- `src/adversary/sessions.ts`: `sessionOpenUtc(sessionDate): Date` (C3 mirror, pinned examples
  `2026-11-04 -> 2026-11-04T14:30:00Z`, `2026-07-01 -> 2026-07-01T13:30:00Z`), `assertSessionDate`,
  `wibDay`, `wibDayStartUtc`, `utcDate`, `addDays`, `WIB_OFFSET_MS`.
- `src/adversary/events.ts`: `AdversaryEvents`, `AdversaryChange`, `AdversaryOp`,
  `AdversaryChangeListener`.
- `src/adversary/toggle.ts`: `ADVERSARY_TOGGLE_KEY = 'adversary.auto'`, `ToggleState`,
  `TOGGLE_DEFAULT`, `parseToggle`, `readToggle`, `writeToggle`, `SettingsStore`.
- `src/adversary/plan.ts`: `reviewableOriginals`, `toDecisions`, `toPreviewDecisions`,
  `planWork`, `PlannedAction`, `PlanInput`, `DraftRef`, `decisionKey`, `attemptKey`, `draftKey`,
  `DRAFT_WINDOW_MS`, `MAX_FAILED_ATTEMPTS`.
- `src/adversary/lens.ts`: `BRIEFS_DIR`, `readBrief`, `lensText`, `buildLens`.
- `src/adversary/prompt.ts`: `PROMPT_REVISION = 'adv-v1'`, `REASON_MAX_CHARS = 600`,
  `GATHER_SYSTEM`, `VERDICT_SYSTEM`, `promptVersion`, `gatherPrompt`, `verdictPrompt`.
- `src/adversary/seerReader.ts`: class `SeerReader` (read-only, over `createConnector('seer')`).
- `src/adversary/seerWriter.ts`: class `SeerWriter`, `assertWritable`, `WRITABLE_TABLES`,
  `AdversaryWriteError`, `NewVerdict`, `WrittenVerdict`.
- `src/adversary/tools.ts`: `ADVERSARY_MCP_SERVER = 'adversary'`, `adversaryTools`,
  `adversaryServer`, `ReviewTools`, `ToolScope`, `ToolDeps`, `SourceLedger`, `normalizeUrl`,
  `publicHttpUrl`, `readPage`, `htmlToText`, `priceContext`, `intervalLimiter`, `defaultLimiters`,
  `loadSeerKeys`, `SeerKeys`, `createTickerCikLookup`, `loadTickerCik`, `FetchFn`.
- `src/adversary/agent.ts`: `createAgentReviewer`, `finalizeVerdict`, `VerdictSchema`,
  `VERDICT_JSON_SCHEMA`, `ADVERSARY_SUBDIR = 'adversary'`, `AgentReviewerOptions`.
- `src/adversary/reviewsRepo.ts`: class `ReviewsRepo` (the only writer of `adversary_reviews`),
  `NewReview`, `ReviewStatus`, `RecentReviews`.
- `src/adversary/service.ts`: class `AdversaryService`, `createAdversaryService`,
  `RunSummary`, `AdversaryStatus`, `ReviewNowOptions`, `RunTrigger`, `SchemaState`.
- `src/db/schema.ts`: table `adversaryReviews` (`adversary_reviews`), types `AdversarySource`,
  `AdversaryStoredVerdict`, `AdversaryReviewRow`, `NewAdversaryReviewRow`.
- `drizzle/0011_adversary_reviews.sql` (+ `drizzle/meta/0011_snapshot.json`, journal entry), generated.
- `src/config.ts`: `AdversaryConfig`, `DEFAULT_ADVERSARY_CONFIG`, `parseAdversary`, `Config.adversary`.
- `claude/adversary/briefs/STRATEGY_A.md`, `RESIDMOM35.md`, `COSKEW.md` (keyed by `strategies.object_name`).
- Tests: `tests/unit/adversary/{sessions,plan,seerWriter,lens,tools,agent,toggle}.test.ts`,
  `tests/helpers/fakeReviewer.ts`, `tests/integration/adversary/{harness.ts,reviewer.int.test.ts}`.
- Proof harness: `verify.sh up --adversary`, `verify.sh exec RUN [--seer] SQL`;
  `.claude/skills/verify-notesd/features/adversary.md` (reviewer section) + its README row.

**Public API for phase 5 (`src/adversary/service.ts`, reached as `deps.adversary`, null when off):**
```ts
class AdversaryService {
  readonly events: AdversaryEvents;
  readonly host: string;
  /** One manual pass now: reviews even while the toggle is off. Serialised behind any running pass. Long: do not await in a request handler. */
  reviewNow(options?: { strategyId?: string; sessionDate?: string; rereview?: boolean }): Promise<RunSummary>;
  /** One automatic pass now (obeys the toggle: off writes paused marks). Used by the poll loop and tests. */
  pollNow(): Promise<RunSummary>;
  getToggle(): Promise<ToggleState>;               // { on, changed_at, host }; absent = on
  setToggle(on: boolean, host: string): Promise<ToggleState>;   // writes app_settings 'adversary.auto', emits op 'toggle'
  status(): Promise<AdversaryStatus>;
  start(): void;          // background.ts
  close(): Promise<void>; // background.ts stop
}
interface ToggleState { on: boolean; changed_at: string | null; host: string | null }
interface RunSummary {
  trigger: 'auto' | 'manual'; host: string; started_at: string; finished_at: string | null;
  reviewed: number; reused: number; drafted: number; failed: number; late: number;
  skipped_budget: number; marks: number; leases_lost: number; error: string | null;
}
interface AdversaryStatus {
  host: string; auto: ToggleState; running: 'auto' | 'manual' | null;
  schema: 'unknown' | 'ready' | 'missing' | 'unreachable';
  daily_cap: number; used_today: number; next_poll_at: string | null;
  last_run: RunSummary | null; models: { gather: string; verdict: string };
}
```

**Events (C4), `src/adversary/events.ts`:** `AdversaryEvents.on(listener) -> unsubscribe`, payload
`{ type: 'adversary', op: 'verdict' | 'mark' | 'toggle' | 'run', strategy_id?: string, session_date?: string }`.
`verdict` after each Seer verdict insert (final stage only, incl. reused drafts); `mark` after each
inserted paused mark; `toggle` after `setToggle`; `run` at the start and at the end of every pass.
Phase 5 relays it as SSE event `adversary`.

**mcp-notes table `adversary_reviews` (migration `drizzle/0011_adversary_reviews.sql`):**

| column | type | meaning |
|---|---|---|
| `id` | bigserial PK | |
| `strategy_id` | text NOT NULL | the ORIGINAL's id |
| `session_date` | date NOT NULL | decision session (draft: the book's `next_decision_session`) |
| `symbol` | text NOT NULL | |
| `stage` | text NOT NULL, `draft`/`final` | draft = early look from `book_previews`, never written to Seer |
| `status` | text NOT NULL, `ok`/`failed`/`skipped_budget`/`late` | `late` = Seer verdict written, decided_at >= open |
| `verdict` | jsonb NULL | `AdversaryStoredVerdict` `{verdict, reason, sources[], lens, seer_verdict_id, downgraded}` |
| `prompt_version` | text NOT NULL | `adv-v1-<12 hex>` |
| `gather_model`, `verdict_model` | text NULL | exact model ids from the SDK result (`modelUsage` keys) |
| `input_tokens`, `output_tokens` | integer NOT NULL default 0 | input includes cache read + cache creation |
| `cost_usd` | double precision NOT NULL default 0 | SDK `total_cost_usd`, both stages |
| `turns` | integer NOT NULL default 0 | SDK `num_turns`, both stages |
| `error` | text NULL | |
| `host` | text NOT NULL | `os.hostname()` |
| `reused_from` | bigint NULL FK -> `adversary_reviews.id` | **addition to C4**: a final row that reused a draft (costs no budget) |
| `started_at` | timestamptz NOT NULL | |
| `finished_at` | timestamptz NULL | |

Deep reviews counted against the cap: rows with `status IN ('ok','failed','late') AND reused_from IS NULL`
and `started_at >=` start of the current WIB day.

**Seer writes (C4):** only `adversary_verdicts` (INSERT; UPDATE `SET superseded_by = $n` only),
`adversary_marks` (INSERT … ON CONFLICT DO NOTHING), `adversary_leases` (claim per C4 SQL, renew,
release = DELETE own row). Allow-list enforced by `assertWritable` on every statement. `decided_at`
is the Seer DB's `now()`; `started_at` is `LEAST(host clock, now())` so `CHECK (decided_at >= started_at)`
holds across clock skew.

**Signature changes:**
- `interface Config` gains required `adversary: AdversaryConfig` (every hand-built `Config` literal
  adds `adversary: DEFAULT_ADVERSARY_CONFIG`; done in this phase, Step 13).
- `interface AppDeps` gains required `adversary: AdversaryService | null` (every hand-built
  `AppDeps` literal adds `adversary: null`; Step 13).

**Requires (from earlier phases):**
- Phase 1: migration `027_adversary.sql` exactly as contract C1 names it (tables, columns, `twin_of`,
  `book_previews.next_decision_session`); its append-only trigger on `adversary_verdicts` must allow
  `UPDATE adversary_verdicts SET superseded_by = <id> WHERE id = <old> AND superseded_by IS NULL` and
  must not block `TRUNCATE` (the integration harness truncates every Seer table between tests).
  Reconciled against phase 1's exact rule (trigger `adversary_verdicts_append_only`, BEFORE UPDATE OR
  DELETE, FOR EACH ROW; TRUNCATE not blocked): DELETE is refused; an UPDATE passes only when every
  column but `superseded_by` is unchanged, the old `superseded_by` is NULL, and the new value is the id
  of a row with a GREATER id and the same `(strategy_id, session_date, symbol)`; refusals are
  `RAISE EXCEPTION` (SQLSTATE P0001) with a message starting `adversary_verdicts`. `insertVerdict`
  satisfies it: the new row is inserted first (bigserial, so its id is greater) for the same decision
  and symbol, then the old row is pointed at it in the same client session;
  `adversary_leases` and `adversary_marks` carry no trigger that refuses this phase's statements;
  `strategy_candidates.weight` is NULL for bracket rows.
- Phase 2 (at run time only, not at build/test time): twin rows `<ORIG>-CX` with `twin_of`, so
  `reviewableOriginals` finds work in production. Tests seed their own twin rows.

**Leaves alone (owned by others):** `src/http/*`, `src/mcp/*`, `src/chat/status.ts` (phase 5);
`web/` (phase 6); `src/connectors/guard.ts` and `src/connectors/pg.ts` (read only: `pg.ts`'s
exported `CONNECTOR_PG_TYPES` is imported, nothing in it changes); `README.md` (phase 7, keys listed
in Handoffs); `src/adversary/read.ts`, `src/adversary/scorecard.ts` (phase 5); every Seer file.

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts` | modify | `AdversaryConfig`, `DEFAULT_ADVERSARY_CONFIG`, `parseAdversary`, `Config.adversary`, `loadConfig` |
| `src/db/schema.ts` | modify | `adversaryReviews` table + types; header note for migration 0011 |
| `drizzle/0011_adversary_reviews.sql`, `drizzle/meta/0011_snapshot.json`, `drizzle/meta/_journal.json` | generate | `npm run db:generate` output |
| `src/adversary/types.ts` | create | shared types |
| `src/adversary/sessions.ts` | create | session open time (C3 mirror), WIB day |
| `src/adversary/events.ts` | create | in-process bus |
| `src/adversary/toggle.ts` | create | `adversary.auto` setting |
| `src/adversary/plan.ts` | create | discovery shaping + budget/priority planner (pure) |
| `src/adversary/lens.ts` | create | method brief from roster row + lab + override file |
| `src/adversary/prompt.ts` | create | system prompts, user prompts, `prompt_version` hash |
| `src/adversary/seerReader.ts` | create | read-only Seer queries |
| `src/adversary/seerWriter.ts` | create | writable client, allow-list, lease/verdict/mark SQL |
| `src/adversary/tools.ts` | create | in-process SDK MCP data tools + `fetch_url` ledger |
| `src/adversary/agent.ts` | create | two-stage gather/verdict reviewer |
| `src/adversary/reviewsRepo.ts` | create | `adversary_reviews` writer/reader |
| `src/adversary/service.ts` | create | `AdversaryService` + factory |
| `claude/adversary/briefs/STRATEGY_A.md`, `RESIDMOM35.md`, `COSKEW.md` | create | owner briefs from brief §4.2 |
| `src/deps.ts` | modify (line 20) | `adversary: AdversaryService \| null` |
| `src/daemon.ts` | modify (lines 1-20, 88) | build the service, put it on deps |
| `src/background.ts` | modify (lines 100-134) | start / close the job |
| `tests/integration/setup.ts` | modify (line 50) | truncate `adversary_reviews` |
| `tests/live/chat.live.test.ts` | modify (line 55) | pin `NOTESD_ADVERSARY: 'off'` |
| 10 test files with `Config`/`AppDeps` literals (Step 13 list) | modify | `adversary: DEFAULT_ADVERSARY_CONFIG` / `adversary: null` |
| `tests/unit/config.test.ts` | modify | adversary config tests |
| `tests/unit/adversary/*.test.ts` (7 files) | create | unit tests |
| `tests/helpers/fakeReviewer.ts` | create | scripted `StockReviewer` |
| `tests/integration/adversary/harness.ts`, `reviewer.int.test.ts` | create | integration tests on the rebuilt Seer schema |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | pin `NOTESD_ADVERSARY=off`; `up --adversary`; `exec` |
| `.claude/skills/verify-notesd/SKILL.md` | modify | document `--adversary` and `exec` |
| `.claude/skills/verify-notesd/features/adversary.md` | create | reviewer section |
| `.claude/skills/verify-notesd/features/README.md` | modify | row for adversary.md |

## Implementation Steps

### Step 0: Worktree prerequisites
**File:** none (shell)
**Change:** the worktree has no `node_modules`. Run `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && npm ci`.
Confirm phase 1 landed in the Seer worktree: `ls /home/miftah/.worktrees/seer/seer-adversarial/db/migrations/027_*.sql`
must print one file. If it does not, stop: this phase's integration tests skip without it and the
Proof cannot run.
**Impact:** none on the tree.

### Step 1: Adversary config
**File:** `src/config.ts:95` (after `DEFAULT_SESSIONS_CONFIG`), `:111` (`Config`), `:254` (after `parseSwitch`), `:270-301` (`loadConfig` doc + body)
**Change:** add the sub-object, its defaults and parser; wire into `Config` and `loadConfig`.
Default is ON in `loadConfig` (like `NOTESD_SESSIONS`) so both machines join after a pull and a
restart, and OFF in `DEFAULT_ADVERSARY_CONFIG` so no hand-built test config ever reviews.
**Code:** insert after the closing `}` of `DEFAULT_SESSIONS_CONFIG` (line 95):
```ts
export const DEFAULT_ADVERSARY_DAILY_CAP = 15
export const DEFAULT_ADVERSARY_GATHER_MODEL = 'sonnet'
export const DEFAULT_ADVERSARY_VERDICT_MODEL = 'opus'
export const DEFAULT_ADVERSARY_GATHER_MAX_TURNS = 20
export const DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS = 420_000
export const DEFAULT_ADVERSARY_POLL_MS = 600_000

/** Seer Adversarial reviewer (src/adversary/*). */
export interface AdversaryConfig {
  /** `NOTESD_ADVERSARY`, default on. `off` starts no reviewer (deps.adversary is null). */
  enabled: boolean
  /** `ADVERSARY_DAILY_CAP`, default 15. Deep reviews per WIB day, both machines together. */
  dailyCap: number
  /** `ADVERSARY_GATHER_MODEL`, default `sonnet`. Agent SDK alias or model id for the gathering stage. */
  gatherModel: string
  /** `ADVERSARY_VERDICT_MODEL`, default `opus`. Agent SDK alias or model id for the verdict. */
  verdictModel: string
  /** `ADVERSARY_GATHER_MAX_TURNS`, default 20. Turn cap of the gathering stage per stock. */
  gatherMaxTurns: number
  /** `ADVERSARY_STOCK_TIMEOUT_MS`, default 420000. Wall clock per stock, both stages. */
  stockTimeoutMs: number
  /** `ADVERSARY_POLL_MS`, default 600000. Pause between automatic passes. */
  pollMs: number
}

/** Reviewer off, default limits. Tests build `Config` literals with it, so no hand-built config ever reviews. */
export const DEFAULT_ADVERSARY_CONFIG: AdversaryConfig = {
  enabled: false,
  dailyCap: DEFAULT_ADVERSARY_DAILY_CAP,
  gatherModel: DEFAULT_ADVERSARY_GATHER_MODEL,
  verdictModel: DEFAULT_ADVERSARY_VERDICT_MODEL,
  gatherMaxTurns: DEFAULT_ADVERSARY_GATHER_MAX_TURNS,
  stockTimeoutMs: DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS,
  pollMs: DEFAULT_ADVERSARY_POLL_MS,
}
```
In `interface Config`, after `sessions: SessionsConfig` (line 111):
```ts
  /** Seer Adversarial reviewer. `enabled: false` starts nothing (DEFAULT_ADVERSARY_CONFIG in tests). */
  adversary: AdversaryConfig
```
After `parseSwitch` (ends line 254), add:
```ts
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/

function parseModel(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  if (!MODEL_NAME.test(value)) throw new ConfigError(`${name} must be a model alias or id such as "opus", got "${raw}"`)
  return value
}

export function parseAdversary(env: Record<string, string | undefined>): AdversaryConfig {
  return {
    enabled: parseSwitch('NOTESD_ADVERSARY', env.NOTESD_ADVERSARY),
    dailyCap: parsePositiveInt('ADVERSARY_DAILY_CAP', env.ADVERSARY_DAILY_CAP, DEFAULT_ADVERSARY_DAILY_CAP),
    gatherModel: parseModel('ADVERSARY_GATHER_MODEL', env.ADVERSARY_GATHER_MODEL, DEFAULT_ADVERSARY_GATHER_MODEL),
    verdictModel: parseModel('ADVERSARY_VERDICT_MODEL', env.ADVERSARY_VERDICT_MODEL, DEFAULT_ADVERSARY_VERDICT_MODEL),
    gatherMaxTurns: parsePositiveInt('ADVERSARY_GATHER_MAX_TURNS', env.ADVERSARY_GATHER_MAX_TURNS, DEFAULT_ADVERSARY_GATHER_MAX_TURNS),
    stockTimeoutMs: parsePositiveInt('ADVERSARY_STOCK_TIMEOUT_MS', env.ADVERSARY_STOCK_TIMEOUT_MS, DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS),
    pollMs: parsePositiveInt('ADVERSARY_POLL_MS', env.ADVERSARY_POLL_MS, DEFAULT_ADVERSARY_POLL_MS),
  }
}
```
In the `loadConfig` doc comment, replace the line ` * NOTESD_SWARM_SCRIPT. Other keys are ignored.` with:
```ts
 * NOTESD_SWARM_SCRIPT. Adversary keys: NOTESD_ADVERSARY, ADVERSARY_DAILY_CAP,
 * ADVERSARY_GATHER_MODEL, ADVERSARY_VERDICT_MODEL, ADVERSARY_GATHER_MAX_TURNS,
 * ADVERSARY_STOCK_TIMEOUT_MS, ADVERSARY_POLL_MS. Other keys are ignored.
```
and in the returned object, after `sessions: parseSessions(env),` (line 299):
```ts
    adversary: parseAdversary(env),
```
**Impact:** every hand-built `Config` literal stops compiling until Step 13 adds the field (same step
lands it; typecheck runs after Step 13).

### Step 2: `adversary_reviews` table and migration
**File:** `src/db/schema.ts:1-19` (imports), `:20-40` (header comment), after `appSettings` (line 711), types after line 713
**Change:** add `date` and `doublePrecision` to the `drizzle-orm/pg-core` import list (alphabetical:
`date,` after `customType,`; `doublePrecision,` after `date,`). In the header comment, before the line
` * Change a table here, then \`npm run db:generate\`; ...`, add:
```ts
 * Migration 0011 (Seer Adversarial) adds `adversary_reviews`: one row per review attempt of the
 * reviewer (src/adversary/reviewsRepo.ts is its only writer), which is also the usage log and the
 * store of early "draft" verdicts that are never written to Seer.
```
After the `appSettings` table (line 711) add:
```ts
/** One source a Seer Adversarial verdict cites: a page the reviewer opened with its fetch_url tool. */
export interface AdversarySource {
  url: string
  title: string | null
  publisher: string | null
  /** ISO 8601 when the page said when it was published, else null. */
  published_at: string | null
  /** ISO 8601, when the reviewer fetched it (before the session opened). */
  fetched_at: string
}

/** `adversary_reviews.verdict`: what one review concluded. */
export interface AdversaryStoredVerdict {
  verdict: 'agree' | 'object' | 'unsure'
  /** Plain words, 1..600 characters. */
  reason: string
  sources: AdversarySource[]
  /** The method brief's id@version, `<object_name>@<8 hex>`. */
  lens: string
  /** adversary_verdicts.id in Seer's DB once written; null for a draft (and a failed write). */
  seer_verdict_id: number | null
  /** True when an agree/object that cited no fetched page was turned into unsure. */
  downgraded: boolean
}

/**
 * One row per Seer Adversarial review attempt (migration 0011), from either machine. stage
 * 'draft' is an early look at a book's next rebalance (from Seer's book_previews), kept here only;
 * stage 'final' is a review of a real decision, written to Seer's adversary_verdicts when it
 * succeeds. status 'late' means the Seer verdict was decided after the session opened (the engine
 * ignores it); 'skipped_budget' means the daily cap was reached. Deep reviews counted against the
 * cap: status ok/failed/late with reused_from null. Written only through src/adversary/reviewsRepo.ts.
 */
export const adversaryReviews = pgTable(
  'adversary_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    strategyId: text('strategy_id').notNull(),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    symbol: text('symbol').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    verdict: jsonb('verdict').$type<AdversaryStoredVerdict>(),
    promptVersion: text('prompt_version').notNull(),
    gatherModel: text('gather_model'),
    verdictModel: text('verdict_model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    turns: integer('turns').notNull().default(0),
    error: text('error'),
    host: text('host').notNull(),
    /** The draft row whose verdict this final row reused (no tokens spent). */
    reusedFrom: bigint('reused_from', { mode: 'number' }).references((): AnyPgColumn => adversaryReviews.id),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('adversary_reviews_stage_check', sql`${t.stage} in ('draft', 'final')`),
    check('adversary_reviews_status_check', sql`${t.status} in ('ok', 'failed', 'skipped_budget', 'late')`),
    index('adversary_reviews_started_idx').on(t.startedAt),
    index('adversary_reviews_key_idx').on(t.strategyId, t.sessionDate, t.symbol, t.startedAt),
  ],
)
```
After `export type NoteRow = ...` block (line 713 onwards), append:
```ts
export type AdversaryReviewRow = typeof adversaryReviews.$inferSelect
export type NewAdversaryReviewRow = typeof adversaryReviews.$inferInsert
```
Then generate the migration (drizzle.config.ts needs a direct URL; generate does not connect):
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name adversary_reviews
```
Expected `drizzle/0011_adversary_reviews.sql` (commit exactly what drizzle-kit writes; it should be this):
```sql
CREATE TABLE "adversary_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"session_date" date NOT NULL,
	"symbol" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"verdict" jsonb,
	"prompt_version" text NOT NULL,
	"gather_model" text,
	"verdict_model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"error" text,
	"host" text NOT NULL,
	"reused_from" bigint,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "adversary_reviews_stage_check" CHECK ("adversary_reviews"."stage" in ('draft', 'final')),
	CONSTRAINT "adversary_reviews_status_check" CHECK ("adversary_reviews"."status" in ('ok', 'failed', 'skipped_budget', 'late'))
);
--> statement-breakpoint
ALTER TABLE "adversary_reviews" ADD CONSTRAINT "adversary_reviews_reused_from_adversary_reviews_id_fk" FOREIGN KEY ("reused_from") REFERENCES "public"."adversary_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adversary_reviews_started_idx" ON "adversary_reviews" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "adversary_reviews_key_idx" ON "adversary_reviews" USING btree ("strategy_id","session_date","symbol","started_at");
```
If drizzle-kit names the file differently, rename it and its journal `tag` to `0011_adversary_reviews`.
**Impact:** additive. `tests/integration/setup.ts` truncate list must include the table (Step 14).

### Step 3: Shared types
**File:** `src/adversary/types.ts` (new)
**Code:**
```ts
import type { AdversarySource } from '../db/schema.js';

/**
 * Types shared by the Seer Adversarial reviewer. A "decision" is one original strategy's choice for
 * one US session (Seer contract C1: strategy_candidates keyed by strategy_id + session_date); a
 * "pick" is one stock in it. Ids always name the ORIGINAL strategy, never its `-CX` twin.
 */

export type DecisionKind = 'bracket' | 'book';
/** 'draft' = an early look at a book's next rebalance (book_previews); 'final' = a real decision. */
export type ReviewStage = 'draft' | 'final';
export type Verdict = 'agree' | 'object' | 'unsure';
export const VERDICTS: readonly Verdict[] = ['agree', 'object', 'unsure'];

/** One row of Seer's `strategies`, as the reviewer reads it. */
export interface RosterRow {
  id: string;
  name: string;
  sub: string;
  /** 'bracket' | 'book' | 'benchmark' | null */
  engine: string | null;
  rulesId: string | null;
  /** paper.roster.RESOLVER key, e.g. STRATEGY_A; names the override brief file. */
  objectName: string | null;
  gateNote: string | null;
  /** lab.sqlite methods.id this row came from. */
  promotedFrom: string | null;
  /** 'active' | 'retired' */
  status: string;
  twinOf: string | null;
  isBenchmark: boolean;
}

export interface CandidateRow {
  strategyId: string;
  sessionDate: string;
  dataDate: string;
  kind: DecisionKind;
  rank: number;
  symbol: string;
  weight: number | null;
  evidence: unknown;
}

export interface PreviewRow {
  strategyId: string;
  dataDate: string;
  rank: number;
  symbol: string;
  weight: number;
  nextDecisionSession: string;
}

/** A non-superseded Seer verdict. */
export interface VerdictRef {
  id: number;
  strategyId: string;
  sessionDate: string;
  symbol: string;
  verdict: Verdict;
  /** ISO 8601 UTC. */
  decidedAt: string;
}

export interface MarkRef {
  strategyId: string;
  sessionDate: string;
}

/** One daily bar, newest first in every list. Raw (not split-adjusted) closes. */
export interface Bar {
  date: string;
  close: number;
  volume: number;
}

export interface LabMethod {
  id: string;
  name: string;
  family: string;
  hypothesis: string;
}

export interface Pick {
  symbol: string;
  rank: number;
  /** Book target weight (fraction); null for bracket candidates. */
  weight: number | null;
  evidence: unknown;
}

export interface Decision {
  strategyId: string;
  sessionDate: string;
  /** The night whose prices decided it (prev_session(sessionDate)); the data tools never read past it. */
  dataDate: string;
  kind: DecisionKind;
  stage: ReviewStage;
  /** 09:30 New York on sessionDate. A verdict counts only if decided before this. */
  openUtc: Date;
  /** Sorted by rank. */
  picks: Pick[];
}

export type Source = AdversarySource;

export interface ReviewVerdict {
  verdict: Verdict;
  reason: string;
  sources: Source[];
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** Exact model id when the SDK reported one, else the configured alias. */
  gatherModel: string;
  verdictModel: string;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  usage: ReviewUsage;
  /** True when an agree/object without a fetched source became unsure. */
  downgraded: boolean;
}

/** The method brief: what Claude judges a pick through. */
export interface Lens {
  /** `<object_name or id>@<8 hex of text>`, stored as adversary_verdicts.lens. */
  id: string;
  text: string;
}

export interface ReviewContext {
  strategy: RosterRow;
  lens: Lens;
  promptVersion: string;
  decision: Decision;
  pick: Pick;
  /** Book only: whether the original holds the stock now; null for bracket decisions. */
  held: boolean | null;
  now: Date;
}

/** A review that produced no verdict. `usage` is what it spent before failing, when known. */
export class ReviewFailure extends Error {
  override name = 'ReviewFailure';
  constructor(
    message: string,
    readonly usage: ReviewUsage | null,
  ) {
    super(message);
  }
}

/** The seam between the job and a model. Production: createAgentReviewer; tests: tests/helpers/fakeReviewer.ts. Rejects with ReviewFailure. */
export interface StockReviewer {
  /** Configured aliases; they feed prompt_version. */
  readonly gatherModel: string;
  readonly verdictModel: string;
  review(ctx: ReviewContext, signal: AbortSignal): Promise<ReviewOutcome>;
}
```
**Impact:** none (new).

### Step 4: Session open time (C3 mirror)
**File:** `src/adversary/sessions.ts` (new)
**Code:**
```ts
/**
 * Session clock for Seer Adversarial. sessionOpenUtc mirrors seer_engine.dates.session_open_utc
 * (contract C3): a verdict counts only if decided before 09:30 America/New_York on its session
 * date, as UTC. Pinned examples, the same on both sides: 2026-11-04 -> 2026-11-04T14:30:00Z
 * (US winter), 2026-07-01 -> 2026-07-01T13:30:00Z (US summer). Holidays do not matter: Seer only
 * writes candidates for real sessions. The daily cap runs on WIB days (UTC+7, no DST).
 */

const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const WIB_OFFSET_MS = 7 * 3_600_000;

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function newYorkParts(at: Date): { date: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of NEW_YORK.formatToParts(at)) parts[part.type] = part.value;
  return {
    date: `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Throws TypeError unless `value` is a real calendar date written YYYY-MM-DD. */
export function assertSessionDate(value: string): void {
  if (!SESSION_DATE.test(value)) throw new TypeError(`not a session date (YYYY-MM-DD): ${value}`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`not a calendar date: ${value}`);
  }
}

/** 09:30 New York time on `sessionDate`, as a UTC instant (13:30Z in US summer, 14:30Z in winter). */
export function sessionOpenUtc(sessionDate: string): Date {
  assertSessionDate(sessionDate);
  const [y, m, d] = sessionDate.split('-').map(Number) as [number, number, number];
  for (const hourUtc of [13, 14]) {
    const at = new Date(Date.UTC(y, m - 1, d, hourUtc, 30));
    const ny = newYorkParts(at);
    if (ny.date === sessionDate && ny.hour === 9 && ny.minute === 30) return at;
  }
  throw new Error(`09:30 in New York has no UTC instant on ${sessionDate}`);
}

/** The UTC calendar date of `at`, YYYY-MM-DD. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `date` plus `days` calendar days (negative goes back). */
export function addDays(date: string, days: number): string {
  assertSessionDate(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The WIB (Asia/Jakarta, UTC+7) calendar date of `at`. */
export function wibDay(at: Date): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 WIB of the WIB day containing `at`, as a UTC instant. */
export function wibDayStartUtc(at: Date): Date {
  return new Date(Date.parse(`${wibDay(at)}T00:00:00Z`) - WIB_OFFSET_MS);
}
```
**Impact:** none (new).

### Step 5: Events bus and toggle
**File:** `src/adversary/events.ts` (new)
**Code:**
```ts
import { EventEmitter } from 'node:events';

export type AdversaryOp = 'verdict' | 'mark' | 'toggle' | 'run';

/** One reviewer change (contract C4). Phase 5 writes it on GET /api/events as `event: adversary`. */
export interface AdversaryChange {
  type: 'adversary';
  op: AdversaryOp;
  strategy_id?: string;
  session_date?: string;
}

export type AdversaryChangeListener = (change: AdversaryChange) => void;

/** In-process bus for reviewer writes. AdversaryService is the only emitter, always after the write committed. */
export class AdversaryEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(change: { op: AdversaryOp; strategy_id?: string; session_date?: string }): void {
    const event: AdversaryChange = { type: 'adversary', ...change };
    this.emitter.emit('adversary', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: AdversaryChangeListener): () => void {
    this.emitter.on('adversary', listener);
    return () => {
      this.emitter.off('adversary', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('adversary');
  }
}
```
**File:** `src/adversary/toggle.ts` (new)
**Code:**
```ts
/**
 * The ON/OFF switch for automatic reviews (contract C4, decision D9). It lives in the shared
 * mcp-notes `app_settings` table, so both machines obey it, written only through SessionsRepo.
 * Absent (or unreadable) means ON. "Review now" ignores it.
 */
export const ADVERSARY_TOGGLE_KEY = 'adversary.auto';

export interface ToggleState {
  on: boolean;
  /** ISO 8601 of the last change, null when never set. */
  changed_at: string | null;
  /** Host that made the last change, null when never set. */
  host: string | null;
}

export const TOGGLE_DEFAULT: ToggleState = { on: true, changed_at: null, host: null };

/** The slice of SessionsRepo the toggle uses. */
export interface SettingsStore {
  getSetting(key: string): Promise<unknown | null>;
  putSetting(key: string, value: unknown): Promise<void>;
}

export function parseToggle(value: unknown): ToggleState {
  if (typeof value !== 'object' || value === null) return TOGGLE_DEFAULT;
  const v = value as Record<string, unknown>;
  if (typeof v.on !== 'boolean') return TOGGLE_DEFAULT;
  return {
    on: v.on,
    changed_at: typeof v.changed_at === 'string' ? v.changed_at : null,
    host: typeof v.host === 'string' ? v.host : null,
  };
}

export async function readToggle(store: SettingsStore): Promise<ToggleState> {
  return parseToggle(await store.getSetting(ADVERSARY_TOGGLE_KEY));
}

export async function writeToggle(store: SettingsStore, on: boolean, host: string, now: Date): Promise<ToggleState> {
  if (host.trim() === '') throw new TypeError('toggle host must be non-empty');
  const state: ToggleState = { on, changed_at: now.toISOString(), host };
  await store.putSetting(ADVERSARY_TOGGLE_KEY, state);
  return state;
}
```
**Impact:** none (new).

### Step 6: Discovery shaping and the budget planner
**File:** `src/adversary/plan.ts` (new)
**Change:** pure functions: which originals are reviewable (read from the roster, never hard-coded,
invariant 5), how candidate/preview rows become decisions, and in which order picks are reviewed
under the daily cap (D10: bracket decisions first, then book decisions by earliest open, previews
last; over cap = absent with a `skipped_budget` row; drafts reused instead of a new deep review).
**Code:**
```ts
import type { AdversaryStoredVerdict } from '../db/schema.js';
import { sessionOpenUtc } from './sessions.js';
import type { CandidateRow, Decision, Pick, PreviewRow, ReviewStage, RosterRow } from './types.js';

/** Previews are drafted only for a rebalance this close, and a draft is reused only if this recent. */
export const DRAFT_WINDOW_MS = 7 * 86_400_000;
/** A (decision, symbol, stage) that failed this often in the draft window is not retried automatically. */
export const MAX_FAILED_ATTEMPTS = 2;

export function decisionKey(strategyId: string, sessionDate: string): string {
  return `${strategyId}|${sessionDate}`;
}

export function attemptKey(strategyId: string, sessionDate: string, symbol: string, stage: ReviewStage): string {
  return `${strategyId}|${sessionDate}|${symbol}|${stage}`;
}

export function draftKey(strategyId: string, sessionDate: string, symbol: string, promptVersion: string): string {
  return `${strategyId}|${sessionDate}|${symbol}|${promptVersion}`;
}

/**
 * Active originals that have an active twin (contract C2), are not benchmarks and trade as a
 * bracket or a book. C has no twin, so it never shows up here.
 */
export function reviewableOriginals(roster: readonly RosterRow[]): RosterRow[] {
  const twinned = new Set<string>();
  for (const row of roster) if (row.twinOf !== null && row.status === 'active') twinned.add(row.twinOf);
  return roster.filter(
    (row) =>
      row.status === 'active' &&
      row.twinOf === null &&
      !row.isBenchmark &&
      (row.engine === 'bracket' || row.engine === 'book') &&
      twinned.has(row.id),
  );
}

function byRank(a: Pick, b: Pick): number {
  return a.rank - b.rank || a.symbol.localeCompare(b.symbol);
}

/** strategy_candidates rows -> final decisions whose session has not opened yet. */
export function toDecisions(rows: readonly CandidateRow[], now: Date): Decision[] {
  const groups = new Map<string, Decision>();
  for (const row of rows) {
    const key = decisionKey(row.strategyId, row.sessionDate);
    let decision = groups.get(key);
    if (decision === undefined) {
      decision = {
        strategyId: row.strategyId,
        sessionDate: row.sessionDate,
        dataDate: row.dataDate,
        kind: row.kind,
        stage: 'final',
        openUtc: sessionOpenUtc(row.sessionDate),
        picks: [],
      };
      groups.set(key, decision);
    }
    decision.picks.push({ symbol: row.symbol, rank: row.rank, weight: row.weight, evidence: row.evidence });
  }
  const out: Decision[] = [];
  for (const decision of groups.values()) {
    if (decision.openUtc.getTime() <= now.getTime()) continue;
    decision.picks.sort(byRank);
    out.push(decision);
  }
  return out;
}

/**
 * book_previews rows -> draft decisions for the book's next rank session, when that session's real
 * targets are not written yet (`decided` holds decisionKey of every candidate row read) and it opens
 * within DRAFT_WINDOW_MS.
 */
export function toPreviewDecisions(rows: readonly PreviewRow[], decided: ReadonlySet<string>, now: Date): Decision[] {
  const groups = new Map<string, Decision>();
  for (const row of rows) {
    const key = decisionKey(row.strategyId, row.nextDecisionSession);
    if (decided.has(key)) continue;
    let decision = groups.get(key);
    if (decision === undefined) {
      decision = {
        strategyId: row.strategyId,
        sessionDate: row.nextDecisionSession,
        dataDate: row.dataDate,
        kind: 'book',
        stage: 'draft',
        openUtc: sessionOpenUtc(row.nextDecisionSession),
        picks: [],
      };
      groups.set(key, decision);
    }
    decision.picks.push({ symbol: row.symbol, rank: row.rank, weight: row.weight, evidence: null });
  }
  const out: Decision[] = [];
  for (const decision of groups.values()) {
    const ahead = decision.openUtc.getTime() - now.getTime();
    if (ahead <= 0 || ahead > DRAFT_WINDOW_MS) continue;
    decision.picks.sort(byRank);
    out.push(decision);
  }
  return out;
}

/** A recent draft review whose verdict a final review may reuse. */
export interface DraftRef {
  id: number;
  startedAt: Date;
  verdict: AdversaryStoredVerdict;
  gatherModel: string | null;
  verdictModel: string | null;
}

/** What one pass will do, in order. Actions of one decision are contiguous. */
export type PlannedAction =
  | { type: 'review'; decision: Decision; pick: Pick; supersedes: number | null }
  | { type: 'reuse'; decision: Decision; pick: Pick; draft: DraftRef; supersedes: number | null }
  | { type: 'skip_budget'; decision: Decision; pick: Pick };

export interface PlanInput {
  decisions: readonly Decision[];
  previews: readonly Decision[];
  /** prompt_version per original; a strategy missing here is not reviewed this pass. */
  promptVersions: ReadonlyMap<string, string>;
  /** decisionKey -> symbol -> id of the non-superseded Seer verdict. */
  verdicts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** draftKey -> latest ok draft within DRAFT_WINDOW_MS. */
  drafts: ReadonlyMap<string, DraftRef>;
  /** attemptKey -> failed attempts within DRAFT_WINDOW_MS. */
  failures: ReadonlyMap<string, number>;
  /** attemptKey of skipped_budget rows already written today (WIB). */
  skippedToday: ReadonlySet<string>;
  /** Deep reviews already spent today (WIB), both machines. */
  used: number;
  cap: number;
  /** Review symbols that already have a verdict again, superseding it (manual review only). */
  rereview: boolean;
  only?: { strategyId?: string; sessionDate?: string };
}

/** 0 bracket, 1 book, 2 preview (D10). */
function priority(decision: Decision): number {
  if (decision.stage === 'draft') return 2;
  return decision.kind === 'bracket' ? 0 : 1;
}

export function orderDecisions(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      a.openUtc.getTime() - b.openUtc.getTime() ||
      a.strategyId.localeCompare(b.strategyId),
  );
}

export function planWork(input: PlanInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  let budget = Math.max(0, input.cap - input.used);
  const { only } = input;
  const wanted = (d: Decision): boolean =>
    (only?.strategyId === undefined || d.strategyId === only.strategyId) &&
    (only?.sessionDate === undefined || d.sessionDate === only.sessionDate);

  for (const decision of orderDecisions([...input.decisions, ...input.previews])) {
    if (!wanted(decision)) continue;
    const promptVersion = input.promptVersions.get(decision.strategyId);
    if (promptVersion === undefined) continue;
    const reviewed = input.verdicts.get(decisionKey(decision.strategyId, decision.sessionDate));
    for (const pick of decision.picks) {
      const attempt = attemptKey(decision.strategyId, decision.sessionDate, pick.symbol, decision.stage);
      if (!input.rereview && (input.failures.get(attempt) ?? 0) >= MAX_FAILED_ATTEMPTS) continue;
      const draft = input.drafts.get(draftKey(decision.strategyId, decision.sessionDate, pick.symbol, promptVersion));

      if (decision.stage === 'draft') {
        // An early look is optional: only with leftover budget, never logged as skipped.
        if (draft !== undefined) continue;
        if (budget > 0) {
          budget -= 1;
          actions.push({ type: 'review', decision, pick, supersedes: null });
        }
        continue;
      }

      const existing = reviewed?.get(pick.symbol);
      if (existing !== undefined && !input.rereview) continue;
      const supersedes = existing ?? null;
      if (draft !== undefined && !input.rereview) {
        actions.push({ type: 'reuse', decision, pick, draft, supersedes });
        continue;
      }
      if (budget > 0) {
        budget -= 1;
        actions.push({ type: 'review', decision, pick, supersedes });
        continue;
      }
      if (!input.skippedToday.has(attempt)) actions.push({ type: 'skip_budget', decision, pick });
    }
  }
  return actions;
}
```
**Impact:** none (new).

### Step 7: The lens and the prompts
**File:** `src/adversary/lens.ts` (new)
**Code:**
```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { LabMethod, Lens, RosterRow } from './types.js';

/**
 * The method brief ("lens") Claude judges a pick through, built from data so a new roster method
 * gets a usable lens with no code change (brief §4.2): the roster row (name, sub, engine, rules,
 * gate note), the lab method's hypothesis (promoted_from -> lab.sqlite methods), and an optional
 * hand-written brief `claude/adversary/briefs/<object_name>.md`. Its hash is part of
 * prompt_version, so any change becomes a new dated revision.
 */
export const BRIEFS_DIR = path.join(REPO_ROOT, 'claude', 'adversary', 'briefs');

const BRIEF_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SUB = 400;
const MAX_GATE_NOTE = 900;
const MAX_HYPOTHESIS = 1_200;
const MAX_BRIEF = 4_000;

const HOW_IT_TRADES: Record<string, string> = {
  bracket:
    'A short trade. Each night it ranks the stocks that qualify; the top ones take its free slots, each bought at a limit price below the last close and sold within a few sessions on a target, a stop or a time limit.',
  book:
    'A basket held until the next rebalance. At each rebalance it re-picks every name and sets target weights. Objecting to a name it already holds means selling it, and the fees count against the objection.',
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/** The override brief for `objectName`, or null when there is none. Names outside [A-Za-z0-9_-] are never read. */
export async function readBrief(objectName: string | null, dir: string = BRIEFS_DIR): Promise<string | null> {
  if (objectName === null || !BRIEF_NAME.test(objectName)) return null;
  try {
    const text = (await readFile(path.join(dir, `${objectName}.md`), 'utf8')).trim();
    return text === '' ? null : clip(text, MAX_BRIEF);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function lensText(row: RosterRow, lab: LabMethod | null, brief: string | null): string {
  const lines: string[] = [`Method: ${row.name} (${row.id})`, `What it does, in the owner's words: ${clip(row.sub, MAX_SUB)}`];
  const how = row.engine === null ? undefined : HOW_IT_TRADES[row.engine];
  if (how !== undefined) lines.push(`How it trades: ${how}`);
  if (row.rulesId !== null) lines.push(`Rule set: ${row.rulesId}`);
  if (row.gateNote !== null && row.gateNote.trim() !== '') lines.push(`What its record says: ${clip(row.gateNote, MAX_GATE_NOTE)}`);
  if (lab !== null && lab.hypothesis.trim() !== '') {
    lines.push(`The lab's idea behind it (${lab.id}, ${lab.name}): ${clip(lab.hypothesis, MAX_HYPOTHESIS)}`);
  }
  if (brief !== null) lines.push('', "The owner's brief for this method:", brief);
  return lines.join('\n');
}

export function buildLens(row: RosterRow, lab: LabMethod | null, brief: string | null): Lens {
  const text = lensText(row, lab, brief);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
  return { id: `${row.objectName ?? row.id}@${hash}`, text };
}
```
**File:** `src/adversary/prompt.ts` (new)
**Code:**
```ts
import { createHash } from 'node:crypto';
import type { Lens, ReviewContext, Source } from './types.js';

/** Bump when a prompt below changes shape; the hash in prompt_version moves anyway. */
export const PROMPT_REVISION = 'adv-v1';
/** Seer's adversary_verdicts.reason CHECK (char_length 1..600). */
export const REASON_MAX_CHARS = 600;
const MAX_EVIDENCE_CHARS = 1_500;
const MAX_BASKET_NAMES = 40;

export const GATHER_SYSTEM = [
  'You gather facts for a review of one stock that a trading method wants to buy or keep. Another model decides later from your notes; you do not decide.',
  "Work only through the method's lens given in the message.",
  "Start with seer_price_context (the method's own prices, no network). Then look for news, scheduled events and filings with the finnhub_*, massive_news and sec_filings tools when they are offered, and with WebSearch for coverage they miss.",
  'A page counts only once you open it with fetch_url: only pages opened with fetch_url can be cited, so open every page you mean to rely on, and never rely on a search snippet alone.',
  "Use only what was published before now, and nothing about how the stock traded after the method's decision night.",
  'Open at most about 8 pages, then stop.',
  "Answer with a dossier in plain sentences: each fact followed by the URL of the fetch_url page it came from, then a last line naming anything scheduled before the method's horizon ends, or 'nothing scheduled found'.",
].join(' ');

export const VERDICT_SYSTEM = [
  "You are the adversary of a trading method: before its pick is bought or kept, you decide whether the owner should let it through.",
  "Answer agree when the method's own reason for the pick stands, object when something the method cannot see makes this pick a mistake under its own lens, and unsure when the evidence is thin, mixed or could not be checked; unsure keeps the pick.",
  "Judge only through the method's lens and the dossier; do not invent facts.",
  'Every agree or object must cite at least one URL from the numbered list of pages that were actually opened, copied exactly. Cite nothing outside that list. If no page on the list supports your call, answer unsure.',
  `Write the reason for an owner who is not a trader: at most ${REASON_MAX_CHARS} characters, plain everyday words, name the company rather than its ticker symbol, and no trading jargon: never write RSI, oversold, overbought, momentum, mean reversion, alpha, beta or support level.`,
  'Answer only through the structured output.',
].join(' ');

/** `adv-v1-<12 hex>` over the revision, both system prompts, both models and the lens. */
export function promptVersion(lens: Lens, gatherModel: string, verdictModel: string): string {
  const hash = createHash('sha256')
    .update([PROMPT_REVISION, GATHER_SYSTEM, VERDICT_SYSTEM, gatherModel, verdictModel, lens.text].join('\n\u0000\n'), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${PROMPT_REVISION}-${hash}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function percent(weight: number): string {
  return `${(weight * 100).toFixed(1)}%`;
}

/** The facts of one pick, shared by both stages. */
export function decisionFacts(ctx: ReviewContext): string {
  const { decision, pick } = ctx;
  const others = decision.picks
    .filter((p) => p.symbol !== pick.symbol)
    .slice(0, MAX_BASKET_NAMES)
    .map((p) => p.symbol);
  const lines: string[] = [`Stock under review: ${pick.symbol}`, `Method: ${ctx.strategy.name} (${ctx.strategy.id})`];
  lines.push(
    decision.stage === 'draft'
      ? `This is an early look: the method's next rebalance is the US session of ${decision.sessionDate}; its list may still change before then.`
      : `Decision: what the method will do in the US session of ${decision.sessionDate}.`,
  );
  lines.push(`That session opens at ${decision.openUtc.toISOString()}. The method decided on prices up to the close of ${decision.dataDate}.`);
  if (decision.kind === 'bracket') {
    lines.push(`Its place: candidate ${pick.rank} of ${decision.picks.length} in the method's ranking; the top ones take the free slots.`);
  } else {
    const weight = pick.weight === null ? 'weight not given' : `${percent(pick.weight)} of the book`;
    const holding =
      ctx.held === true
        ? 'the book holds it now, so objecting means selling it and paying the fees'
        : ctx.held === false
          ? 'the book does not hold it now, so objecting means not buying it'
          : 'whether the book holds it now is not known';
    lines.push(`Its place: target ${pick.rank} of ${decision.picks.length}, ${weight}; ${holding}.`);
  }
  lines.push(`Other names in this decision: ${others.length === 0 ? 'none' : others.join(', ')}`);
  if (pick.evidence !== null && pick.evidence !== undefined) {
    lines.push(`What the method's rule read: ${clip(JSON.stringify(pick.evidence), MAX_EVIDENCE_CHARS)}`);
  }
  lines.push(`Now: ${ctx.now.toISOString()}. Use only what was published before now.`);
  return lines.join('\n');
}

export function gatherPrompt(ctx: ReviewContext): string {
  return [decisionFacts(ctx), '', "The method's lens:", ctx.lens.text].join('\n');
}

export function verdictPrompt(ctx: ReviewContext, dossier: string, opened: readonly Source[]): string {
  const pages =
    opened.length === 0
      ? ['(none: no page was opened, so the answer must be unsure)']
      : opened.map((s, i) => {
          const meta = [s.publisher, s.published_at === null ? null : `published ${s.published_at}`].filter((x): x is string => x !== null);
          return `${i + 1}. ${s.url} | ${s.title ?? 'untitled'}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`;
        });
  return [
    decisionFacts(ctx),
    '',
    "The method's lens:",
    ctx.lens.text,
    '',
    'Dossier from the gathering stage:',
    dossier,
    '',
    'Pages actually opened (cite only these URLs):',
    ...pages,
  ].join('\n');
}
```
**Impact:** none (new).

### Step 8: The three owner briefs
**File:** `claude/adversary/briefs/STRATEGY_A.md`, `claude/adversary/briefs/RESIDMOM35.md`, `claude/adversary/briefs/COSKEW.md` (new)
**Change:** file names are Seer `strategies.object_name` values, resolved from the Seer roster
source: `A-GT` uses `STRATEGY_A` (phase 1 inserts it with "plain A's object", the same object
`006_roster.sql` gave `A`), `RAW35-FR-GT` uses `RESIDMOM35` (`021_roster_width_35.sql:99`),
`COSK-FR-GT` uses `COSKEW` (`022_roster_coskewness.sql:53`). Twins share the original's object_name
(C2) but are never reviewed (only originals are).
**Code:** `claude/adversary/briefs/STRATEGY_A.md`
```markdown
# A: the five-day dip buy

A buys a stock that is in a long rise but has just had a sharp drop over a few days, betting the
drop is noise and the price comes back within about five sessions. It sells on a small gain, on a
stop below the buy price, or after five sessions, whichever comes first.

Questions to answer:
- Is this drop noise, or news? A fall that follows a lowered forecast, a cut outlook, a failed
  trial, an accounting problem or a lost customer is the market re-pricing the company, not a dip.
  Object to those.
- Is anything scheduled inside the next five sessions (results, a court ruling, a drug decision, a
  shareholder vote, an index change) that could move the price a lot either way? Object when that
  event is the likely reason for the drop; otherwise mention it.
- Fundamentals barely matter over five sessions. Do not object because the company is expensive,
  indebted or unloved.
- Agree when the drop has no specific cause you can find, or when the cause is passing: a market-wide
  fall, a wobble across its industry, a one-day overreaction to news that does not change the business.
```
`claude/adversary/briefs/RESIDMOM35.md`
```markdown
# RAW35: a month of rise beyond the market

RAW35 holds the 35 stocks whose price rose most beyond what the market alone explains over the past
year, re-picked each month. It bets that whatever drove the rise keeps working for at least another
month.

Questions to answer:
- Will what drove the rise last the month? A steady story (orders growing, a product selling,
  margins widening) tends to continue. A one-off jump (a takeover rumour, a short squeeze, a single
  blowout report, a social-media rally) tends to give back. Object to rises that came from a one-off.
- Is a takeover at a fixed price pending? Then the price cannot rise much further and the slot is
  wasted. Object.
- Are results or another big scheduled event due inside the month? Mention it; object only when the
  event is likely to break the story.
- Do not object because the stock has already risen a lot: that is the method's whole point.
```
`claude/adversary/briefs/COSKEW.md`
```markdown
# COSK: crash-prone stocks held for a premium

COSK holds 20 stocks that fall hardest when the market has its wildest weeks, re-picked each
quarter. The bet is that investors pay to avoid such stocks, so holders earn a premium over time
for carrying that risk.

Questions to answer:
- Never object because a stock is risky, jumpy, cyclical or exposed to a crash: that is the thesis,
  and it is why the stock is in the book.
- Object only when the thesis breaks for this company: a pending acquisition (the price is pinned to
  the deal), a bankruptcy filing or a likely one, a delisting, or the stock ceasing to trade as
  itself (a spin-off that empties it, a reverse merger).
- Patterns across the whole book, such as many names from one industry (energy, for example), are
  notes for the owner, not reasons to object to one stock.
- When nothing like the above is found, agree.
```
**Impact:** none on code; `lens.test.ts` asserts the three files load.

### Step 9: Read-only Seer reader
**File:** `src/adversary/seerReader.ts` (new)
**Change:** every read of Seer goes through the existing read-only connector (`createConnector('seer')`:
per-call `.env.local`, direct host, `BEGIN READ ONLY`, statement timeout, row cap, and the lab reader
for `lab.sqlite`). Timestamps come back as ISO UTC text via `to_char`, because the connector session
runs in `Asia/Jakarta` and leaves timestamptz as text.
**Code:**
```ts
import { toObjects } from '../connectors/rows.js';
import type { QueryOptions, QueryResult, ReadOnlySource } from '../connectors/types.js';
import type { Bar, CandidateRow, DecisionKind, LabMethod, MarkRef, PreviewRow, RosterRow, Verdict, VerdictRef } from './types.js';

/** A Seer connector (src/connectors/connector.ts): read-only Postgres plus, optionally, lab.sqlite. */
export interface SeerSource extends ReadOnlySource {
  lab?: ReadOnlySource;
}

const MAX_ROWS = 1_000;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const SCHEMA_READY_SQL = `
SELECT (
  to_regclass('public.adversary_verdicts') IS NOT NULL
  AND to_regclass('public.adversary_marks') IS NOT NULL
  AND to_regclass('public.adversary_leases') IS NOT NULL
  AND to_regclass('public.strategy_candidates') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'strategies' AND column_name = 'twin_of')
  AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'book_previews' AND column_name = 'next_decision_session')
) AS ready`;

const ROSTER_SQL = `
SELECT id, name, sub, engine, rules_id, object_name, gate_note, promoted_from, status, twin_of, is_benchmark
FROM strategies
ORDER BY sort, id`;

const CANDIDATES_SQL = `
SELECT strategy_id, session_date::text AS session_date, data_date::text AS data_date, kind, rank, symbol, weight, evidence
FROM strategy_candidates
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[])
ORDER BY session_date, strategy_id, rank`;

const PREVIEWS_SQL = `
SELECT strategy_id, data_date::text AS data_date, rank, symbol, weight, next_decision_session::text AS next_decision_session
FROM book_previews
WHERE next_decision_session IS NOT NULL AND next_decision_session >= $1::date AND strategy_id = ANY($2::text[])
ORDER BY strategy_id, rank`;

const VERDICTS_SQL = `
SELECT id, strategy_id, session_date::text AS session_date, symbol, verdict,
       to_char(decided_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS decided_at
FROM adversary_verdicts
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[]) AND superseded_by IS NULL
ORDER BY session_date, strategy_id, symbol, decided_at`;

const MARKS_SQL = `
SELECT strategy_id, session_date::text AS session_date
FROM adversary_marks
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[])`;

const HELD_SQL = `SELECT DISTINCT symbol FROM book_positions WHERE strategy_id = $1 ORDER BY symbol`;

const BARS_SQL = `
SELECT date::text AS date, close, volume
FROM bars
WHERE symbol = $1 AND date <= $2::date
ORDER BY date DESC
LIMIT $3::int`;

const LAB_METHOD_SQL = `SELECT id, name, family, hypothesis FROM methods WHERE id = ?`;

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function kindOf(value: unknown): DecisionKind {
  if (value === 'bracket' || value === 'book') return value;
  throw new Error(`strategy_candidates.kind is ${str(value)}, expected bracket or book`);
}

function verdictOf(value: unknown): Verdict {
  if (value === 'agree' || value === 'object' || value === 'unsure') return value;
  throw new Error(`adversary_verdicts.verdict is ${str(value)}`);
}

/**
 * Every read the reviewer makes of Seer's database. Read-only by construction: it holds only a
 * ReadOnlySource. Writes go through SeerWriter (contract C4).
 */
export class SeerReader {
  constructor(private readonly source: SeerSource) {}

  private async rows(sql: string, params: readonly unknown[] = [], options: QueryOptions = { maxRows: MAX_ROWS }): Promise<Record<string, unknown>[]> {
    const result: QueryResult = await this.source.query(sql, params, options);
    return toObjects(result);
  }

  /** True when Seer migration 027 is applied (all adversary tables and columns exist). Throws ConnectorError when Seer is unreachable. */
  async schemaReady(): Promise<boolean> {
    const rows = await this.rows(SCHEMA_READY_SQL, [], { maxRows: 1 });
    return rows[0]?.ready === true;
  }

  async roster(): Promise<RosterRow[]> {
    return (await this.rows(ROSTER_SQL)).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      sub: str(r.sub),
      engine: strOrNull(r.engine),
      rulesId: strOrNull(r.rules_id),
      objectName: strOrNull(r.object_name),
      gateNote: strOrNull(r.gate_note),
      promotedFrom: strOrNull(r.promoted_from),
      status: str(r.status),
      twinOf: strOrNull(r.twin_of),
      isBenchmark: r.is_benchmark === true,
    }));
  }

  async candidates(fromDate: string, strategyIds: readonly string[]): Promise<CandidateRow[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(CANDIDATES_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
      dataDate: str(r.data_date),
      kind: kindOf(r.kind),
      rank: num(r.rank),
      symbol: str(r.symbol),
      weight: numOrNull(r.weight),
      evidence: r.evidence ?? null,
    }));
  }

  async previews(fromDate: string, strategyIds: readonly string[]): Promise<PreviewRow[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(PREVIEWS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      dataDate: str(r.data_date),
      rank: num(r.rank),
      symbol: str(r.symbol),
      weight: num(r.weight),
      nextDecisionSession: str(r.next_decision_session),
    }));
  }

  /** Non-superseded verdicts for sessions on/after fromDate. */
  async verdictsFrom(fromDate: string, strategyIds: readonly string[]): Promise<VerdictRef[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(VERDICTS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      id: num(r.id),
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
      symbol: str(r.symbol),
      verdict: verdictOf(r.verdict),
      decidedAt: str(r.decided_at),
    }));
  }

  async marksFrom(fromDate: string, strategyIds: readonly string[]): Promise<MarkRef[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(MARKS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
    }));
  }

  /** Symbols the original holds now (book strategies). */
  async heldSymbols(strategyId: string): Promise<string[]> {
    return (await this.rows(HELD_SQL, [strategyId])).map((r) => str(r.symbol));
  }

  /** Newest first, never later than `throughDate` (the decision night: the information cutoff of the price tool). */
  async priceBars(symbol: string, throughDate: string, limit: number): Promise<Bar[]> {
    const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(limit)));
    return (await this.rows(BARS_SQL, [symbol, throughDate, cap], { maxRows: cap })).map((r) => ({
      date: str(r.date),
      close: num(r.close),
      volume: num(r.volume),
    }));
  }

  /** The lab method a roster row was promoted from. Null when there is no lab reader or no such method; throws when lab.sqlite cannot be read. */
  async labMethod(methodId: string): Promise<LabMethod | null> {
    const lab = this.source.lab;
    if (lab === undefined) return null;
    const rows = toObjects(await lab.query(LAB_METHOD_SQL, [methodId], { maxRows: 1 }));
    const r = rows[0];
    if (r === undefined) return null;
    return { id: str(r.id), name: str(r.name), family: str(r.family), hypothesis: str(r.hypothesis) };
  }
}
```
**Impact:** none (new). `createConnector('seer')` and `toObjects` are reused unchanged.

### Step 10: The Seer writer (contract C4)
**File:** `src/adversary/seerWriter.ts` (new)
**Change:** a writable `pg.Client` per call on the direct URL from `SEER_DIR/.env.local`
(`loadDatabaseTarget` already picks the non-pooler host and drops `options` from the URL). Never goes
through `guard.ts`/`runPgQuery`. Every data statement passes `assertWritable` first.
**Code:**
```ts
import pg from 'pg';
import { loadDatabaseTarget } from '../connectors/env.js';
import { reasonOf, scrub } from '../connectors/errors.js';
import { CONNECTOR_PG_TYPES } from '../connectors/pg.js';
import { ConnectorError } from '../connectors/types.js';
import type { Source, Verdict } from './types.js';

/** The only Seer tables mcp-notes may write (contract C4). */
export const WRITABLE_TABLES = ['adversary_verdicts', 'adversary_marks', 'adversary_leases'] as const;
export type WritableTable = (typeof WRITABLE_TABLES)[number];

const WRITE_TIMEOUT_MS = 15_000;
const STATEMENT = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_.]*)\s/i;
const SUPERSEDE_ONLY = /^\s*UPDATE\s+adversary_verdicts\s+SET\s+superseded_by\s*=\s*\$\d+\s+WHERE\s/i;

export class AdversaryWriteError extends Error {
  override name = 'AdversaryWriteError';
}

/**
 * Refuses any statement outside contract C4 before it reaches the database: one statement, INSERT
 * into one of WRITABLE_TABLES, UPDATE of adversary_verdicts.superseded_by only, UPDATE/DELETE of
 * adversary_leases. Verdicts are append-only and marks are never removed. Returns the table.
 */
export function assertWritable(sql: string): WritableTable {
  if (sql.includes(';')) throw new AdversaryWriteError('the Seer writer sends one statement at a time');
  const match = STATEMENT.exec(sql);
  if (match === null) throw new AdversaryWriteError('the Seer writer only inserts, updates or deletes');
  const verb = (match[1] ?? '').toUpperCase().replace(/\s+/g, ' ');
  const table = (match[2] ?? '').toLowerCase();
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new AdversaryWriteError(`the Seer writer may not write ${table}`);
  }
  if (verb === 'DELETE FROM' && table !== 'adversary_leases') {
    throw new AdversaryWriteError(`${table} is never deleted from`);
  }
  if (verb === 'UPDATE' && table === 'adversary_marks') throw new AdversaryWriteError('adversary_marks is never updated');
  if (verb === 'UPDATE' && table === 'adversary_verdicts' && !SUPERSEDE_ONLY.test(sql)) {
    throw new AdversaryWriteError('adversary_verdicts only ever gets superseded_by set');
  }
  return table as WritableTable;
}

export interface NewVerdict {
  strategyId: string;
  sessionDate: string;
  symbol: string;
  verdict: Verdict;
  reason: string;
  sources: Source[];
  lens: string;
  /** Exact verdict model id. */
  model: string;
  promptVersion: string;
  host: string;
  /** When the review began (host clock); stored as LEAST(startedAt, DB now()). */
  startedAt: Date;
}

export interface WrittenVerdict {
  id: number;
  /** ISO 8601 UTC, the Seer DB's now() at insert. */
  decidedAt: string;
}

export interface SeerWriterOptions {
  /** Seer repo dir, resolved on every call (SEER_DIR may change without a restart). */
  repoDir: () => string;
  timeoutMs?: number;
}

type Exec = (sql: string, params: readonly unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>;

const CLAIM_SQL = `INSERT INTO adversary_leases (strategy_id, session_date, host, claimed_at, expires_at)
VALUES ($1, $2::date, $3, now(), now() + make_interval(secs => $4::double precision))
ON CONFLICT (strategy_id, session_date) DO UPDATE
  SET host = EXCLUDED.host, claimed_at = now(), expires_at = EXCLUDED.expires_at
  WHERE adversary_leases.expires_at < now() OR adversary_leases.host = EXCLUDED.host
RETURNING host`;

const RENEW_SQL = `UPDATE adversary_leases SET expires_at = now() + make_interval(secs => $4::double precision)
WHERE strategy_id = $1 AND session_date = $2::date AND host = $3
RETURNING host`;

const RELEASE_SQL = `DELETE FROM adversary_leases WHERE strategy_id = $1 AND session_date = $2::date AND host = $3`;

const VERDICT_SQL = `INSERT INTO adversary_verdicts
  (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at)
VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, LEAST($11::timestamptz, now()), now())
RETURNING id, to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at`;

const SUPERSEDE_SQL = `UPDATE adversary_verdicts SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL`;

const MARK_SQL = `INSERT INTO adversary_marks (strategy_id, session_date, mark, host)
VALUES ($1, $2::date, 'paused', $3)
ON CONFLICT (strategy_id, session_date) DO NOTHING
RETURNING strategy_id`;

/**
 * The narrow writer of Seer's adversary tables (contract C4). Separate from the read-only connector
 * guard on purpose: the guard stays read-only. Opens one connection per call and closes it.
 */
export class SeerWriter {
  constructor(private readonly opts: SeerWriterOptions) {}

  private async withClient<T>(fn: (exec: Exec, client: pg.Client) => Promise<T>): Promise<T> {
    const target = loadDatabaseTarget('seer', this.opts.repoDir());
    const timeoutMs = this.opts.timeoutMs ?? WRITE_TIMEOUT_MS;
    const client = new pg.Client({
      connectionString: target.url,
      options: `-c statement_timeout=${timeoutMs} -c TimeZone=UTC`,
      application_name: 'mcp-notes-adversary',
      connectionTimeoutMillis: 10_000,
      query_timeout: timeoutMs + 2_000,
      types: CONNECTOR_PG_TYPES,
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => {});
      throw new AdversaryWriteError(`seer is not reachable for writing: ${scrub(reasonOf(err), target.secrets)}`);
    }
    const exec: Exec = (sql, params) => {
      assertWritable(sql);
      return client.query<Record<string, unknown>>(sql, [...params]);
    };
    try {
      return await fn(exec, client);
    } catch (err) {
      if (err instanceof AdversaryWriteError || err instanceof ConnectorError) throw err;
      throw new AdversaryWriteError(`seer write failed: ${scrub(reasonOf(err), target.secrets)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Claims (or re-claims as the same host) the lease of one decision. Expiry is the DB clock's. */
  async claimLease(strategyId: string, sessionDate: string, host: string, ttlMs: number): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(CLAIM_SQL, [strategyId, sessionDate, host, ttlMs / 1000])).rowCount === 1);
  }

  /** Extends this host's lease; false when another host took it over. */
  async renewLease(strategyId: string, sessionDate: string, host: string, ttlMs: number): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(RENEW_SQL, [strategyId, sessionDate, host, ttlMs / 1000])).rowCount === 1);
  }

  async releaseLease(strategyId: string, sessionDate: string, host: string): Promise<void> {
    await this.withClient(async (exec) => {
      await exec(RELEASE_SQL, [strategyId, sessionDate, host]);
    });
  }

  /** Inserts a verdict and, in the same transaction, points the verdict it replaces at it. */
  async insertVerdict(v: NewVerdict, supersedes: number | null): Promise<WrittenVerdict> {
    return this.withClient(async (exec, client) => {
      await client.query('BEGIN');
      try {
        const inserted = await exec(VERDICT_SQL, [
          v.strategyId,
          v.sessionDate,
          v.symbol,
          v.verdict,
          v.reason,
          JSON.stringify(v.sources),
          v.lens,
          v.model,
          v.promptVersion,
          v.host,
          v.startedAt.toISOString(),
        ]);
        const row = inserted.rows[0];
        if (row === undefined) throw new AdversaryWriteError('adversary_verdicts insert returned no row');
        const written: WrittenVerdict = { id: Number(row.id), decidedAt: String(row.decided_at) };
        if (supersedes !== null) await exec(SUPERSEDE_SQL, [written.id, supersedes]);
        await client.query('COMMIT');
        return written;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  /** Writes a 'paused' mark; false when the decision already had one. */
  async insertMark(strategyId: string, sessionDate: string, host: string): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(MARK_SQL, [strategyId, sessionDate, host])).rowCount === 1);
  }
}
```
**Impact:** none (new). `pg.ts` is imported, not changed.

### Step 11: Data tools (in-process SDK MCP server)
**File:** `src/adversary/tools.ts` (new)
**Change:** tools mirror the URL/auth usage of Seer's own clients:
- Finnhub (`seer engine/src/seer_engine/finnhub.py`): base `https://finnhub.io/api/v1`, key only in
  the `X-Finnhub-Token` header, 60 calls/min spaced >= 1 s. Seer itself only calls `/company-news`
  and `/calendar/earnings`; `/stock/recommendation`, `/stock/metric?metric=all` and
  `/stock/insider-transactions` are added here and degrade to a plain "unavailable" text on 401/403
  (not in the plan) or 429.
- Massive (`massive.py`): base `https://api.massive.com`, key only as the `apiKey` query parameter,
  free tier 5/min spaced >= 12.5 s; news is Polygon's `/v2/reference/news`.
- SEC (`sec.py`): `https://data.sec.gov/submissions/CIK##########.json`, `User-Agent` carries
  `SEC_CONTACT_EMAIL`, <= 10 req/s spaced >= 0.11 s; ticker -> CIK from Seer's vendored
  `engine/data/ticker_cik.csv` (current rows, `end_date` empty, `cik` not `NONE`).
- `seer_price_context` reads `bars` only up to the decision night (no network).
- `fetch_url` is the only way a page enters the per-review `SourceLedger`; built-in WebFetch is
  disallowed in the agent, so every citation is a URL this tool recorded.
**Code:**
```ts
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { reasonOf, scrub } from '../connectors/errors.js';
import { addDays, utcDate } from './sessions.js';
import type { Bar, Source } from './types.js';

export const ADVERSARY_MCP_SERVER = 'adversary';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const MASSIVE_BASE = 'https://api.massive.com';
const SEC_SUBMISSIONS = 'https://data.sec.gov/submissions';
const USER_AGENT = 'mcp-notes-adversary/0.1';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_PAGE_TEXT = 12_000;
const MAX_ITEMS = 20;
const PRICE_BARS = 260;
export const FINNHUB_MIN_INTERVAL_MS = 1_000;
export const MASSIVE_MIN_INTERVAL_MS = 12_500;
export const SEC_MIN_INTERVAL_MS = 110;

/** Forms that can break a pick's story: results, events, insider trades, takeovers, delistings. */
const SEC_FORMS = new Set([
  '8-K', '8-K/A', '10-Q', '10-K', '4', 'SC 13D', 'SC 13D/A', 'SC TO-T', 'SC 14D9',
  'DEFM14A', 'PREM14A', 'S-4', '425', '25-NSE', '15-12B', '15-12G',
]);

const SYMBOL = z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,11}$/, 'a ticker such as AAPL or BRK.B');

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

// ---------- rate limits ----------

export interface RateLimiter {
  /** Resolves when the next call may go out; calls are spaced at least the interval apart. */
  wait(): Promise<void>;
}

export function intervalLimiter(
  minIntervalMs: number,
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): RateLimiter {
  let last = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();
  return {
    wait(): Promise<void> {
      const turn = chain.then(async () => {
        const delay = last + minIntervalMs - clock();
        if (delay > 0) await sleep(delay);
        last = clock();
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

export interface Limiters {
  finnhub: RateLimiter;
  massive: RateLimiter;
  sec: RateLimiter;
}

/** One set per daemon: limits are per API key, shared by every review. */
export function defaultLimiters(): Limiters {
  return {
    finnhub: intervalLimiter(FINNHUB_MIN_INTERVAL_MS),
    massive: intervalLimiter(MASSIVE_MIN_INTERVAL_MS),
    sec: intervalLimiter(SEC_MIN_INTERVAL_MS),
  };
}

// ---------- keys ----------

export interface SeerKeys {
  finnhub: string | null;
  massive: string | null;
  /** A contact email SEC can reach; null when unset or not an address. */
  secContact: string | null;
}

/** FINNHUB_API_KEY, MASSIVE_API_KEY, SEC_CONTACT_EMAIL from <repoDir>/.env.local, read on every call. Never logged. */
export function loadSeerKeys(repoDir: string): SeerKeys {
  let vars: Record<string, string> = {};
  try {
    vars = parseDotenv(readFileSync(path.join(repoDir, '.env.local')));
  } catch {
    vars = {};
  }
  const pick = (key: string): string | null => {
    const value = vars[key]?.trim() ?? '';
    return value === '' ? null : value;
  };
  const contact = pick('SEC_CONTACT_EMAIL');
  return {
    finnhub: pick('FINNHUB_API_KEY'),
    massive: pick('MASSIVE_API_KEY'),
    secContact: contact !== null && /^[^@\s]+@[^@\s]+$/.test(contact) ? contact : null,
  };
}

// ---------- ticker -> CIK (Seer's vendored map) ----------

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** symbol -> 10-digit CIK for rows still current (end_date empty) with a real filer. Missing file: empty map. */
export async function loadTickerCik(file: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '');
  const iSymbol = header.indexOf('symbol');
  const iCik = header.indexOf('cik');
  const iEnd = header.indexOf('end_date');
  if (iSymbol < 0 || iCik < 0 || iEnd < 0) return map;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cells = parseCsvLine(line);
    const symbol = cells[iSymbol]?.trim().toUpperCase() ?? '';
    const cik = cells[iCik]?.trim() ?? '';
    const end = cells[iEnd]?.trim() ?? '';
    if (symbol === '' || end !== '' || !/^\d{10}$/.test(cik)) continue;
    map.set(symbol, cik);
  }
  return map;
}

/** Reads <seer>/engine/data/ticker_cik.csv once per path. */
export function createTickerCikLookup(repoDir: () => string): (symbol: string) => Promise<string | null> {
  let cache: { file: string; map: Promise<Map<string, string>> } | null = null;
  return async (symbol) => {
    const file = path.join(repoDir(), 'engine', 'data', 'ticker_cik.csv');
    if (cache === null || cache.file !== file) cache = { file, map: loadTickerCik(file) };
    return (await cache.map).get(symbol.toUpperCase()) ?? null;
  };
}

// ---------- the ledger of pages actually fetched ----------

/** URL without fragment and without a trailing slash on a non-root path; null when not a URL. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    const text = url.toString();
    return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text;
  } catch {
    return null;
  }
}

/** The pages one review opened with fetch_url. Only these can be cited (brief §4.2). */
export class SourceLedger {
  private readonly byUrl = new Map<string, Source>();

  /** Records a fetched page under its requested URL and, when different, the URL it redirected to. */
  record(source: Source, finalUrl?: string): void {
    for (const raw of [source.url, finalUrl]) {
      if (raw === undefined || raw === '') continue;
      const key = normalizeUrl(raw);
      if (key !== null) this.byUrl.set(key, source);
    }
  }

  get(url: string): Source | undefined {
    const key = normalizeUrl(url);
    return key === null ? undefined : this.byUrl.get(key);
  }

  list(): Source[] {
    return [...new Set(this.byUrl.values())];
  }
}

// ---------- pages ----------

/** A public http(s) URL, or null for anything that points at this machine or a private network. */
export function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = -1, b = -1] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return null;
    }
  }
  if (host.includes(':') && (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) return null;
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#') && name !== '#39') return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metaContent(html: string, key: string): string | null {
  const tag = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escapeRe(key)}["'][^>]*>`, 'i').exec(html)?.[0];
  if (tag === undefined) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  const value = content === undefined ? '' : decodeEntities(content).trim();
  return value === '' ? null : value;
}

function titleTag(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const value = raw === undefined ? '' : decodeEntities(raw).replace(/\s+/g, ' ').trim();
  return value === '' ? null : value;
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [cut]`;
}

export interface ReadPage {
  title: string | null;
  publisher: string | null;
  publishedAt: string | null;
  text: string;
}

export function readPage(raw: string, contentType: string, url: string): ReadPage {
  const host = hostOf(url);
  if (!/html|xml/i.test(contentType)) {
    return { title: null, publisher: host, publishedAt: null, text: clip(raw.replace(/\s+/g, ' ').trim(), MAX_PAGE_TEXT) };
  }
  return {
    title: metaContent(raw, 'og:title') ?? titleTag(raw),
    publisher: metaContent(raw, 'og:site_name') ?? host,
    publishedAt: isoOrNull(
      metaContent(raw, 'article:published_time') ?? metaContent(raw, 'og:published_time') ?? metaContent(raw, 'datePublished') ?? metaContent(raw, 'date'),
    ),
    text: clip(htmlToText(raw), MAX_PAGE_TEXT),
  };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

// ---------- prices ----------

function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function changeOver(bars: readonly Bar[], sessions: number): number | null {
  const latest = bars[0];
  const then = bars[sessions];
  return latest !== undefined && then !== undefined && then.close > 0 ? round(latest.close / then.close - 1) : null;
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Plain numbers from Seer's bars (newest first), nothing after `through`. */
export function priceContext(symbol: string, through: string, bars: readonly Bar[], spy: readonly Bar[]): Record<string, unknown> {
  const last = bars[0];
  const avg200 = bars.length >= 200 ? mean(bars.slice(0, 200).map((b) => b.close)) : null;
  const value20 = mean(bars.slice(0, 20).map((b) => b.close * b.volume));
  return {
    symbol,
    through,
    last_date: last?.date ?? null,
    last_close: last?.close ?? null,
    sessions_available: bars.length,
    change_5_sessions: changeOver(bars, 5),
    change_20_sessions: changeOver(bars, 20),
    change_60_sessions: changeOver(bars, 60),
    change_250_sessions: changeOver(bars, 250),
    vs_200_session_average: last !== undefined && avg200 !== null && avg200 > 0 ? round(last.close / avg200 - 1) : null,
    average_daily_value_20_sessions_usd: value20 === null ? null : Math.round(value20),
    spy: {
      change_5_sessions: changeOver(spy, 5),
      change_20_sessions: changeOver(spy, 20),
      change_60_sessions: changeOver(spy, 60),
    },
    last_10_closes: bars.slice(0, 10).map((b) => ({ date: b.date, close: b.close })),
    note: "Raw daily closes from Seer's own price table, nothing after the night the method decided. Changes are fractions (0.05 = up 5%). A stock split inside the window shows as a jump.",
  };
}

// ---------- the tools ----------

export interface ToolDeps {
  fetch: FetchFn;
  keys: SeerKeys;
  limiters: Limiters;
  seer: { priceBars(symbol: string, throughDate: string, limit: number): Promise<Bar[]> };
  tickerCik: (symbol: string) => Promise<string | null>;
  now: () => Date;
}

export interface ToolScope {
  /** The stock under review (the default symbol of every tool). */
  symbol: string;
  /** The decision night: seer_price_context never reads a later bar. */
  dataDate: string;
  ledger: SourceLedger;
}

export interface ReviewTools {
  server: McpSdkServerConfigWithInstance;
  /** WebSearch plus `mcp__adversary__<tool>` for every tool offered. */
  allowedTools: string[];
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function unavailable(message: string): CallToolResult {
  return textResult(`unavailable: ${message}`);
}

type JsonAnswer = { ok: true; data: unknown } | { ok: false; message: string };

async function getJson(deps: ToolDeps, url: URL, headers: Record<string, string>, label: string, secrets: string[]): Promise<JsonAnswer> {
  let res: Response;
  try {
    res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, message: scrub(`${label} did not answer: ${reasonOf(err)}`, secrets) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `${label} refused this request (HTTP ${res.status}); it may not be in the free plan` };
  }
  if (res.status === 429) return { ok: false, message: `${label} rate limit reached; use another source` };
  if (!res.ok) return { ok: false, message: `${label} answered HTTP ${res.status}` };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, message: `${label} sent something that is not JSON` };
  }
}

function finnhub(deps: ToolDeps, key: string, pathname: string, params: Record<string, string>): Promise<JsonAnswer> {
  const url = new URL(`${FINNHUB_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return deps.limiters.finnhub.wait().then(() =>
    getJson(deps, url, { 'X-Finnhub-Token': key, Accept: 'application/json', 'User-Agent': USER_AGENT }, 'Finnhub', [key]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function guarded(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch((err: unknown) => unavailable(reasonOf(err)));
}

function finnhubTools(deps: ToolDeps, scope: ToolScope, key: string): Array<SdkMcpToolDefinition<any>> {
  const today = (): string => utcDate(deps.now());
  return [
    tool(
      'finnhub_company_news',
      'Company news headlines from Finnhub for a stock (default: the stock under review), newest first, at most 20, with links to open with fetch_url.',
      { symbol: SYMBOL.optional(), days: z.number().int().min(1).max(30).optional().describe('How many days back. Default 7.') },
      async ({ symbol, days }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/company-news', { symbol: sym, from: addDays(today(), -(days ?? 7)), to: today() });
          if (!answer.ok) return unavailable(answer.message);
          const items = asArray(answer.data)
            .map(asRecord)
            .filter((r) => typeof r.headline === 'string' && r.headline !== '')
            .slice(0, MAX_ITEMS)
            .map((r) => ({
              published: typeof r.datetime === 'number' ? new Date(r.datetime * 1000).toISOString() : null,
              source: r.source ?? null,
              headline: r.headline,
              summary: typeof r.summary === 'string' ? clip(r.summary, 300) : null,
              url: r.url ?? null,
            }));
          return textResult({ symbol: sym, items });
        }),
    ),
    tool(
      'finnhub_earnings_calendar',
      'Scheduled results dates from Finnhub for a stock over the next 60 days.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/calendar/earnings', { symbol: sym, from: today(), to: addDays(today(), 60) });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(asRecord(answer.data).earningsCalendar)
            .map(asRecord)
            .map((r) => ({ date: r.date ?? null, hour: r.hour ?? null, eps_estimate: r.epsEstimate ?? null, revenue_estimate: r.revenueEstimate ?? null }));
          return textResult({ symbol: sym, scheduled: rows });
        }),
    ),
    tool(
      'finnhub_recommendation_trends',
      "Analysts' buy/hold/sell counts for a stock from Finnhub, the last four months.",
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/recommendation', { symbol: sym });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(answer.data)
            .map(asRecord)
            .slice(0, 4)
            .map((r) => ({ period: r.period ?? null, strong_buy: r.strongBuy ?? null, buy: r.buy ?? null, hold: r.hold ?? null, sell: r.sell ?? null, strong_sell: r.strongSell ?? null }));
          return textResult({ symbol: sym, months: rows });
        }),
    ),
    tool(
      'finnhub_basic_financials',
      'A few headline numbers for a company from Finnhub: size, valuation, growth, debt, 52-week range.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/metric', { symbol: sym, metric: 'all' });
          if (!answer.ok) return unavailable(answer.message);
          const metric = asRecord(asRecord(answer.data).metric);
          const keys = [
            'marketCapitalization', '52WeekHigh', '52WeekLow', '52WeekPriceReturnDaily', 'peTTM',
            'epsGrowthTTMYoy', 'revenueGrowthTTMYoy', 'netProfitMarginTTM', 'totalDebt/totalEquityQuarterly',
            'dividendYieldIndicatedAnnual', 'beta',
          ];
          const picked: Record<string, unknown> = {};
          for (const k of keys) if (metric[k] !== undefined && metric[k] !== null) picked[k] = metric[k];
          return textResult({ symbol: sym, metrics: picked, note: 'marketCapitalization is in millions of US dollars.' });
        }),
    ),
    tool(
      'finnhub_insider_transactions',
      'Buying and selling by company insiders over the last 90 days, from Finnhub, at most 20 rows.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/insider-transactions', { symbol: sym, from: addDays(today(), -90), to: today() });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(asRecord(answer.data).data)
            .map(asRecord)
            .slice(0, MAX_ITEMS)
            .map((r) => ({ name: r.name ?? null, change: r.change ?? null, shares_after: r.share ?? null, date: r.transactionDate ?? null, code: r.transactionCode ?? null, price: r.transactionPrice ?? null }));
          return textResult({ symbol: sym, transactions: rows });
        }),
    ),
  ];
}

function massiveNewsTool(deps: ToolDeps, scope: ToolScope, key: string): SdkMcpToolDefinition<any> {
  return tool(
    'massive_news',
    'News articles about a stock from Massive (Polygon), newest first, with links to open with fetch_url.',
    { symbol: SYMBOL.optional(), limit: z.number().int().min(1).max(MAX_ITEMS).optional() },
    async ({ symbol, limit }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const url = new URL(`${MASSIVE_BASE}/v2/reference/news`);
        url.searchParams.set('ticker', sym);
        url.searchParams.set('order', 'desc');
        url.searchParams.set('sort', 'published_utc');
        url.searchParams.set('limit', String(limit ?? 10));
        url.searchParams.set('apiKey', key);
        await deps.limiters.massive.wait();
        const answer = await getJson(deps, url, { Accept: 'application/json', 'User-Agent': USER_AGENT }, 'Massive', [key]);
        if (!answer.ok) return unavailable(answer.message);
        const items = asArray(asRecord(answer.data).results)
          .map(asRecord)
          .map((r) => ({
            published: r.published_utc ?? null,
            publisher: asRecord(r.publisher).name ?? null,
            title: r.title ?? null,
            description: typeof r.description === 'string' ? clip(r.description, 300) : null,
            url: r.article_url ?? null,
          }));
        return textResult({ symbol: sym, items });
      }),
  );
}

function secFilingsTool(deps: ToolDeps, scope: ToolScope, contact: string): SdkMcpToolDefinition<any> {
  return tool(
    'sec_filings',
    "A company's recent SEC filings (8-K events, 10-Q/10-K results, Form 4 insider trades, takeover and delisting forms), last 120 days, with links to open with fetch_url.",
    { symbol: SYMBOL.optional() },
    async ({ symbol }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const cik = await deps.tickerCik(sym);
        if (cik === null) return unavailable(`no SEC filer is known for ${sym}`);
        await deps.limiters.sec.wait();
        const url = new URL(`${SEC_SUBMISSIONS}/CIK${cik}.json`);
        const answer = await getJson(deps, url, { 'User-Agent': `${USER_AGENT} (${contact})`, Accept: 'application/json' }, 'SEC EDGAR', [contact]);
        if (!answer.ok) return unavailable(answer.message);
        const recent = asRecord(asRecord(asRecord(answer.data).filings).recent);
        const forms = asArray(recent.form);
        const filed = asArray(recent.filingDate);
        const accession = asArray(recent.accessionNumber);
        const documents = asArray(recent.primaryDocument);
        const descriptions = asArray(recent.primaryDocDescription);
        const items = asArray(recent.items);
        const since = addDays(utcDate(deps.now()), -120);
        const cikNumber = String(Number(cik));
        const out: Record<string, unknown>[] = [];
        for (let i = 0; i < forms.length && out.length < 25; i += 1) {
          const form = String(forms[i] ?? '');
          const date = String(filed[i] ?? '');
          if (!SEC_FORMS.has(form) || date < since) continue;
          const acc = String(accession[i] ?? '');
          const doc = String(documents[i] ?? '');
          out.push({
            form,
            filed: date,
            description: descriptions[i] ?? null,
            items: items[i] ?? null,
            url: acc !== '' && doc !== '' ? `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${acc.replace(/-/g, '')}/${doc}` : null,
          });
        }
        return textResult({ symbol: sym, cik, filings: out });
      }),
  );
}

function priceTool(deps: ToolDeps, scope: ToolScope): SdkMcpToolDefinition<any> {
  return tool(
    'seer_price_context',
    "Seer's own daily prices for a stock up to the night the method decided (no network): recent changes, distance from its 200-session average, daily trading value, and the same changes for SPY.",
    { symbol: SYMBOL.optional() },
    async ({ symbol }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const [bars, spy] = await Promise.all([
          deps.seer.priceBars(sym, scope.dataDate, PRICE_BARS),
          deps.seer.priceBars('SPY', scope.dataDate, PRICE_BARS),
        ]);
        if (bars.length === 0) return unavailable(`Seer has no prices for ${sym} up to ${scope.dataDate}`);
        return textResult(priceContext(sym, scope.dataDate, bars, spy));
      }),
  );
}

function fetchUrlTool(deps: ToolDeps, scope: ToolScope): SdkMcpToolDefinition<any> {
  return tool(
    'fetch_url',
    'Open a web page and read its text. Only pages opened with this tool can be cited in the verdict, so open every page you rely on.',
    { url: z.string().min(8).max(2_000) },
    async ({ url }) =>
      guarded(async () => {
        const target = publicHttpUrl(url);
        if (target === null) return unavailable('only public http(s) pages can be opened');
        const isSec = /(^|\.)sec\.gov$/i.test(target.hostname);
        if (isSec) await deps.limiters.sec.wait();
        const agent = isSec && deps.keys.secContact !== null ? `${USER_AGENT} (${deps.keys.secContact})` : `${USER_AGENT} (personal research reader)`;
        let res: Response;
        try {
          res = await deps.fetch(target, {
            headers: { 'User-Agent': agent, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
            redirect: 'follow',
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
        } catch (err) {
          return unavailable(`could not open ${target.hostname}: ${reasonOf(err)}`);
        }
        if (!res.ok) return unavailable(`${target.hostname} answered HTTP ${res.status}`);
        const type = res.headers.get('content-type') ?? '';
        if (!/^text\/|application\/(xhtml\+xml|json|xml)/i.test(type)) {
          return unavailable(`${target.hostname} sent ${type === '' ? 'an unknown type' : type}, which cannot be read as text`);
        }
        const raw = await readCapped(res, MAX_PAGE_BYTES);
        const finalUrl = res.url !== '' ? res.url : target.toString();
        const page = readPage(raw, type, finalUrl);
        const source: Source = {
          url: target.toString(),
          title: page.title,
          publisher: page.publisher,
          published_at: page.publishedAt,
          fetched_at: deps.now().toISOString(),
        };
        scope.ledger.record(source, finalUrl);
        return textResult({ url: source.url, title: source.title, publisher: source.publisher, published_at: source.published_at, text: page.text });
      }),
  );
}

/** The tools one review gets. A source whose key is missing from Seer's .env.local is left out. */
export function adversaryTools(deps: ToolDeps, scope: ToolScope): Array<SdkMcpToolDefinition<any>> {
  const tools: Array<SdkMcpToolDefinition<any>> = [priceTool(deps, scope), fetchUrlTool(deps, scope)];
  if (deps.keys.finnhub !== null) tools.push(...finnhubTools(deps, scope, deps.keys.finnhub));
  if (deps.keys.massive !== null) tools.push(massiveNewsTool(deps, scope, deps.keys.massive));
  if (deps.keys.secContact !== null) tools.push(secFilingsTool(deps, scope, deps.keys.secContact));
  return tools;
}

/** A fresh in-process MCP server per review (its ledger is per review). */
export function adversaryServer(deps: ToolDeps, scope: ToolScope): ReviewTools {
  const tools = adversaryTools(deps, scope);
  return {
    server: createSdkMcpServer({ name: ADVERSARY_MCP_SERVER, version: '0.1.0', tools, alwaysLoad: true }),
    allowedTools: ['WebSearch', ...tools.map((t) => `mcp__${ADVERSARY_MCP_SERVER}__${t.name}`)],
  };
}
```
**Impact:** none (new). First use of `createSdkMcpServer`/`tool` in the repo (SDK 0.3.311,
`sdk.d.ts` `createSdkMcpServer` ~line 633, `tool` ~line 10110). If `tsc` rejects the
`CallToolResult` import as incompatible with the SDK's handler type, import the type the SDK uses
instead: `type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>`.

### Step 12a: The two-stage agent
**File:** `src/adversary/agent.ts` (new)
**Change:** stage 1 (gather): configured gather model, the in-process tools plus built-in
`WebSearch`, built-in `WebFetch` disallowed, turn cap, returns a dossier. Stage 2 (verdict):
configured verdict model, no tools, `outputFormat: { type: 'json_schema' }`, result validated once
with zod. Post-validation: an agree/object that cites no URL from the ledger becomes `unsure`. Exact
model ids and usage come from the SDK result (`modelUsage`, `total_cost_usd`, `num_turns`). Same SDK
hygiene as the chat brain and the summarizer: `claudeEnv` (no keys, no parent-session markers), no
settings, strict MCP config, no persisted session, `QueryFn` seam.
**Code:**
```ts
import { mkdir } from 'node:fs/promises';
import { query as sdkQuery, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { GATHER_SYSTEM, REASON_MAX_CHARS, VERDICT_SYSTEM, gatherPrompt, verdictPrompt } from './prompt.js';
import { ADVERSARY_MCP_SERVER, SourceLedger, type ReviewTools, type ToolScope } from './tools.js';
import { ReviewFailure, type ReviewContext, type ReviewOutcome, type ReviewUsage, type ReviewVerdict, type Source, type StockReviewer } from './types.js';

/** `<dataDir>/adversary`: the fixed cwd of every reviewer run (nothing is persisted there). */
export const ADVERSARY_SUBDIR = 'adversary';
/** The verdict stage has no tools; structured output may take a retry turn. */
export const VERDICT_MAX_TURNS = 4;
export const MAX_DOSSIER_CHARS = 12_000;
export const MAX_CITED_URLS = 10;

export const VerdictSchema = z.object({
  verdict: z.enum(['agree', 'object', 'unsure']),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
  source_urls: z.array(z.string()).max(MAX_CITED_URLS),
});
export type RawVerdict = z.infer<typeof VerdictSchema>;
export const VERDICT_JSON_SCHEMA = z.toJSONSchema(VerdictSchema) as Record<string, unknown>;

export interface AgentReviewerOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/adversary`; created on first use. */
  cwd: string;
  gatherModel: string;
  verdictModel: string;
  gatherMaxTurns: number;
  /** Wall clock per stock, both stages. */
  timeoutMs: number;
  /** Builds the in-process data tools for one review; they record fetched pages into scope.ledger. */
  tools: (scope: ToolScope) => ReviewTools;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Keeps only citations of pages the review actually fetched. An agree or object left with none
 * becomes unsure (brief §4.2: unverifiable claims become "can't tell").
 */
export function finalizeVerdict(raw: RawVerdict, ledger: SourceLedger): { verdict: ReviewVerdict; downgraded: boolean } {
  const cited: Source[] = [];
  for (const url of raw.source_urls) {
    const source = ledger.get(url);
    if (source !== undefined && !cited.includes(source)) cited.push(source);
  }
  const reason = raw.reason.trim();
  if (raw.verdict !== 'unsure' && cited.length === 0) {
    return {
      verdict: {
        verdict: 'unsure',
        reason: clip(`No page that was actually read backs this call, so the pick stays. ${reason}`, REASON_MAX_CHARS),
        sources: [],
      },
      downgraded: true,
    };
  }
  return { verdict: { verdict: raw.verdict, reason: clip(reason, REASON_MAX_CHARS), sources: cited }, downgraded: false };
}

interface StageResult {
  text: string;
  structured: unknown;
  /** The model that produced most output in this stage, from modelUsage. */
  model: string | null;
}

function addUsage(usage: ReviewUsage, message: SDKResultMessage): string | null {
  usage.costUsd += message.total_cost_usd ?? 0;
  usage.turns += message.num_turns ?? 0;
  let top: string | null = null;
  let topOutput = -1;
  for (const [model, mu] of Object.entries(message.modelUsage ?? {})) {
    usage.inputTokens += mu.inputTokens + mu.cacheReadInputTokens + mu.cacheCreationInputTokens;
    usage.outputTokens += mu.outputTokens;
    if (mu.outputTokens > topOutput) {
      top = model;
      topOutput = mu.outputTokens;
    }
  }
  return top;
}

async function runStage(query: QueryFn, prompt: string, options: Options, usage: ReviewUsage): Promise<StageResult> {
  let result: StageResult | null = null;
  let failure: string | null = null;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type !== 'result') continue;
      const model = addUsage(usage, message);
      if (message.subtype === 'success' && !message.is_error) {
        result = { text: message.result, structured: message.structured_output, model };
      } else if (message.subtype === 'success') {
        failure = message.result.trim() || 'the agent failed without saying why';
      } else {
        failure = message.errors.join('; ').trim() || `the agent failed (${message.subtype})`;
      }
    }
  } catch (err) {
    // A CLI that exits non-zero after its result still produced that result: trust it.
    if (result === null && failure === null) failure = errorText(err);
  }
  if (result !== null) return result;
  throw new Error(failure ?? 'the agent ended without a result');
}

/**
 * The production reviewer: two Claude Agent SDK runs per stock on the owner's login. Null when the
 * claude binary cannot be found; the daemon logs that once and runs without a reviewer.
 */
export function createAgentReviewer(opts: AgentReviewerOptions): StockReviewer | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  let cwdReady: Promise<unknown> | null = null;

  function common(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      persistSession: false,
    };
  }

  function gatherOptions(abortController: AbortController, tools: ReviewTools): Options {
    return {
      ...common(abortController),
      model: opts.gatherModel,
      mcpServers: { [ADVERSARY_MCP_SERVER]: tools.server },
      tools: ['WebSearch'],
      allowedTools: tools.allowedTools,
      disallowedTools: ['WebFetch'],
      maxTurns: opts.gatherMaxTurns,
      systemPrompt: GATHER_SYSTEM,
    };
  }

  function verdictOptions(abortController: AbortController): Options {
    return {
      ...common(abortController),
      model: opts.verdictModel,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      disallowedTools: ['WebFetch', 'WebSearch'],
      maxTurns: VERDICT_MAX_TURNS,
      systemPrompt: VERDICT_SYSTEM,
      outputFormat: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA },
    };
  }

  return {
    gatherModel: opts.gatherModel,
    verdictModel: opts.verdictModel,
    async review(ctx: ReviewContext, signal: AbortSignal): Promise<ReviewOutcome> {
      if (signal.aborted) throw new ReviewFailure('review stopped: notesd is shutting down', null);
      cwdReady ??= mkdir(opts.cwd, { recursive: true });
      await cwdReady;
      const controller = new AbortController();
      const relay = (): void => controller.abort(signal.reason);
      signal.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, opts.timeoutMs);
      timer.unref();
      const usage: ReviewUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, gatherModel: opts.gatherModel, verdictModel: opts.verdictModel };
      const ledger = new SourceLedger();
      try {
        const tools = opts.tools({ symbol: ctx.pick.symbol, dataDate: ctx.decision.dataDate, ledger });
        const gather = await runStage(query, gatherPrompt(ctx), gatherOptions(controller, tools), usage);
        if (gather.model !== null) usage.gatherModel = gather.model;
        const dossier = clip(gather.text.trim(), MAX_DOSSIER_CHARS);
        if (dossier === '') throw new Error('the gathering stage returned no dossier');
        const decided = await runStage(query, verdictPrompt(ctx, dossier, ledger.list()), verdictOptions(controller), usage);
        if (decided.model !== null) usage.verdictModel = decided.model;
        const parsed = VerdictSchema.safeParse(decided.structured);
        if (!parsed.success) {
          throw new Error(`the verdict did not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        }
        const { verdict, downgraded } = finalizeVerdict(parsed.data, ledger);
        return { verdict, usage, downgraded };
      } catch (err) {
        if (timedOut) throw new ReviewFailure(`no verdict within ${Math.round(opts.timeoutMs / 1000)} s`, usage);
        if (signal.aborted) throw new ReviewFailure('review stopped: notesd is shutting down', usage);
        throw new ReviewFailure(errorText(err), usage);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
      }
    },
  };
}
```
**Impact:** none (new). Reuses `QueryFn` (`src/chat/agent.ts:21`), `claudeEnv` (`src/chat/env.ts`),
`findClaudeBin` (`src/sessions/summarize.ts`).

### Step 12b: `adversary_reviews` repository
**File:** `src/adversary/reviewsRepo.ts` (new)
**Code:**
```ts
import { and, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adversaryReviews, type AdversaryStoredVerdict } from '../db/schema.js';
import { attemptKey, draftKey, type DraftRef } from './plan.js';
import type { ReviewStage } from './types.js';

export type ReviewStatus = 'ok' | 'failed' | 'skipped_budget' | 'late';

/** Statuses that spent a deep review (counted against the daily cap unless reused). */
const DEEP: ReviewStatus[] = ['ok', 'failed', 'late'];

export interface NewReview {
  strategyId: string;
  sessionDate: string;
  symbol: string;
  stage: ReviewStage;
  status: ReviewStatus;
  verdict: AdversaryStoredVerdict | null;
  promptVersion: string;
  gatherModel: string | null;
  verdictModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  error: string | null;
  host: string;
  reusedFrom: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface RecentReviews {
  /** draftKey -> latest ok draft. */
  drafts: Map<string, DraftRef>;
  /** attemptKey -> failed attempts. */
  failures: Map<string, number>;
  /** attemptKey of skipped_budget rows since the start of today (WIB). */
  skippedToday: Set<string>;
  /** Deep reviews since the start of today (WIB). */
  usedToday: number;
}

/** The only writer of adversary_reviews: the reviewer's attempt log, usage log and draft store. */
export class ReviewsRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewReview): Promise<number> {
    const inserted = await this.db
      .insert(adversaryReviews)
      .values({
        strategyId: row.strategyId,
        sessionDate: row.sessionDate,
        symbol: row.symbol,
        stage: row.stage,
        status: row.status,
        verdict: row.verdict,
        promptVersion: row.promptVersion,
        gatherModel: row.gatherModel,
        verdictModel: row.verdictModel,
        inputTokens: Math.round(row.inputTokens),
        outputTokens: Math.round(row.outputTokens),
        costUsd: row.costUsd,
        turns: Math.round(row.turns),
        error: row.error,
        host: row.host,
        reusedFrom: row.reusedFrom,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      })
      .returning({ id: adversaryReviews.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('adversary_reviews insert returned no id');
    return id;
  }

  /** Deep reviews started at or after `since`, both machines. */
  async countDeepSince(since: Date): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(adversaryReviews)
      .where(and(gte(adversaryReviews.startedAt, since), inArray(adversaryReviews.status, DEEP), isNull(adversaryReviews.reusedFrom)));
    return rows[0]?.n ?? 0;
  }

  /** Everything the planner needs from rows started at or after `since` (dayStart >= since). */
  async recent(since: Date, dayStart: Date): Promise<RecentReviews> {
    const rows = await this.db.select().from(adversaryReviews).where(gte(adversaryReviews.startedAt, since)).orderBy(adversaryReviews.startedAt, adversaryReviews.id);
    const out: RecentReviews = { drafts: new Map(), failures: new Map(), skippedToday: new Set(), usedToday: 0 };
    for (const row of rows) {
      const stage = row.stage as ReviewStage;
      const attempt = attemptKey(row.strategyId, row.sessionDate, row.symbol, stage);
      const today = row.startedAt.getTime() >= dayStart.getTime();
      if (row.status === 'failed') out.failures.set(attempt, (out.failures.get(attempt) ?? 0) + 1);
      if (row.status === 'skipped_budget' && today) out.skippedToday.add(attempt);
      if (today && (DEEP as string[]).includes(row.status) && row.reusedFrom === null) out.usedToday += 1;
      if (stage === 'draft' && row.status === 'ok' && row.verdict !== null) {
        out.drafts.set(draftKey(row.strategyId, row.sessionDate, row.symbol, row.promptVersion), {
          id: row.id,
          startedAt: row.startedAt,
          verdict: row.verdict,
          gatherModel: row.gatherModel,
          verdictModel: row.verdictModel,
        });
      }
    }
    return out;
  }
}
```
**Impact:** none (new).

### Step 12c: The service and the job
**File:** `src/adversary/service.ts` (new)
**Change:** orchestrates one pass: schema check (idles with a logged reason before Seer 027, D13),
roster -> reviewable originals -> due decisions (open > now) -> toggle off: paused marks only ->
lenses + prompt versions -> recent reviews -> plan -> per decision: lease, review / reuse / skip,
renew after each stock, release. Passes are serialised on one promise chain so the poll loop and
`reviewNow` never overlap on one host; the lease keeps two hosts apart.
**Code:**
```ts
import { join } from 'node:path';
import type { AdversaryConfig } from '../config.js';
import { createConnector } from '../connectors/connector.js';
import { connectorSettings, resolveRepoDir } from '../connectors/env.js';
import { reasonOf } from '../connectors/errors.js';
import type { Db } from '../db/client.js';
import type { AdversaryStoredVerdict } from '../db/schema.js';
import { SessionsRepo } from '../sessions/repo.js';
import { ADVERSARY_SUBDIR, createAgentReviewer } from './agent.js';
import { AdversaryEvents } from './events.js';
import { BRIEFS_DIR, buildLens, readBrief } from './lens.js';
import {
  DRAFT_WINDOW_MS,
  decisionKey,
  planWork,
  reviewableOriginals,
  toDecisions,
  toPreviewDecisions,
  type PlannedAction,
} from './plan.js';
import { promptVersion } from './prompt.js';
import { ReviewsRepo, type NewReview } from './reviewsRepo.js';
import { SeerReader } from './seerReader.js';
import { SeerWriter } from './seerWriter.js';
import { addDays, utcDate, wibDayStartUtc } from './sessions.js';
import { readToggle, writeToggle, type ToggleState } from './toggle.js';
import { adversaryServer, createTickerCikLookup, defaultLimiters, loadSeerKeys } from './tools.js';
import { ReviewFailure, type Decision, type Lens, type ReviewOutcome, type RosterRow, type StockReviewer } from './types.js';

export type RunTrigger = 'auto' | 'manual';
export type SchemaState = 'unknown' | 'ready' | 'missing' | 'unreachable';

export interface ReviewNowOptions {
  strategyId?: string;
  sessionDate?: string;
  /** Re-review symbols that already have a verdict; the new verdict supersedes the old. */
  rereview?: boolean;
}

export interface RunSummary {
  trigger: RunTrigger;
  host: string;
  started_at: string;
  finished_at: string | null;
  /** Final verdicts written to Seer after a deep review. */
  reviewed: number;
  /** Final verdicts written to Seer from an earlier draft (no tokens). */
  reused: number;
  /** Draft reviews of a book's next rebalance (never written to Seer). */
  drafted: number;
  failed: number;
  /** Written, but decided after the session opened (the engine ignores them). */
  late: number;
  skipped_budget: number;
  /** Paused marks written while auto runs were off. */
  marks: number;
  /** Decisions another host was reviewing. */
  leases_lost: number;
  error: string | null;
}

export interface AdversaryStatus {
  host: string;
  auto: ToggleState;
  running: RunTrigger | null;
  schema: SchemaState;
  daily_cap: number;
  used_today: number;
  next_poll_at: string | null;
  last_run: RunSummary | null;
  models: { gather: string; verdict: string };
}

export interface AdversaryServiceOptions {
  config: AdversaryConfig;
  db: Db;
  /** os.hostname(): written on leases, verdicts, marks and review rows. */
  host: string;
  reviewer: StockReviewer;
  seer: SeerReader;
  writer: SeerWriter;
  now?: () => Date;
  log?: (line: string) => void;
  briefsDir?: string;
}

const CLOSE_GRACE_MS = 5_000;
const INITIAL_DELAY_MS = 30_000;

type ReviewAction = Exclude<PlannedAction, { type: 'skip_budget' }>;

function emptySummary(trigger: RunTrigger, host: string, now: Date): RunSummary {
  return {
    trigger,
    host,
    started_at: now.toISOString(),
    finished_at: null,
    reviewed: 0,
    reused: 0,
    drafted: 0,
    failed: 0,
    late: 0,
    skipped_budget: 0,
    marks: 0,
    leases_lost: 0,
    error: null,
  };
}

/**
 * Seer Adversarial's reviewer (R4). Reads Seer through SeerReader, writes only through SeerWriter
 * (contract C4), logs every attempt in adversary_reviews, and emits AdversaryEvents after each
 * committed write. Phase 5 calls reviewNow / getToggle / setToggle / status.
 */
export class AdversaryService {
  readonly events = new AdversaryEvents();
  private readonly settings: SessionsRepo;
  private readonly reviews: ReviewsRepo;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly briefsDir: string;
  private readonly controller = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextPollAt: Date | null = null;
  private started = false;
  private closed = false;
  private running: RunTrigger | null = null;
  private schema: SchemaState = 'unknown';
  private lastRun: RunSummary | null = null;
  private lastLogged: string | null = null;

  constructor(private readonly opts: AdversaryServiceOptions) {
    this.settings = new SessionsRepo(opts.db);
    this.reviews = new ReviewsRepo(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.briefsDir = opts.briefsDir ?? BRIEFS_DIR;
  }

  get host(): string {
    return this.opts.host;
  }

  /** A lease outlives one stock's review with room to spare; it is renewed after every stock. */
  private get leaseMs(): number {
    return 2 * this.opts.config.stockTimeoutMs + 60_000;
  }

  /** Starts the poll loop (background.ts). The first pass runs after min(30 s, pollMs). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(Math.min(INITIAL_DELAY_MS, this.opts.config.pollMs));
  }

  /** One automatic pass now (obeys the toggle). */
  pollNow(): Promise<RunSummary> {
    return this.enqueue('auto', {});
  }

  /** One manual pass now: runs even while auto runs are off ("Review now"). Do not await it in a request handler. */
  reviewNow(options: ReviewNowOptions = {}): Promise<RunSummary> {
    return this.enqueue('manual', options);
  }

  async getToggle(): Promise<ToggleState> {
    return readToggle(this.settings);
  }

  async setToggle(on: boolean, host: string): Promise<ToggleState> {
    const state = await writeToggle(this.settings, on, host, this.now());
    this.events.emit({ op: 'toggle' });
    if (on && this.started) this.schedule(0);
    return state;
  }

  async status(): Promise<AdversaryStatus> {
    const [auto, used] = await Promise.all([this.getToggle(), this.reviews.countDeepSince(wibDayStartUtc(this.now()))]);
    return {
      host: this.opts.host,
      auto,
      running: this.running,
      schema: this.schema,
      daily_cap: this.opts.config.dailyCap,
      used_today: used,
      next_poll_at: this.nextPollAt === null ? null : this.nextPollAt.toISOString(),
      last_run: this.lastRun,
      models: { gather: this.opts.reviewer.gatherModel, verdict: this.opts.reviewer.verdictModel },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
    this.controller.abort('closed');
    await Promise.race([this.chain, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextPollAt = new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow().finally(() => this.schedule(this.opts.config.pollMs));
    }, delayMs);
    this.timer.unref();
  }

  private enqueue(trigger: RunTrigger, options: ReviewNowOptions): Promise<RunSummary> {
    const run = this.chain.then(() => this.pass(trigger, options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private logChanged(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.log(line);
  }

  private async pass(trigger: RunTrigger, options: ReviewNowOptions): Promise<RunSummary> {
    const summary = emptySummary(trigger, this.opts.host, this.now());
    if (this.closed) {
      summary.error = 'notesd is shutting down';
      summary.finished_at = this.now().toISOString();
      return summary;
    }
    this.running = trigger;
    this.events.emit({ op: 'run' });
    try {
      await this.passBody(trigger, options, summary);
      this.logChanged('[notesd] adversary: Seer is reachable and ready');
    } catch (err) {
      summary.error = reasonOf(err);
      this.logChanged(`[notesd] adversary: ${summary.error}`);
    } finally {
      this.running = null;
      summary.finished_at = this.now().toISOString();
      this.lastRun = summary;
      this.events.emit({ op: 'run' });
    }
    const did = summary.reviewed + summary.reused + summary.drafted + summary.failed + summary.skipped_budget + summary.marks;
    if (did > 0) {
      this.log(
        `[notesd] adversary ${trigger} pass: ${summary.reviewed} reviewed, ${summary.reused} reused, ${summary.drafted} drafted, ${summary.failed} failed, ${summary.late} late, ${summary.skipped_budget} over the cap, ${summary.marks} paused marks`,
      );
    }
    return summary;
  }

  private async passBody(trigger: RunTrigger, options: ReviewNowOptions, summary: RunSummary): Promise<void> {
    const { seer } = this.opts;
    let ready: boolean;
    try {
      ready = await seer.schemaReady();
    } catch (err) {
      this.schema = 'unreachable';
      throw err;
    }
    if (!ready) {
      this.schema = 'missing';
      throw new Error("Seer's database has no adversary tables yet (Seer migration 027 is not applied); idling");
    }
    this.schema = 'ready';

    const now = this.now();
    const fromDate = addDays(utcDate(now), -1);
    const originals = reviewableOriginals(await seer.roster());
    if (originals.length === 0) return;
    const ids = originals.map((r) => r.id);
    const [candidateRows, verdictRefs] = await Promise.all([seer.candidates(fromDate, ids), seer.verdictsFrom(fromDate, ids)]);
    const decisions = toDecisions(candidateRows, now);
    const verdicts = new Map<string, Map<string, number>>();
    for (const v of verdictRefs) {
      const key = decisionKey(v.strategyId, v.sessionDate);
      let bySymbol = verdicts.get(key);
      if (bySymbol === undefined) {
        bySymbol = new Map();
        verdicts.set(key, bySymbol);
      }
      bySymbol.set(v.symbol, v.id);
    }

    if (trigger === 'auto' && !(await this.getToggle()).on) {
      await this.writePausedMarks(decisions, verdicts, fromDate, ids, summary);
      return;
    }

    const decided = new Set(candidateRows.map((r) => decisionKey(r.strategyId, r.sessionDate)));
    const previews = toPreviewDecisions(await seer.previews(fromDate, ids), decided, now);
    const lenses = await this.lensesFor(originals);
    const promptVersions = new Map<string, string>();
    for (const [id, lens] of lenses) {
      promptVersions.set(id, promptVersion(lens, this.opts.reviewer.gatherModel, this.opts.reviewer.verdictModel));
    }
    const recent = await this.reviews.recent(new Date(now.getTime() - DRAFT_WINDOW_MS), wibDayStartUtc(now));
    const actions = planWork({
      decisions,
      previews,
      promptVersions,
      verdicts,
      drafts: recent.drafts,
      failures: recent.failures,
      skippedToday: recent.skippedToday,
      used: recent.usedToday,
      cap: this.opts.config.dailyCap,
      rereview: options.rereview === true,
      only: { strategyId: options.strategyId, sessionDate: options.sessionDate },
    });
    const byId = new Map(originals.map((r) => [r.id, r] as const));
    await this.execute(actions, byId, lenses, promptVersions, summary);
  }

  /**
   * A lens per original. A strategy whose lab method cannot be read right now is left out of this
   * pass rather than reviewed under a different lens (which would show as a spurious revision).
   */
  private async lensesFor(originals: readonly RosterRow[]): Promise<Map<string, Lens>> {
    const out = new Map<string, Lens>();
    for (const row of originals) {
      try {
        const [lab, brief] = await Promise.all([
          row.promotedFrom === null ? Promise.resolve(null) : this.opts.seer.labMethod(row.promotedFrom),
          readBrief(row.objectName, this.briefsDir),
        ]);
        out.set(row.id, buildLens(row, lab, brief));
      } catch (err) {
        this.log(`[notesd] adversary: skipping ${row.id} this pass, its lens could not be built: ${reasonOf(err)}`);
      }
    }
    return out;
  }

  private async writePausedMarks(
    decisions: readonly Decision[],
    verdicts: ReadonlyMap<string, ReadonlyMap<string, number>>,
    fromDate: string,
    ids: readonly string[],
    summary: RunSummary,
  ): Promise<void> {
    const marked = new Set((await this.opts.seer.marksFrom(fromDate, ids)).map((m) => decisionKey(m.strategyId, m.sessionDate)));
    for (const decision of decisions) {
      const key = decisionKey(decision.strategyId, decision.sessionDate);
      if (verdicts.has(key) || marked.has(key)) continue;
      if (await this.opts.writer.insertMark(decision.strategyId, decision.sessionDate, this.opts.host)) {
        summary.marks += 1;
        this.events.emit({ op: 'mark', strategy_id: decision.strategyId, session_date: decision.sessionDate });
      }
    }
  }

  private async execute(
    actions: readonly PlannedAction[],
    originals: ReadonlyMap<string, RosterRow>,
    lenses: ReadonlyMap<string, Lens>,
    promptVersions: ReadonlyMap<string, string>,
    summary: RunSummary,
  ): Promise<void> {
    const groups: PlannedAction[][] = [];
    for (const action of actions) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last[0]?.decision === action.decision) last.push(action);
      else groups.push([action]);
    }
    const { writer } = this.opts;
    for (const group of groups) {
      if (this.closed) return;
      const decision = group[0]?.decision;
      if (decision === undefined) continue;
      const strategy = originals.get(decision.strategyId);
      const lens = lenses.get(decision.strategyId);
      const pv = promptVersions.get(decision.strategyId);
      if (strategy === undefined || lens === undefined || pv === undefined) continue;

      for (const action of group) if (action.type === 'skip_budget') await this.recordSkip(action.decision, action.pick.symbol, pv, summary);
      const work = group.filter((a): a is ReviewAction => a.type !== 'skip_budget');
      if (work.length === 0) continue;

      if (!(await writer.claimLease(decision.strategyId, decision.sessionDate, this.opts.host, this.leaseMs))) {
        summary.leases_lost += 1;
        continue;
      }
      try {
        const held = decision.kind === 'book' ? new Set(await this.opts.seer.heldSymbols(decision.strategyId)) : null;
        for (const action of work) {
          if (this.closed) break;
          // Never start a review once its session has opened: it could not count (honesty §5).
          if (decision.stage === 'final' && this.now().getTime() >= decision.openUtc.getTime()) break;
          await this.runAction(action, strategy, lens, pv, held, summary);
          if (!(await writer.renewLease(decision.strategyId, decision.sessionDate, this.opts.host, this.leaseMs))) {
            summary.leases_lost += 1;
            break;
          }
        }
      } finally {
        await writer
          .releaseLease(decision.strategyId, decision.sessionDate, this.opts.host)
          .catch((err: unknown) => this.log(`[notesd] adversary: could not release the lease of ${decision.strategyId} ${decision.sessionDate}: ${reasonOf(err)}`));
      }
    }
  }

  private async recordSkip(decision: Decision, symbol: string, pv: string, summary: RunSummary): Promise<void> {
    const at = this.now();
    await this.reviews.insert({
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol,
      stage: decision.stage,
      status: 'skipped_budget',
      verdict: null,
      promptVersion: pv,
      gatherModel: null,
      verdictModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
      error: `daily cap of ${this.opts.config.dailyCap} deep reviews reached`,
      host: this.opts.host,
      reusedFrom: null,
      startedAt: at,
      finishedAt: at,
    });
    summary.skipped_budget += 1;
  }

  private async runAction(action: ReviewAction, strategy: RosterRow, lens: Lens, pv: string, held: ReadonlySet<string> | null, summary: RunSummary): Promise<void> {
    if (action.type === 'reuse') {
      await this.reuseDraft(action, pv, summary);
      return;
    }
    const { decision, pick } = action;
    const base = {
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol: pick.symbol,
      stage: decision.stage,
      promptVersion: pv,
      host: this.opts.host,
    };
    const startedAt = this.now();
    let outcome: ReviewOutcome;
    try {
      outcome = await this.opts.reviewer.review(
        { strategy, lens, promptVersion: pv, decision, pick, held: held === null ? null : held.has(pick.symbol), now: startedAt },
        this.controller.signal,
      );
    } catch (err) {
      const usage = err instanceof ReviewFailure ? err.usage : null;
      await this.reviews.insert({
        ...base,
        status: 'failed',
        verdict: null,
        gatherModel: usage?.gatherModel ?? this.opts.reviewer.gatherModel,
        verdictModel: usage?.verdictModel ?? null,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage?.costUsd ?? 0,
        turns: usage?.turns ?? 0,
        error: reasonOf(err),
        reusedFrom: null,
        startedAt,
        finishedAt: this.now(),
      });
      summary.failed += 1;
      this.log(`[notesd] adversary: ${decision.strategyId} ${decision.sessionDate} ${pick.symbol} failed: ${reasonOf(err)}`);
      return;
    }

    const stored: AdversaryStoredVerdict = {
      verdict: outcome.verdict.verdict,
      reason: outcome.verdict.reason,
      sources: outcome.verdict.sources,
      lens: lens.id,
      seer_verdict_id: null,
      downgraded: outcome.downgraded,
    };
    const spent = {
      gatherModel: outcome.usage.gatherModel,
      verdictModel: outcome.usage.verdictModel,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: outcome.usage.costUsd,
      turns: outcome.usage.turns,
    };

    if (decision.stage === 'draft') {
      await this.reviews.insert({ ...base, ...spent, status: 'ok', verdict: stored, error: null, reusedFrom: null, startedAt, finishedAt: this.now() });
      summary.drafted += 1;
      return;
    }

    let written: { id: number; decidedAt: string };
    try {
      written = await this.opts.writer.insertVerdict(
        {
          strategyId: decision.strategyId,
          sessionDate: decision.sessionDate,
          symbol: pick.symbol,
          verdict: stored.verdict,
          reason: stored.reason,
          sources: stored.sources,
          lens: lens.id,
          model: outcome.usage.verdictModel,
          promptVersion: pv,
          host: this.opts.host,
          startedAt,
        },
        action.supersedes,
      );
    } catch (err) {
      await this.reviews.insert({
        ...base,
        ...spent,
        status: 'failed',
        verdict: stored,
        error: `the verdict could not be written to Seer: ${reasonOf(err)}`,
        reusedFrom: null,
        startedAt,
        finishedAt: this.now(),
      });
      summary.failed += 1;
      return;
    }
    const late = Date.parse(written.decidedAt) >= decision.openUtc.getTime();
    await this.reviews.insert({
      ...base,
      ...spent,
      status: late ? 'late' : 'ok',
      verdict: { ...stored, seer_verdict_id: written.id },
      error: null,
      reusedFrom: null,
      startedAt,
      finishedAt: this.now(),
    });
    summary.reviewed += 1;
    if (late) summary.late += 1;
    this.events.emit({ op: 'verdict', strategy_id: decision.strategyId, session_date: decision.sessionDate });
    this.log(
      `[notesd] adversary: ${decision.strategyId} ${decision.sessionDate} ${pick.symbol} -> ${stored.verdict}${late ? ' (late)' : ''} (${spent.turns} turns, $${spent.costUsd.toFixed(2)})`,
    );
  }

  private async reuseDraft(action: Extract<PlannedAction, { type: 'reuse' }>, pv: string, summary: RunSummary): Promise<void> {
    const { decision, pick, draft } = action;
    const at = this.now();
    const model = draft.verdictModel ?? this.opts.reviewer.verdictModel;
    const base: Omit<NewReview, 'status' | 'verdict' | 'error'> = {
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol: pick.symbol,
      stage: 'final',
      promptVersion: pv,
      gatherModel: draft.gatherModel,
      verdictModel: model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
      host: this.opts.host,
      reusedFrom: draft.id,
      startedAt: at,
      finishedAt: at,
    };
    let written: { id: number; decidedAt: string };
    try {
      written = await this.opts.writer.insertVerdict(
        {
          strategyId: decision.strategyId,
          sessionDate: decision.sessionDate,
          symbol: pick.symbol,
          verdict: draft.verdict.verdict,
          reason: draft.verdict.reason,
          sources: draft.verdict.sources,
          lens: draft.verdict.lens,
          model,
          promptVersion: pv,
          host: this.opts.host,
          startedAt: draft.startedAt,
        },
        action.supersedes,
      );
    } catch (err) {
      await this.reviews.insert({ ...base, status: 'failed', verdict: draft.verdict, error: `the draft could not be written to Seer: ${reasonOf(err)}` });
      summary.failed += 1;
      return;
    }
    const late = Date.parse(written.decidedAt) >= decision.openUtc.getTime();
    await this.reviews.insert({ ...base, status: late ? 'late' : 'ok', verdict: { ...draft.verdict, seer_verdict_id: written.id }, error: null });
    summary.reused += 1;
    if (late) summary.late += 1;
    this.events.emit({ op: 'verdict', strategy_id: decision.strategyId, session_date: decision.sessionDate });
  }
}

export interface CreateAdversaryServiceOptions {
  config: AdversaryConfig;
  db: Db;
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  dataDir: string;
  host: string;
  log?: (line: string) => void;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * The production wiring: Seer found through SEER_DIR (src/connectors/env.ts, re-read on every
 * call), data-tool keys from SEER_DIR/.env.local, the Agent SDK reviewer. Null when the claude
 * binary cannot be found.
 */
export function createAdversaryService(opts: CreateAdversaryServiceOptions): AdversaryService | null {
  const seerDir = (): string => resolveRepoDir('seer', connectorSettings());
  const seer = new SeerReader(createConnector('seer'));
  const limiters = defaultLimiters();
  const tickerCik = createTickerCikLookup(seerDir);
  const reviewer = createAgentReviewer({
    claudeBin: opts.claudeBin,
    cwd: join(opts.dataDir, ADVERSARY_SUBDIR),
    gatherModel: opts.config.gatherModel,
    verdictModel: opts.config.verdictModel,
    gatherMaxTurns: opts.config.gatherMaxTurns,
    timeoutMs: opts.config.stockTimeoutMs,
    baseEnv: opts.baseEnv,
    tools: (scope) =>
      adversaryServer(
        { fetch: (input, init) => fetch(input, init), keys: loadSeerKeys(seerDir()), limiters, seer, tickerCik, now: () => new Date() },
        scope,
      ),
  });
  if (reviewer === null) return null;
  return new AdversaryService({
    config: opts.config,
    db: opts.db,
    host: opts.host,
    reviewer,
    seer,
    writer: new SeerWriter({ repoDir: seerDir }),
    log: opts.log,
  });
}
```
**Impact:** none until wired (Step 13).

### Step 13: Wire the service into the daemon; update every hand-built literal
**File:** `src/deps.ts:1-21`
**Change:** add the import and the field.
**Code:** add at the top, with the other type imports:
```ts
import type { AdversaryService } from './adversary/service.js';
```
and after `chat: ChatService;` (line 20):
```ts
  /** Seer Adversarial reviewer (phase 4). Null when NOTESD_ADVERSARY=off or no claude binary. Phase 5's routes call it. */
  adversary: AdversaryService | null;
```
**File:** `src/daemon.ts:1-20` (imports), `:88` (deps)
**Change:** import `hostname` and the factory; build the service before `createApp` so phase 5's
routes see it on deps; it is *started* by `startBackground`.
**Code:** add imports:
```ts
import { hostname } from 'node:os';
import { createAdversaryService, type AdversaryService } from './adversary/service.js';
```
Replace line 88 (`const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory };`) with:
```ts
  let adversary: AdversaryService | null = null;
  if (config.adversary.enabled) {
    adversary = createAdversaryService({
      config: config.adversary,
      db,
      claudeBin: config.chat.claudeBin,
      dataDir: config.dataDir,
      host: hostname(),
    });
    if (adversary === null) {
      console.log(`[notesd] adversary off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
    }
  }
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary };
```
**File:** `src/background.ts:24-37` (doc), `:120` (before `return async () =>`), `:122-133` (stop)
**Change:** in the `startBackground` doc comment, after "...the session summary worker (summaries
only with `options.sessionSummarizer`)." add: "With `deps.adversary`, the Seer Adversarial
reviewer's poll loop." Before `return async () => {` insert:
```ts
  // Seer Adversarial reviewer (phase 4): built by the daemon, started here, closed on stop.
  if (deps.adversary === null) {
    console.log(
      deps.config.adversary.enabled
        ? '[notesd] adversary off: no reviewer could be built'
        : '[notesd] adversary off: NOTESD_ADVERSARY=off',
    );
  } else {
    deps.adversary.start();
    const a = deps.config.adversary;
    console.log(
      `[notesd] adversary reviewer on as ${deps.adversary.host}: a pass every ${Math.round(a.pollMs / 1000)} s, up to ${a.dailyCap} deep reviews a day, ${a.gatherModel} gathers, ${a.verdictModel} decides`,
    );
  }
```
and in the stop function's `Promise.all([...])`, after `sessionSummaries?.close(),` add:
```ts
      deps.adversary?.close(),
```
**Build the lever (literals):** `Config` and `AppDeps` are built by hand in ~10 test files. Run this
codemod once, then let `npm run typecheck` prove nothing was missed:
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
grep -rl 'sessions: DEFAULT_SESSIONS_CONFIG' tests | while read -r f; do
  sed -i 's/sessions: DEFAULT_SESSIONS_CONFIG\b/sessions: DEFAULT_SESSIONS_CONFIG, adversary: DEFAULT_ADVERSARY_CONFIG/g' "$f"
  sed -i "s/^\(import {[^}]*\)DEFAULT_SESSIONS_CONFIG\([^}]*} from '[./]*\/src\/config\.js';\)$/\1DEFAULT_ADVERSARY_CONFIG, DEFAULT_SESSIONS_CONFIG\2/" "$f"
done
grep -rl 'chat: new ChatService({ db })' tests | xargs sed -i 's/chat: new ChatService({ db })/chat: new ChatService({ db }), adversary: null/g'
grep -rn 'adversary' tests | grep -v '^tests/unit/adversary\|^tests/integration/adversary\|^tests/helpers/fakeReviewer'
```
Expected files touched (from `grep` at plan time): `tests/integration/embeddings.worker.int.test.ts`,
`daemon.int.test.ts`, `imageHarness.ts`, `mcp.tools.int.test.ts`, `related.int.test.ts`,
`images.int.test.ts` (2 sites), `connectors/mcp.int.test.ts`, `helpers/api-harness.ts`,
`sessions.ingest.int.test.ts`, `tests/unit/embeddings/embedBackfillCli.test.ts`. Then by hand in
`tests/integration/helpers/api-harness.ts`, in the `deps` literal after `chat,` (line ~62) add
`adversary: null,`. Run `npm run typecheck`; any remaining "Property 'adversary' is missing" error
names a literal to fix the same way.
**Impact:** `npm run typecheck` green again; no test behavior changes (every literal uses the OFF default / null).

### Step 14: Test setup and the live test
**File:** `tests/integration/setup.ts:50`
**Change:** add `adversary_reviews` at the front of the `truncate table` list:
```ts
  await db.execute(sql`truncate table adversary_reviews, note_session_links, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
**File:** `tests/live/chat.live.test.ts:55`
**Change:** after `NOTESD_SESSIONS: 'off',` add (the live test builds config from the real env, where
the reviewer now defaults on and would read the real Seer DB):
```ts
      // Never review real Seer decisions from a test daemon.
      NOTESD_ADVERSARY: 'off',
```
**Impact:** none beyond isolation.

### Step 15: Unit tests
**File:** `tests/unit/config.test.ts:6-14` (import), end of file
**Change:** add `DEFAULT_ADVERSARY_CONFIG` to the import list (alphabetical, before `DEFAULT_CHAT_CONFIG`) and append:
```ts
describe('adversary config', () => {
  it('defaults to on, 15 deep reviews a day, sonnet gathers and opus decides', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false }).adversary).toEqual({
      enabled: true,
      dailyCap: 15,
      gatherModel: 'sonnet',
      verdictModel: 'opus',
      gatherMaxTurns: 20,
      stockTimeoutMs: 420_000,
      pollMs: 600_000,
    })
  })

  it('reads every key', () => {
    const env = {
      DATABASE_URL: URL_A,
      NOTESD_ADVERSARY: 'off',
      ADVERSARY_DAILY_CAP: '3',
      ADVERSARY_GATHER_MODEL: 'haiku',
      ADVERSARY_VERDICT_MODEL: 'claude-opus-5-5',
      ADVERSARY_GATHER_MAX_TURNS: '9',
      ADVERSARY_STOCK_TIMEOUT_MS: '60000',
      ADVERSARY_POLL_MS: '5000',
    }
    expect(loadConfig({ env, envFile: false }).adversary).toEqual({
      enabled: false,
      dailyCap: 3,
      gatherModel: 'haiku',
      verdictModel: 'claude-opus-5-5',
      gatherMaxTurns: 9,
      stockTimeoutMs: 60_000,
      pollMs: 5_000,
    })
  })

  it.each([
    ['NOTESD_ADVERSARY', 'maybe'],
    ['ADVERSARY_DAILY_CAP', '0'],
    ['ADVERSARY_POLL_MS', '-5'],
    ['ADVERSARY_VERDICT_MODEL', 'op us'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadConfig({ env: { DATABASE_URL: URL_A, [key]: value }, envFile: false })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_ADVERSARY_CONFIG off so hand-built test configs never review', () => {
    expect(DEFAULT_ADVERSARY_CONFIG.enabled).toBe(false)
  })
})
```
**File:** `tests/helpers/fakeReviewer.ts` (new)
**Code:**
```ts
import { ReviewFailure, type ReviewContext, type ReviewUsage, type ReviewVerdict, type StockReviewer } from '../../src/adversary/types.js';

/** What every fake review reports having spent. */
export const FAKE_USAGE: ReviewUsage = {
  inputTokens: 1_200,
  outputTokens: 150,
  costUsd: 0.05,
  turns: 6,
  gatherModel: 'claude-sonnet-test',
  verdictModel: 'claude-opus-test',
};

export interface FakeReviewer extends StockReviewer {
  /** Every review asked for, in order. */
  readonly calls: ReviewContext[];
}

export interface FakeReviewerOptions {
  /** Each review waits for this before answering (lease tests). */
  gate?: Promise<void>;
  verdict?: (ctx: ReviewContext) => ReviewVerdict;
  /** A non-null message fails that review. */
  fail?: (ctx: ReviewContext) => string | null;
}

/** Default: object, citing one page "fetched" at ctx.now. */
export function fakeReviewer(options: FakeReviewerOptions = {}): FakeReviewer {
  const calls: ReviewContext[] = [];
  return {
    gatherModel: 'sonnet',
    verdictModel: 'opus',
    calls,
    async review(ctx, signal) {
      calls.push(ctx);
      if (options.gate !== undefined) await options.gate;
      if (signal.aborted) throw new ReviewFailure('review stopped', null);
      const failure = options.fail?.(ctx) ?? null;
      if (failure !== null) throw new ReviewFailure(failure, { ...FAKE_USAGE });
      const verdict: ReviewVerdict = options.verdict?.(ctx) ?? {
        verdict: 'object',
        reason: `Test objection to ${ctx.pick.symbol}.`,
        sources: [
          {
            url: `https://news.example.com/${ctx.pick.symbol.toLowerCase()}`,
            title: 'Test page',
            publisher: 'Example News',
            published_at: null,
            fetched_at: ctx.now.toISOString(),
          },
        ],
      };
      return { verdict, usage: { ...FAKE_USAGE }, downgraded: false };
    },
  };
}
```
**File:** `tests/unit/adversary/sessions.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { addDays, assertSessionDate, sessionOpenUtc, utcDate, wibDay, wibDayStartUtc } from '../../../src/adversary/sessions.js';

describe('sessionOpenUtc (mirror of seer_engine.dates.session_open_utc, contract C3)', () => {
  it('pins the contract examples', () => {
    expect(sessionOpenUtc('2026-11-04').toISOString()).toBe('2026-11-04T14:30:00.000Z');
    expect(sessionOpenUtc('2026-07-01').toISOString()).toBe('2026-07-01T13:30:00.000Z');
  });

  it('follows New York daylight saving on both sides of each 2026 switch', () => {
    // US DST 2026: starts Sunday 2026-03-08, ends Sunday 2026-11-01.
    expect(sessionOpenUtc('2026-03-06').toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(sessionOpenUtc('2026-03-09').toISOString()).toBe('2026-03-09T13:30:00.000Z');
    expect(sessionOpenUtc('2026-10-30').toISOString()).toBe('2026-10-30T13:30:00.000Z');
    expect(sessionOpenUtc('2026-11-02').toISOString()).toBe('2026-11-02T14:30:00.000Z');
  });

  it.each(['2026-13-01', '2026-02-30', '20261104', ''])('refuses %j', (value) => {
    expect(() => sessionOpenUtc(value)).toThrow(TypeError);
  });
});

describe('WIB days and date helpers', () => {
  it('starts a WIB day at 17:00 UTC the day before', () => {
    const lateEvening = new Date('2026-11-05T16:59:00Z'); // 23:59 WIB, 5 Nov
    expect(wibDay(lateEvening)).toBe('2026-11-05');
    expect(wibDayStartUtc(lateEvening).toISOString()).toBe('2026-11-04T17:00:00.000Z');
    expect(wibDay(new Date('2026-11-05T17:00:00Z'))).toBe('2026-11-06');
  });

  it('adds calendar days and reads the UTC date', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(utcDate(new Date('2026-11-05T23:00:00Z'))).toBe('2026-11-05');
    expect(() => assertSessionDate('yesterday')).toThrow(TypeError);
  });
});
```
**File:** `tests/unit/adversary/plan.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  attemptKey,
  decisionKey,
  draftKey,
  planWork,
  reviewableOriginals,
  toDecisions,
  toPreviewDecisions,
  type DraftRef,
  type PlanInput,
} from '../../../src/adversary/plan.js';
import type { CandidateRow, Decision, PreviewRow, RosterRow } from '../../../src/adversary/types.js';

const NOW = new Date('2031-01-10T00:00:00Z');

function row(id: string, extra: Partial<RosterRow> = {}): RosterRow {
  return {
    id,
    name: id,
    sub: 'test',
    engine: 'book',
    rulesId: null,
    objectName: null,
    gateNote: null,
    promotedFrom: null,
    status: 'active',
    twinOf: null,
    isBenchmark: false,
    ...extra,
  };
}

function candidates(strategyId: string, sessionDate: string, kind: 'bracket' | 'book', symbols: string[]): CandidateRow[] {
  return symbols.map((symbol, i) => ({
    strategyId,
    sessionDate,
    dataDate: '2031-01-09',
    kind,
    rank: i + 1,
    symbol,
    weight: kind === 'book' ? 1 / symbols.length : null,
    evidence: null,
  }));
}

function input(decisions: Decision[], extra: Partial<PlanInput> = {}): PlanInput {
  const ids = new Set(decisions.map((d) => d.strategyId));
  return {
    decisions,
    previews: [],
    promptVersions: new Map([...ids].map((id) => [id, 'adv-v1-aaaaaaaaaaaa'])),
    verdicts: new Map(),
    drafts: new Map(),
    failures: new Map(),
    skippedToday: new Set(),
    used: 0,
    cap: 15,
    rereview: false,
    ...extra,
  };
}

const summarize = (actions: ReturnType<typeof planWork>): string[] =>
  actions.map((a) => `${a.type}:${a.decision.strategyId}:${a.pick.symbol}`);

describe('reviewableOriginals', () => {
  it('keeps active non-benchmark originals with an active twin, read from the roster', () => {
    const roster = [
      row('SPY-GT', { engine: 'benchmark', isBenchmark: true }),
      row('C-GT', { engine: 'bracket' }),
      row('A-GT', { engine: 'bracket' }),
      row('A-GT-CX', { engine: 'bracket', twinOf: 'A-GT' }),
      row('RAW', { status: 'active' }),
      row('RAW-CX', { twinOf: 'RAW', status: 'retired' }),
      row('OLD', { status: 'retired' }),
      row('OLD-CX', { twinOf: 'OLD' }),
    ];
    expect(reviewableOriginals(roster).map((r) => r.id)).toEqual(['A-GT']);
  });
});

describe('toDecisions / toPreviewDecisions', () => {
  it('drops a decision whose session already opened and sorts picks by rank', () => {
    const rows = [...candidates('A', '2031-01-14', 'bracket', ['X', 'Y']).reverse(), ...candidates('B', '2031-01-09', 'book', ['Z'])];
    const decisions = toDecisions(rows, NOW);
    expect(decisions.map((d) => d.strategyId)).toEqual(['A']);
    expect(decisions[0]?.picks.map((p) => p.symbol)).toEqual(['X', 'Y']);
    expect(decisions[0]?.openUtc.toISOString()).toBe('2031-01-14T14:30:00.000Z');
  });

  it('drafts a preview only when its targets are not written yet and it opens within a week', () => {
    const preview = (strategyId: string, next: string): PreviewRow => ({ strategyId, dataDate: '2031-01-09', rank: 1, symbol: 'P', weight: 1, nextDecisionSession: next });
    const decided = new Set([decisionKey('DONE', '2031-01-13')]);
    const drafts = toPreviewDecisions([preview('SOON', '2031-01-13'), preview('DONE', '2031-01-13'), preview('FAR', '2031-02-03')], decided, NOW);
    expect(drafts.map((d) => [d.strategyId, d.stage, d.kind])).toEqual([['SOON', 'draft', 'book']]);
  });
});

describe('planWork', () => {
  const bracket = toDecisions(candidates('A', '2031-01-14', 'bracket', ['A1', 'A2']), NOW);
  const bookEarly = toDecisions(candidates('K', '2031-01-13', 'book', ['K1', 'K2']), NOW);
  const draft = toPreviewDecisions(
    [{ strategyId: 'K', dataDate: '2031-01-09', rank: 1, symbol: 'D1', weight: 1, nextDecisionSession: '2031-01-15' }],
    new Set(),
    NOW,
  );

  it('reviews bracket picks first, then books by earliest open, previews last, and skips the rest over the cap', () => {
    const actions = planWork(input([...bookEarly, ...bracket], { previews: draft, cap: 3 }));
    expect(summarize(actions)).toEqual(['review:A:A1', 'review:A:A2', 'review:K:K1', 'skip_budget:K:K2']);
  });

  it('spends leftover budget on previews and never logs a skipped preview', () => {
    expect(summarize(planWork(input([], { previews: draft, cap: 1, promptVersions: new Map([['K', 'pv']]) })))).toEqual(['review:K:D1']);
    expect(summarize(planWork(input([], { previews: draft, cap: 1, used: 1, promptVersions: new Map([['K', 'pv']]) })))).toEqual([]);
  });

  it('skips symbols that already have a verdict, unless re-reviewing, which supersedes it', () => {
    const verdicts = new Map([[decisionKey('A', '2031-01-14'), new Map([['A1', 41]])]]);
    expect(summarize(planWork(input(bracket, { verdicts })))).toEqual(['review:A:A2']);
    const again = planWork(input(bracket, { verdicts, rereview: true }));
    expect(again.map((a) => (a.type === 'review' ? a.supersedes : 'x'))).toEqual([41, null]);
  });

  it('reuses a recent draft with the same prompt version at no budget cost', () => {
    const ref: DraftRef = {
      id: 7,
      startedAt: NOW,
      verdict: { verdict: 'agree', reason: 'ok', sources: [], lens: 'L@1', seer_verdict_id: null, downgraded: false },
      gatherModel: 'g',
      verdictModel: 'v',
    };
    const drafts = new Map([[draftKey('A', '2031-01-14', 'A1', 'adv-v1-aaaaaaaaaaaa'), ref]]);
    expect(summarize(planWork(input(bracket, { drafts, cap: 1 })))).toEqual(['reuse:A:A1', 'review:A:A2']);
    const otherVersion = new Map([[draftKey('A', '2031-01-14', 'A1', 'adv-v1-bbbbbbbbbbbb'), ref]]);
    expect(summarize(planWork(input(bracket, { drafts: otherVersion, cap: 1 })))).toEqual(['review:A:A1', 'skip_budget:A:A2']);
  });

  it('writes a skipped_budget row once a day and stops retrying a pick that failed twice', () => {
    const skippedToday = new Set([attemptKey('A', '2031-01-14', 'A2', 'final')]);
    expect(summarize(planWork(input(bracket, { cap: 1, skippedToday })))).toEqual(['review:A:A1']);
    const failures = new Map([[attemptKey('A', '2031-01-14', 'A1', 'final'), 2]]);
    expect(summarize(planWork(input(bracket, { failures })))).toEqual(['review:A:A2']);
  });

  it('narrows a manual pass to one strategy and session', () => {
    expect(summarize(planWork(input([...bracket, ...bookEarly], { only: { strategyId: 'K' } })))).toEqual(['review:K:K1', 'review:K:K2']);
    expect(summarize(planWork(input([...bracket, ...bookEarly], { only: { sessionDate: '2031-01-14' } })))).toEqual(['review:A:A1', 'review:A:A2']);
  });

  it('leaves out a strategy without a prompt version (its lens could not be built)', () => {
    expect(planWork(input(bracket, { promptVersions: new Map() }))).toEqual([]);
  });
});
```
**File:** `tests/unit/adversary/seerWriter.test.ts` (new)
**Code:**
```ts
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdversaryWriteError, SeerWriter, assertWritable } from '../../../src/adversary/seerWriter.js';

describe('assertWritable (contract C4 allow-list)', () => {
  it.each([
    ['INSERT INTO adversary_leases (strategy_id) VALUES ($1) ON CONFLICT (strategy_id, session_date) DO UPDATE SET host = EXCLUDED.host RETURNING host', 'adversary_leases'],
    ['UPDATE adversary_leases SET expires_at = now() WHERE host = $3 RETURNING host', 'adversary_leases'],
    ['DELETE FROM adversary_leases WHERE host = $3', 'adversary_leases'],
    ['INSERT INTO adversary_verdicts (strategy_id) VALUES ($1) RETURNING id', 'adversary_verdicts'],
    ['UPDATE adversary_verdicts SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL', 'adversary_verdicts'],
    ["INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES ($1, $2, 'paused', $3) ON CONFLICT (strategy_id, session_date) DO NOTHING", 'adversary_marks'],
  ])('allows %s', (sql, table) => {
    expect(assertWritable(sql)).toBe(table);
  });

  it.each([
    'INSERT INTO strategies (id) VALUES ($1)',
    'UPDATE strategies SET status = $1',
    'DELETE FROM adversary_verdicts WHERE id = $1',
    'DELETE FROM adversary_marks WHERE strategy_id = $1',
    'UPDATE adversary_verdicts SET reason = $1 WHERE id = $2',
    'UPDATE adversary_marks SET mark = $1 WHERE strategy_id = $2',
    'INSERT INTO public.adversary_verdicts (id) VALUES ($1)',
    'SELECT * FROM adversary_verdicts',
    'INSERT INTO adversary_marks (strategy_id) VALUES ($1); DROP TABLE strategies',
  ])('refuses %s', (sql) => {
    expect(() => assertWritable(sql)).toThrow(AdversaryWriteError);
  });
});

describe('SeerWriter', () => {
  it('names the missing Seer repository instead of connecting anywhere', async () => {
    const writer = new SeerWriter({ repoDir: () => path.join(tmpdir(), `no-seer-here-${process.pid}`) });
    await expect(writer.insertMark('A-GT', '2031-01-14', 'lenovo')).rejects.toThrow(/seer is not reachable: no repository/);
  });
});
```
**File:** `tests/unit/adversary/lens.test.ts` (new)
**Code:**
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLens, lensText, readBrief } from '../../../src/adversary/lens.js';
import { promptVersion } from '../../../src/adversary/prompt.js';
import type { RosterRow } from '../../../src/adversary/types.js';

const RAW35: RosterRow = {
  id: 'RAW35-FR-GT',
  name: 'RAW35 · Unbraked momentum',
  sub: 'Top 35 by rise beyond the market, monthly',
  engine: 'book',
  rulesId: 'monthly-hold-frac-gotrade',
  objectName: 'RESIDMOM35',
  gateNote: 'Lab M0139 dev window only',
  promotedFrom: 'M0139',
  status: 'active',
  twinOf: null,
  isBenchmark: false,
};
const LAB = { id: 'M0139', name: 'Residual momentum, 35 names', family: 'momentum', hypothesis: 'Stocks that rose beyond the market keep doing so for a month.' };

const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-briefs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the lens', () => {
  it('is built from the roster row, the lab hypothesis and the owner brief', () => {
    const text = lensText(RAW35, LAB, 'Object to one-off jumps.');
    expect(text).toContain('Method: RAW35 · Unbraked momentum (RAW35-FR-GT)');
    expect(text).toContain('Top 35 by rise beyond the market');
    expect(text).toContain('A basket held until the next rebalance');
    expect(text).toContain('Lab M0139 dev window only');
    expect(text).toContain('Stocks that rose beyond the market keep doing so');
    expect(text).toContain('Object to one-off jumps.');
  });

  it('is identified as object_name@hash, and any change moves the hash and the prompt version', () => {
    const a = buildLens(RAW35, LAB, 'brief one');
    const b = buildLens(RAW35, LAB, 'brief two');
    expect(a.id).toMatch(/^RESIDMOM35@[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);
    const pv = promptVersion(a, 'sonnet', 'opus');
    expect(pv).toMatch(/^adv-v1-[0-9a-f]{12}$/);
    expect(promptVersion(buildLens(RAW35, LAB, 'brief one'), 'sonnet', 'opus')).toBe(pv);
    expect(promptVersion(b, 'sonnet', 'opus')).not.toBe(pv);
    expect(promptVersion(a, 'sonnet', 'claude-opus-5-5')).not.toBe(pv);
  });

  it('ships the three owner briefs, keyed by object_name', async () => {
    for (const name of ['STRATEGY_A', 'RESIDMOM35', 'COSKEW']) {
      expect((await readBrief(name))?.length ?? 0).toBeGreaterThan(200);
    }
    expect(await readBrief('NOPE_NOT_A_BRIEF')).toBeNull();
    expect(await readBrief(null)).toBeNull();
  });

  it('never reads outside the briefs directory', async () => {
    writeFileSync(path.join(dir, 'X.md'), 'secret');
    expect(await readBrief('../X', dir)).toBeNull();
    expect(await readBrief('X', dir)).toBe('secret');
  });
});
```
**File:** `tests/unit/adversary/toggle.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { AdversaryEvents, type AdversaryChange } from '../../../src/adversary/events.js';
import { ADVERSARY_TOGGLE_KEY, TOGGLE_DEFAULT, parseToggle, readToggle, writeToggle, type SettingsStore } from '../../../src/adversary/toggle.js';

function memoryStore(): SettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async getSetting(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async putSetting(key, value) {
      values.set(key, value);
    },
  };
}

describe('the adversary.auto toggle', () => {
  it('reads absent or malformed values as on', () => {
    expect(parseToggle(null)).toEqual(TOGGLE_DEFAULT);
    expect(parseToggle({ on: 'no' })).toEqual(TOGGLE_DEFAULT);
    expect(parseToggle({ on: false })).toEqual({ on: false, changed_at: null, host: null });
  });

  it('writes {on, changed_at, host} under adversary.auto and reads it back', async () => {
    const store = memoryStore();
    expect(await readToggle(store)).toEqual(TOGGLE_DEFAULT);
    const state = await writeToggle(store, false, 'gpd', new Date('2026-11-05T01:02:03Z'));
    expect(state).toEqual({ on: false, changed_at: '2026-11-05T01:02:03.000Z', host: 'gpd' });
    expect(store.values.get(ADVERSARY_TOGGLE_KEY)).toEqual(state);
    expect(await readToggle(store)).toEqual(state);
    await expect(writeToggle(store, true, ' ', new Date())).rejects.toThrow(TypeError);
  });
});

describe('AdversaryEvents', () => {
  it('delivers {type: adversary, op, ...} until unsubscribed', () => {
    const events = new AdversaryEvents();
    const seen: AdversaryChange[] = [];
    const off = events.on((c) => seen.push(c));
    events.emit({ op: 'verdict', strategy_id: 'A-GT', session_date: '2031-01-14' });
    off();
    events.emit({ op: 'run' });
    expect(seen).toEqual([{ type: 'adversary', op: 'verdict', strategy_id: 'A-GT', session_date: '2031-01-14' }]);
    expect(events.listenerCount()).toBe(0);
  });
});
```
**File:** `tests/unit/adversary/tools.test.ts` (new)
**Code:**
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SourceLedger,
  adversaryTools,
  htmlToText,
  intervalLimiter,
  loadTickerCik,
  normalizeUrl,
  publicHttpUrl,
  type RateLimiter,
  type ToolDeps,
} from '../../../src/adversary/tools.js';
import type { Bar } from '../../../src/adversary/types.js';

const noLimit: RateLimiter = { wait: async () => {} };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(overrides: Partial<ToolDeps> = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  let reply: (url: string) => Response = () => json({});
  const deps: ToolDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return reply(url);
    },
    keys: { finnhub: 'fh-secret-key', massive: 'ms-secret-key', secContact: 'owner@example.com' },
    limiters: { finnhub: noLimit, massive: noLimit, sec: noLimit },
    seer: { priceBars: async () => [] },
    tickerCik: async (symbol) => (symbol === 'ACME' ? '0000012345' : null),
    now: () => new Date('2026-11-05T10:00:00Z'),
    ...overrides,
  };
  const ledger = new SourceLedger();
  const scope = { symbol: 'ACME', dataDate: '2026-11-04', ledger };
  const tools = adversaryTools(deps, scope);
  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const t = tools.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    const result = await t.handler(args, {});
    const first = result.content[0];
    return first !== undefined && first.type === 'text' ? first.text : '';
  }
  return {
    calls,
    ledger,
    tools,
    call,
    setReply(fn: (url: string) => Response) {
      reply = fn;
    },
  };
}

describe('which tools a review gets', () => {
  it('offers a source only when its key is in Seer’s .env.local', () => {
    const none = harness({ keys: { finnhub: null, massive: null, secContact: null } });
    expect(none.tools.map((t) => t.name)).toEqual(['seer_price_context', 'fetch_url']);
    const all = harness();
    expect(all.tools.map((t) => t.name)).toEqual([
      'seer_price_context',
      'fetch_url',
      'finnhub_company_news',
      'finnhub_earnings_calendar',
      'finnhub_recommendation_trends',
      'finnhub_basic_financials',
      'finnhub_insider_transactions',
      'massive_news',
      'sec_filings',
    ]);
  });
});

describe('Finnhub tools', () => {
  it('send the key only in X-Finnhub-Token, as Seer does', async () => {
    const h = harness();
    h.setReply(() => json([{ headline: 'Acme cuts outlook', datetime: 1_762_300_000, source: 'Wire', url: 'https://news.example.com/a', summary: 'x' }]));
    const text = await h.call('finnhub_company_news');
    const sent = h.calls[0];
    expect(sent?.url).toBe('https://finnhub.io/api/v1/company-news?symbol=ACME&from=2026-10-29&to=2026-11-05');
    expect(sent?.headers.get('X-Finnhub-Token')).toBe('fh-secret-key');
    expect(JSON.parse(text).items[0]).toMatchObject({ headline: 'Acme cuts outlook', url: 'https://news.example.com/a' });
  });

  it('degrade to a plain "unavailable" on 403 and 429, never echoing the key', async () => {
    const h = harness();
    h.setReply(() => new Response('premium only fh-secret-key', { status: 403 }));
    const refused = await h.call('finnhub_insider_transactions');
    expect(refused).toMatch(/^unavailable: Finnhub refused this request \(HTTP 403\)/);
    expect(refused).not.toContain('fh-secret-key');
    h.setReply(() => new Response('', { status: 429 }));
    expect(await h.call('finnhub_basic_financials')).toMatch(/rate limit/);
  });
});

describe('massive_news', () => {
  it('sends the key as the apiKey query parameter only, as Seer does', async () => {
    const h = harness();
    h.setReply(() => json({ results: [{ title: 'Acme news', publisher: { name: 'Wire' }, published_utc: '2026-11-04T10:00:00Z', article_url: 'https://wire.example.com/b' }] }));
    const text = await h.call('massive_news', { limit: 5 });
    const url = new URL(h.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.massive.com/v2/reference/news');
    expect(url.searchParams.get('apiKey')).toBe('ms-secret-key');
    expect(url.searchParams.get('ticker')).toBe('ACME');
    expect(text).not.toContain('ms-secret-key');
    expect(JSON.parse(text).items[0]).toMatchObject({ publisher: 'Wire', url: 'https://wire.example.com/b' });
  });
});

describe('sec_filings', () => {
  it('declares the contact in the User-Agent and keeps only recent forms that matter', async () => {
    const h = harness();
    h.setReply(() =>
      json({
        filings: {
          recent: {
            form: ['8-K', 'S-8', '10-Q'],
            filingDate: ['2026-11-01', '2026-11-02', '2025-01-01'],
            accessionNumber: ['0000012345-26-000101', '0000012345-26-000102', '0000012345-25-000001'],
            primaryDocument: ['acme-8k.htm', 'acme-s8.htm', 'acme-10q.htm'],
            primaryDocDescription: ['8-K', 'S-8', '10-Q'],
            items: ['2.02', '', ''],
          },
        },
      }),
    );
    const out = JSON.parse(await h.call('sec_filings'));
    expect(h.calls[0]?.url).toBe('https://data.sec.gov/submissions/CIK0000012345.json');
    expect(h.calls[0]?.headers.get('User-Agent')).toContain('owner@example.com');
    expect(out.filings).toEqual([
      { form: '8-K', filed: '2026-11-01', description: '8-K', items: '2.02', url: 'https://www.sec.gov/Archives/edgar/data/12345/000001234526000101/acme-8k.htm' },
    ]);
    expect(await h.call('sec_filings', { symbol: 'NOPE' })).toMatch(/^unavailable: no SEC filer/);
  });
});

describe('fetch_url and the ledger', () => {
  it('records the page it opened with title, publisher and publication time', async () => {
    const h = harness();
    h.setReply(
      () =>
        new Response(
          '<html><head><title>T</title><meta property="og:title" content="Acme cuts its outlook"><meta property="og:site_name" content="Example News"><meta property="article:published_time" content="2026-11-04T12:00:00Z"></head><body><p>Acme &amp; co lowered guidance.</p><script>x()</script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );
    const out = JSON.parse(await h.call('fetch_url', { url: 'https://news.example.com/acme#top' }));
    expect(out.text).toBe('Acme & co lowered guidance.');
    expect(h.ledger.get('https://news.example.com/acme')).toEqual({
      url: 'https://news.example.com/acme#top',
      title: 'Acme cuts its outlook',
      publisher: 'Example News',
      published_at: '2026-11-04T12:00:00.000Z',
      fetched_at: '2026-11-05T10:00:00.000Z',
    });
  });

  it('refuses private addresses without fetching, and does not record what it cannot read', async () => {
    const h = harness();
    expect(await h.call('fetch_url', { url: 'http://127.0.0.1:7317/api/notes' })).toMatch(/^unavailable: only public/);
    expect(h.calls).toHaveLength(0);
    h.setReply(() => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    expect(await h.call('fetch_url', { url: 'https://example.com/a.pdf' })).toMatch(/cannot be read as text/);
    expect(h.ledger.list()).toEqual([]);
  });
});

describe('seer_price_context', () => {
  it('reads bars only up to the decision night', async () => {
    const asked: string[] = [];
    const bars = (n: number, start: number): Bar[] => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: start - i, volume: 1_000 }));
    const h = harness({
      seer: {
        priceBars: async (symbol, through, limit) => {
          asked.push(`${symbol}|${through}|${limit}`);
          return symbol === 'SPY' ? bars(30, 500) : bars(30, 100);
        },
      },
    });
    const out = JSON.parse(await h.call('seer_price_context'));
    expect(asked.sort()).toEqual(['ACME|2026-11-04|260', 'SPY|2026-11-04|260']);
    expect(out).toMatchObject({ symbol: 'ACME', through: '2026-11-04', last_close: 100, change_5_sessions: 0.0526, vs_200_session_average: null });
  });
});

describe('helpers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-cik-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('maps current tickers to CIKs from Seer’s vendored CSV', async () => {
    const file = path.join(dir, 'ticker_cik.csv');
    writeFileSync(
      file,
      'symbol,cik,start_date,end_date,company_name,source,note\nACME,0000012345,2009-01-01,,"ACME, INC.",current,\nOLD,0000099999,2009-01-01,2015-01-01,OLD CO,manual,\nNOF,NONE,2009-01-01,,FUND,manual,"no filer, ever"\n',
    );
    expect([...(await loadTickerCik(file))]).toEqual([['ACME', '0000012345']]);
    expect((await loadTickerCik(path.join(dir, 'missing.csv'))).size).toBe(0);
  });

  it('spaces calls by the interval', async () => {
    let t = 0;
    const slept: number[] = [];
    const limiter = intervalLimiter(1_000, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(slept).toEqual([1_000, 1_000]);
  });

  it('normalizes URLs and strips pages to text', () => {
    expect(normalizeUrl('https://a.example.com/x/#frag')).toBe('https://a.example.com/x');
    expect(normalizeUrl('not a url')).toBeNull();
    expect(publicHttpUrl('http://192.168.1.5/')).toBeNull();
    expect(publicHttpUrl('file:///etc/passwd')).toBeNull();
    expect(publicHttpUrl('https://www.sec.gov/x')?.hostname).toBe('www.sec.gov');
    expect(htmlToText('<style>a{}</style><p>One</p><p>Two&nbsp;&#8212; three</p>')).toBe('One\nTwo — three');
  });
});
```
**File:** `tests/unit/adversary/agent.test.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { VERDICT_JSON_SCHEMA, createAgentReviewer, finalizeVerdict } from '../../../src/adversary/agent.js';
import { sessionOpenUtc } from '../../../src/adversary/sessions.js';
import { SourceLedger, type ReviewTools } from '../../../src/adversary/tools.js';
import { ReviewFailure, type ReviewContext, type StockReviewer } from '../../../src/adversary/types.js';
import type { QueryFn } from '../../../src/chat/agent.js';

const PAGE = {
  url: 'https://news.example.com/acme-cut',
  title: 'Acme cuts its outlook',
  publisher: 'Example News',
  published_at: '2026-11-04T12:00:00.000Z',
  fetched_at: '2026-11-05T09:00:00.000Z',
};

function ctx(): ReviewContext {
  const pick = { symbol: 'ACME', rank: 1, weight: null, evidence: null };
  return {
    strategy: {
      id: 'T-BRK',
      name: 'TB · Dip test',
      sub: 'Buys a short dip',
      engine: 'bracket',
      rulesId: 'design-v0-gotrade',
      objectName: 'STRATEGY_A',
      gateNote: null,
      promotedFrom: null,
      status: 'active',
      twinOf: null,
      isBenchmark: false,
    },
    lens: { id: 'STRATEGY_A@00000000', text: 'Method: TB' },
    promptVersion: 'adv-v1-000000000000',
    decision: { strategyId: 'T-BRK', sessionDate: '2026-11-06', dataDate: '2026-11-05', kind: 'bracket', stage: 'final', openUtc: sessionOpenUtc('2026-11-06'), picks: [pick] },
    pick,
    held: null,
    now: new Date('2026-11-05T09:00:00Z'),
  };
}

function result(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    stop_reason: null,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'adv-test',
    ...fields,
  } as unknown as SDKMessage;
}

function usageOf(model: string, input: number, output: number): Record<string, unknown> {
  return {
    [model]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000 },
  };
}

function scripted(stages: SDKMessage[][]): { query: QueryFn; calls: Options[] } {
  const calls: Options[] = [];
  const query: QueryFn = ({ options }) => {
    calls.push(options);
    const messages = stages[calls.length - 1] ?? [];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { query, calls };
}

function reviewer(query: QueryFn, opts: { recordPage?: boolean; timeoutMs?: number } = {}): StockReviewer {
  const r = createAgentReviewer({
    claudeBin: process.execPath,
    cwd: path.join(tmpdir(), `mcp-notes-adversary-test-${process.pid}`),
    gatherModel: 'sonnet',
    verdictModel: 'opus',
    gatherMaxTurns: 7,
    timeoutMs: opts.timeoutMs ?? 5_000,
    query,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'must-not-reach-the-child' },
    tools: ({ ledger }): ReviewTools => {
      if (opts.recordPage !== false) ledger.record(PAGE);
      return {
        server: { type: 'sdk', name: 'adversary', instance: {} } as unknown as McpSdkServerConfigWithInstance,
        allowedTools: ['WebSearch', 'mcp__adversary__fetch_url'],
      };
    },
  });
  if (r === null) throw new Error('reviewer not built');
  return r;
}

const GATHERED = result({ result: `Acme cut its outlook on 4 Nov (${PAGE.url}).`, num_turns: 5, total_cost_usd: 0.25, modelUsage: usageOf('claude-sonnet-4-9', 1_000, 300) });
const decided = (structured: unknown): SDKMessage =>
  result({ structured_output: structured, num_turns: 1, total_cost_usd: 0.5, modelUsage: usageOf('claude-opus-5-5', 2_000, 100) });

describe('createAgentReviewer', () => {
  it('gathers with tools, decides with structured output and no tools, and records exact models and usage', async () => {
    const reason = 'Acme lowered its forecast, so the fall is the market re-pricing the company, not a passing dip.';
    const { query, calls } = scripted([[GATHERED], [decided({ verdict: 'object', reason, source_urls: [PAGE.url] })]]);
    const out = await reviewer(query).review(ctx(), new AbortController().signal);
    expect(out.verdict).toEqual({ verdict: 'object', reason, sources: [PAGE] });
    expect(out.downgraded).toBe(false);
    expect(out.usage).toMatchObject({ inputTokens: 1_015 + 2_015, outputTokens: 400, turns: 6, gatherModel: 'claude-sonnet-4-9', verdictModel: 'claude-opus-5-5' });
    expect(out.usage.costUsd).toBeCloseTo(0.75);

    const [gather, verdict] = calls;
    expect(gather).toMatchObject({ model: 'sonnet', tools: ['WebSearch'], maxTurns: 7, persistSession: false, settingSources: [], strictMcpConfig: true });
    expect(gather?.disallowedTools).toContain('WebFetch');
    expect(Object.keys(gather?.mcpServers ?? {})).toEqual(['adversary']);
    expect(gather?.allowedTools).toEqual(['WebSearch', 'mcp__adversary__fetch_url']);
    expect(gather?.outputFormat).toBeUndefined();
    expect(gather?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(verdict).toMatchObject({ model: 'opus', tools: [], allowedTools: [], mcpServers: {} });
    expect(verdict?.outputFormat).toEqual({ type: 'json_schema', schema: VERDICT_JSON_SCHEMA });
  });

  it('turns an objection that cites no fetched page into unsure', async () => {
    const { query } = scripted([[GATHERED], [decided({ verdict: 'object', reason: 'Bad news.', source_urls: [PAGE.url] })]]);
    const out = await reviewer(query, { recordPage: false }).review(ctx(), new AbortController().signal);
    expect(out.downgraded).toBe(true);
    expect(out.verdict.verdict).toBe('unsure');
    expect(out.verdict.sources).toEqual([]);
    expect(out.verdict.reason).toMatch(/^No page that was actually read backs this call/);
    expect(out.verdict.reason.length).toBeLessThanOrEqual(600);
  });

  it('fails a verdict that breaks the schema, keeping what it spent', async () => {
    const { query } = scripted([[GATHERED], [decided({ verdict: 'object', reason: 'x'.repeat(601), source_urls: [] })]]);
    const err = await reviewer(query).review(ctx(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewFailure);
    expect((err as ReviewFailure).message).toMatch(/schema/);
    expect((err as ReviewFailure).usage?.turns).toBe(6);
  });

  it('fails when the gathering stage hits its turn cap', async () => {
    const { query } = scripted([[result({ subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (7)'] })]]);
    await expect(reviewer(query).review(ctx(), new AbortController().signal)).rejects.toThrow(/maximum number of turns/);
  });

  it('gives up after the per-stock timeout', async () => {
    const hang: QueryFn = ({ options }) =>
      (async function* () {
        await new Promise<never>((_, reject) => options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      })();
    await expect(reviewer(hang, { timeoutMs: 30 }).review(ctx(), new AbortController().signal)).rejects.toThrow(/no verdict within/);
  });

  it('is not built without a claude binary', () => {
    expect(
      createAgentReviewer({
        claudeBin: '/nonexistent/claude',
        cwd: tmpdir(),
        gatherModel: 'sonnet',
        verdictModel: 'opus',
        gatherMaxTurns: 1,
        timeoutMs: 1,
        tools: () => {
          throw new Error('unused');
        },
      }),
    ).toBeNull();
  });
});

describe('finalizeVerdict', () => {
  it('matches citations to the ledger ignoring fragments and trailing slashes, once each', () => {
    const ledger = new SourceLedger();
    ledger.record(PAGE);
    const out = finalizeVerdict({ verdict: 'agree', reason: ' Fine. ', source_urls: [`${PAGE.url}/`, `${PAGE.url}#x`, 'https://never.example.com/'] }, ledger);
    expect(out).toEqual({ verdict: { verdict: 'agree', reason: 'Fine.', sources: [PAGE] }, downgraded: false });
  });
});
```
**Impact:** unit suite grows by 7 files; all run in `npm test` (node environment, no network, no DB).

### Step 16: Integration tests on the rebuilt Seer schema
**File:** `tests/integration/adversary/harness.ts` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs';
import { describe } from 'vitest';
import { migrationFiles, siblingRepo } from '../connectors/siblings.js';

/**
 * The reviewer's integration tests need Seer migration 027. Until phase 7 lands Seer, run them with
 * SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial (plan invariant 8); against a Seer
 * checkout without the migration they skip with that reason, so the suite stays green.
 */
export function seerHasAdversarySchema(): boolean {
  const repo = siblingRepo('seer');
  if (repo === null) return false;
  return migrationFiles('seer', repo).some((file) => /CREATE TABLE\s+(IF NOT EXISTS\s+)?adversary_verdicts\b/i.test(readFileSync(file, 'utf8')));
}

export function describeWithAdversarySchema(name: string, fn: () => void): void {
  if (seerHasAdversarySchema()) {
    describe(name, fn);
    return;
  }
  describe.skip(`${name} [skipped: the Seer repository at SEER_DIR has no adversary_verdicts migration; set SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial]`, fn);
}
```
**File:** `tests/integration/adversary/reviewer.int.test.ts` (new)
**Code:**
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AdversaryChange } from '../../../src/adversary/events.js';
import { SeerReader } from '../../../src/adversary/seerReader.js';
import { SeerWriter } from '../../../src/adversary/seerWriter.js';
import { AdversaryService } from '../../../src/adversary/service.js';
import { addDays, utcDate } from '../../../src/adversary/sessions.js';
import { DEFAULT_ADVERSARY_CONFIG, type AdversaryConfig } from '../../../src/config.js';
import { createConnector } from '../../../src/connectors/connector.js';
import type { Db } from '../../../src/db/client.js';
import { adversaryReviews } from '../../../src/db/schema.js';
import { fakeReviewer, type FakeReviewer } from '../../helpers/fakeReviewer.js';
import { seedSystem, systemDbUrl, truncateSystem, withAdmin } from '../connectors/harness.js';
import { closeTestDb, openTestDb, truncateAll } from '../setup.js';
import { describeWithAdversarySchema } from './harness.js';

const BRK = 'T-BRK';
const BOOK = 'T-BOOK';
const S1 = '2031-01-14';
const D1 = '2031-01-13';
const OPEN_S1 = '2031-01-14T14:30:00Z';

/** Test roster only: two twinned originals (contract C2 shape) and one active original without a twin. */
const ROSTER_SEED = `
INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, gate_applicable, status, twin_of) VALUES
  ('T-BRK', 'TB · Dip test', 'Buys a short dip, test row', 'zap', 1, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'test row', true, 'active', NULL),
  ('T-BOOK', 'TK · Book test', 'Holds a monthly basket, test row', 'zap', 2, 'book', 'monthly-hold-frac-gotrade', 'RESIDMOM35', 'test row', true, 'active', NULL),
  ('T-LONE', 'TL · No twin', 'Active, never twinned', 'zap', 3, 'book', 'monthly-hold-frac-gotrade', 'COSKEW', 'test row', true, 'active', NULL);
INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, gate_applicable, status, twin_of, is_champion, is_benchmark) VALUES
  ('T-BRK-CX', 'TB+Claude · Dip test', 'Buys a short dip, test row', 'zap', 4, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'active', 'T-BRK', false, false),
  ('T-BOOK-CX', 'TK+Claude · Book test', 'Holds a monthly basket, test row', 'zap', 5, 'book', 'monthly-hold-frac-gotrade', 'RESIDMOM35', 'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'active', 'T-BOOK', false, false);
`;

let db: Db;
let repoDir: string;

async function seer<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withAdmin(systemDbUrl('seer'), async (c) => (await c.query<T>(sql, params)).rows);
}

async function seedCandidates(strategyId: string, sessionDate: string, dataDate: string, kind: 'bracket' | 'book', symbols: string[]): Promise<void> {
  const rows = symbols.map(
    (symbol, i) => `('${strategyId}', '${sessionDate}', '${dataDate}', '${kind}', ${i + 1}, '${symbol}', ${kind === 'book' ? (1 / symbols.length).toFixed(6) : 'NULL'})`,
  );
  await seedSystem('seer', `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight) VALUES ${rows.join(', ')}`);
}

function makeService(host: string, reviewer: FakeReviewer, options: { now?: () => Date; config?: Partial<AdversaryConfig> } = {}): AdversaryService {
  return new AdversaryService({
    config: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true, ...options.config },
    db,
    host,
    reviewer,
    seer: new SeerReader(createConnector('seer', { repoDir, settings: { envFile: false } })),
    writer: new SeerWriter({ repoDir: () => repoDir }),
    now: options.now,
    log: () => {},
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describeWithAdversarySchema('Seer Adversarial reviewer against the Seer schema rebuilt from its migrations', () => {
  beforeAll(() => {
    db = openTestDb();
    repoDir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-adversary-seer-'));
    writeFileSync(path.join(repoDir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('seer')}\n`);
  });

  afterAll(async () => {
    await closeTestDb(db);
    rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await truncateSystem('seer');
    await seedSystem('seer', ROSTER_SEED);
  });

  it('reviews every due pick of a twinned original once and writes verdicts the engine can read', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    await seedCandidates('T-LONE', S1, D1, 'book', ['ZZZ']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);

    const first = await svc.reviewNow();
    expect(first.error).toBeNull();
    expect(first.reviewed).toBe(2);
    expect(reviewer.calls.map((c) => c.pick.symbol)).toEqual(['AAA', 'BBB']);

    const rows = await seer(
      `SELECT strategy_id, session_date::text AS session_date, symbol, verdict, host, model, prompt_version, lens,
              jsonb_array_length(sources) AS n_sources, decided_at < $1::timestamptz AS before_open, superseded_by
       FROM adversary_verdicts ORDER BY symbol`,
      [OPEN_S1],
    );
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    for (const r of rows) {
      expect(r).toMatchObject({ strategy_id: BRK, session_date: S1, verdict: 'object', host: 'lenovo', model: 'claude-opus-test', n_sources: 1, before_open: true, superseded_by: null });
      expect(String(r.prompt_version)).toMatch(/^adv-v1-[0-9a-f]{12}$/);
      expect(String(r.lens)).toMatch(/^STRATEGY_A@[0-9a-f]{8}$/);
    }

    const logged = await db.select().from(adversaryReviews);
    expect(logged.map((r) => `${r.symbol}:${r.stage}:${r.status}`).sort()).toEqual(['AAA:final:ok', 'BBB:final:ok']);
    expect(logged.every((r) => typeof r.verdict?.seer_verdict_id === 'number' && r.inputTokens === 1_200 && r.host === 'lenovo')).toBe(true);

    const second = await svc.reviewNow();
    expect(second.reviewed).toBe(0);
    expect(reviewer.calls).toHaveLength(2);
    expect(await seer('SELECT * FROM adversary_leases')).toHaveLength(0);
  });

  it('lets only one of two hosts review a decision while its lease is held', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const gate = deferred();
    const lenovoReviewer = fakeReviewer({ gate: gate.promise });
    const gpdReviewer = fakeReviewer();
    const lenovo = makeService('lenovo', lenovoReviewer);
    const gpd = makeService('gpd', gpdReviewer);

    const lenovoRun = lenovo.reviewNow();
    await waitFor(() => lenovoReviewer.calls.length === 1);
    expect(await seer('SELECT host, expires_at > now() AS live FROM adversary_leases')).toEqual([{ host: 'lenovo', live: true }]);

    const gpdRun = await gpd.reviewNow();
    expect(gpdRun).toMatchObject({ leases_lost: 1, reviewed: 0 });
    expect(gpdReviewer.calls).toHaveLength(0);

    gate.resolve();
    expect((await lenovoRun).reviewed).toBe(2);
    expect((await seer<{ host: string }>('SELECT DISTINCT host FROM adversary_verdicts')).map((r) => r.host)).toEqual(['lenovo']);
    expect(await seer('SELECT * FROM adversary_leases')).toHaveLength(0);
  });

  it('takes over a lease another host let expire, judged by the database clock', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    await seedSystem(
      'seer',
      `INSERT INTO adversary_leases (strategy_id, session_date, host, claimed_at, expires_at) VALUES ('${BRK}', '${S1}', 'ghost', now() - interval '1 hour', now() + interval '1 hour')`,
    );
    const svc = makeService('gpd', fakeReviewer());
    expect((await svc.reviewNow()).leases_lost).toBe(1);

    await seedSystem('seer', `UPDATE adversary_leases SET expires_at = now() - interval '1 minute' WHERE host = 'ghost'`);
    expect((await svc.reviewNow()).reviewed).toBe(1);
    expect((await seer<{ host: string }>('SELECT host FROM adversary_verdicts')).map((r) => r.host)).toEqual(['gpd']);
  });

  it('never starts a review once the session has opened', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    const reviewer = fakeReviewer();
    const run = await makeService('lenovo', reviewer, { now: () => new Date('2031-01-14T15:00:00Z') }).reviewNow();
    expect(run.reviewed).toBe(0);
    expect(reviewer.calls).toHaveLength(0);
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(0);
  });

  it('keeps a verdict that lands after the open, logged late (the engine ignores it)', async () => {
    await seedCandidates(BRK, '2026-01-06', '2026-01-05', 'bracket', ['AAA']);
    const run = await makeService('lenovo', fakeReviewer(), { now: () => new Date('2026-01-06T13:00:00Z') }).reviewNow();
    expect(run).toMatchObject({ reviewed: 1, late: 1 });
    expect(await seer(`SELECT decided_at < '2026-01-06T14:30:00Z'::timestamptz AS before_open FROM adversary_verdicts`)).toEqual([{ before_open: false }]);
    expect((await db.select().from(adversaryReviews)).map((r) => r.status)).toEqual(['late']);
  });

  it('writes one paused mark per due decision while auto runs are off, and reviews only on demand', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    await seedCandidates(BOOK, S1, D1, 'book', ['KKK', 'LLL']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);
    const seen: AdversaryChange[] = [];
    svc.events.on((c) => seen.push(c));

    expect(await svc.setToggle(false, 'lenovo')).toMatchObject({ on: false, host: 'lenovo' });
    expect((await svc.getToggle()).on).toBe(false);

    const auto = await svc.pollNow();
    expect(auto.marks).toBe(2);
    expect(reviewer.calls).toHaveLength(0);
    expect(await seer('SELECT strategy_id, session_date::text AS session_date, mark, host FROM adversary_marks ORDER BY strategy_id')).toEqual([
      { strategy_id: BOOK, session_date: S1, mark: 'paused', host: 'lenovo' },
      { strategy_id: BRK, session_date: S1, mark: 'paused', host: 'lenovo' },
    ]);
    expect(seen).toEqual(
      expect.arrayContaining([
        { type: 'adversary', op: 'toggle' },
        { type: 'adversary', op: 'run' },
        { type: 'adversary', op: 'mark', strategy_id: BRK, session_date: S1 },
      ]),
    );
    expect((await svc.pollNow()).marks).toBe(0);

    const manual = await svc.reviewNow();
    expect(manual.reviewed).toBe(3);
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(3);
    expect(seen.filter((c) => c.op === 'verdict')).toHaveLength(3);
  });

  it('stops at the daily cap with bracket picks first, and logs each skipped pick once a day', async () => {
    await seedCandidates(BOOK, '2031-01-10', '2031-01-09', 'book', ['KKK']);
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer, { config: { dailyCap: 2 } });

    expect(await svc.reviewNow()).toMatchObject({ reviewed: 2, skipped_budget: 1 });
    expect(reviewer.calls.map((c) => c.pick.symbol)).toEqual(['AAA', 'BBB']);
    expect(await svc.reviewNow()).toMatchObject({ reviewed: 0, skipped_budget: 0 });
    const skipped = (await db.select().from(adversaryReviews)).filter((r) => r.status === 'skipped_budget');
    expect(skipped.map((r) => r.symbol)).toEqual(['KKK']);
    expect((await svc.status()).used_today).toBe(2);
  });

  it('drafts a book preview early, then reuses the draft when the real targets appear', async () => {
    const today = utcDate(new Date());
    const next = addDays(today, 3);
    await seedSystem(
      'seer',
      `INSERT INTO book_previews (strategy_id, data_date, rank, symbol, weight, last, next_decision_session) VALUES
         ('${BOOK}', '${today}', 1, 'PPP', 0.5, 10, '${next}'), ('${BOOK}', '${today}', 2, 'QQQ', 0.5, 20, '${next}')`,
    );
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);

    expect(await svc.reviewNow()).toMatchObject({ drafted: 2, reviewed: 0 });
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(0);
    expect(await svc.reviewNow()).toMatchObject({ drafted: 0 });

    await seedCandidates(BOOK, next, today, 'book', ['PPP', 'QQQ', 'RRR']);
    expect(await svc.reviewNow()).toMatchObject({ reused: 2, reviewed: 1, drafted: 0 });
    expect(reviewer.calls.map((c) => `${c.decision.stage}:${c.pick.symbol}`)).toEqual(['draft:PPP', 'draft:QQQ', 'final:RRR']);

    const verdicts = await seer<{ symbol: string; prompt_version: string }>('SELECT symbol, prompt_version FROM adversary_verdicts ORDER BY symbol');
    expect(verdicts.map((v) => v.symbol)).toEqual(['PPP', 'QQQ', 'RRR']);
    expect(new Set(verdicts.map((v) => v.prompt_version)).size).toBe(1);
    const finals = (await db.select().from(adversaryReviews)).filter((r) => r.stage === 'final');
    expect(finals.filter((r) => r.reusedFrom !== null).map((r) => r.symbol).sort()).toEqual(['PPP', 'QQQ']);
    expect((await svc.status()).used_today).toBe(3);
  });

  it('re-reviewing supersedes the old verdict and keeps it on the record', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    const svc = makeService('lenovo', fakeReviewer());
    await svc.reviewNow();
    expect((await svc.reviewNow({ strategyId: BRK, sessionDate: S1, rereview: true })).reviewed).toBe(1);
    const rows = await seer<{ id: string; superseded_by: string | null }>('SELECT id::text AS id, superseded_by::text AS superseded_by FROM adversary_verdicts ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_by).toBe(rows[1]?.id);
    expect(rows[1]?.superseded_by).toBeNull();
  });

  it('records a failed review and keeps going with the next pick', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const svc = makeService('lenovo', fakeReviewer({ fail: (c) => (c.pick.symbol === 'AAA' ? 'the model ran out of turns' : null) }));
    expect(await svc.reviewNow()).toMatchObject({ failed: 1, reviewed: 1 });
    const logged = await db.select().from(adversaryReviews);
    expect(logged.find((r) => r.symbol === 'AAA')).toMatchObject({ status: 'failed', error: 'the model ran out of turns', inputTokens: 1_200 });
    expect((await seer<{ symbol: string }>('SELECT symbol FROM adversary_verdicts')).map((r) => r.symbol)).toEqual(['BBB']);
  });
});
```
**Impact:** runs only under `npm run test:int`; skips (green) when `SEER_DIR` lacks migration 027.
Seer tests and these share `connectors_seer` and truncate it; files run one at a time
(`fileParallelism: false` under integration).

### Step 17: verify-notesd: keep throwaway daemons off real Seer, and add a sandboxed reviewer
**File:** `.claude/skills/verify-notesd/scripts/verify.sh` (header usage lines 7-19, `cmd_up` lines 69-150, new `cmd_exec`, `stop_run` lines 236-250, dispatch lines 270-283)
**Change:** with the reviewer ON by default, a plain `verify.sh up` would read the owner's real
Seer (through `~/seer/.env.local`) and review it. Pin `NOTESD_ADVERSARY=off` for every run, and add
`up --adversary`, which builds a throwaway Seer database in the verify container from
`${SEER_DIR:-$HOME/seer}/db/migrations` and points the daemon's `SEER_DIR` at a temp dir whose
`.env.local` names it (plus only the three data-tool keys copied from `~/seer/.env.local`, and
Seer's `ticker_cik.csv`). Add `exec RUN [--seer] SQL` to seed the run's throwaway databases.
**Code:** in the usage header, replace the `up` line pair and add `exec`:
```bash
#   verify.sh up [--web] [--embed] [--sessions] [--adversary]
#                                       start an instance from the current checkout; prints RUN= and URL=
#                                       --sessions seeds CLAUDE_HOME from tests/fixtures/claude-home
#                                       --adversary turns the Seer reviewer on against a throwaway Seer DB
#                                       built from ${SEER_DIR:-~/seer}/db/migrations (reviews are real, billed)
#   verify.sh exec RUN [--seer] "SQL"   WRITE to the run's throwaway notes DB (or its Seer DB); saved as evidence
```
Replace `cmd_up` with:
```bash
cmd_up() {
  local web=0 embed=0 sessions=0 adversary=0
  for a in "$@"; do
    case "$a" in
      --web) web=1 ;;
      --embed) embed=1 ;;
      --sessions) sessions=1 ;;
      --adversary) adversary=1 ;;
      *) die "up: unknown flag $a" ;;
    esac
  done
  local root run dir db
  root="$(repo_root)"
  [ -f "$root/package.json" ] && grep -q '"name": "mcp-notes"' "$root/package.json" || die "$root is not an mcp-notes checkout"
  [ -x "$root/node_modules/.bin/tsx" ] || die "no node_modules in $root; run npm ci there first"
  if [ "$web" = 1 ] || [ ! -f "$root/web/dist/index.html" ]; then
    echo "verify: building web/ ($root)" >&2
    (cd "$root" && npm run -s build:web >/dev/null) || die "web build failed"
  fi

  run="$(date +%m%d-%H%M%S)-$$"
  dir="$VERIFY_HOME/$run"
  db="v_$(echo "$run" | tr -- '-' '_')"
  mkdir -p "$dir/evidence" "$dir/data" "$dir/claude/projects" "$dir/claude/sessions"
  [ "$sessions" = 1 ] && cp -r "$root/tests/fixtures/claude-home/." "$dir/claude/"

  ensure_pg
  psql_run -c "create database $db" >/dev/null
  echo "$db" >"$dir/db"
  (cd "$root" && DATABASE_URL="$(db_url "$db")" node --input-type=module -e "
    import pg from 'pg'
    import { drizzle } from 'drizzle-orm/node-postgres'
    import { migrate } from 'drizzle-orm/node-postgres/migrator'
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.end()
  ") || die "migration failed (db $db kept for inspection; verify.sh down $run)"

  # --adversary: a throwaway Seer DB from the Seer checkout's own migrations; never the real one.
  local seer_src="${SEER_DIR:-$HOME/seer}"
  if [ "$adversary" = 1 ]; then
    [ -d "$seer_src/db/migrations" ] || die "--adversary: no Seer migrations at $seer_src/db/migrations (set SEER_DIR)"
    local sdb f
    sdb="s_$(echo "$run" | tr -- '-' '_')"
    psql_run -c "create database $sdb" >/dev/null
    echo "$sdb" >"$dir/seer_db"
    for f in "$seer_src"/db/migrations/*.sql; do
      psql_run -d "$sdb" <"$f" >/dev/null || die "--adversary: Seer migration $(basename "$f") failed (verify.sh down $run)"
    done
    mkdir -p "$dir/seer/engine/data"
    {
      echo "DATABASE_URL_UNPOOLED=$(db_url "$sdb")"
      if [ -f "$HOME/seer/.env.local" ]; then
        grep -E '^(FINNHUB_API_KEY|MASSIVE_API_KEY|SEC_CONTACT_EMAIL)=' "$HOME/seer/.env.local" || true
      fi
    } >"$dir/seer/.env.local"
    chmod 600 "$dir/seer/.env.local"
    if [ -f "$seer_src/engine/data/ticker_cik.csv" ]; then cp "$seer_src/engine/data/ticker_cik.csv" "$dir/seer/engine/data/"; fi
  fi

  # Real env wins over .env.local, so these pin the instance to the run's own state.
  # OPENROUTER_API_KEY='' turns embeddings off (search reports fallback) unless --embed.
  # NOTESD_ADVERSARY=off unless --adversary: a throwaway daemon never reviews the owner's real Seer.
  local -a env=(
    DATABASE_URL="$(db_url "$db")"
    NOTESD_PORT=0
    NOTES_DATA_DIR="$dir/data"
    CLAUDE_HOME="$dir/claude"
    NOTES_WORKTREES_DIR="$dir/worktrees"
    NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"
  )
  [ "$embed" = 1 ] || env+=(OPENROUTER_API_KEY=)
  if [ "$adversary" = 1 ]; then
    env+=(NOTESD_ADVERSARY=on SEER_DIR="$dir/seer" ADVERSARY_POLL_MS="${ADVERSARY_POLL_MS:-5000}")
  else
    env+=(NOTESD_ADVERSARY=off)
  fi
  {
    echo "repo=$root"
    echo "head=$(git -C "$root" rev-parse --short HEAD)"
    echo "dirty=$(git -C "$root" status --porcelain | wc -l)"
    echo "embed=$embed"
    echo "adversary=$adversary"
    [ "$adversary" = 1 ] && echo "seer_migrations=$seer_src"
  } >"$dir/meta"

  # setsid leads its own process group (so `down` kills exactly this tree), and every fd is
  # redirected so no caller's pipe stays open behind the daemon.
  cd "$root"
  setsid env "${env[@]}" node_modules/.bin/tsx src/main.ts </dev/null >"$dir/daemon.log" 2>&1 &
  echo $! >"$dir/pid"
  local port=""
  for _ in $(seq 1 60); do
    port="$(sed -nE 's#.*listening on http://127\.0\.0\.1:([0-9]+).*#\1#p' "$dir/daemon.log" | head -1)"
    [ -n "$port" ] && break
    kill -0 "$(cat "$dir/pid")" 2>/dev/null || { tail -20 "$dir/daemon.log" >&2; die "daemon exited during startup (verify.sh down $run)"; }
    sleep 0.5
  done
  [ -n "$port" ] || die "daemon did not report a port in 30s (log: $dir/daemon.log)"
  echo "$port" >"$dir/port"
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null || die "health check failed on $port"
  echo "RUN=$run"
  echo "URL=http://127.0.0.1:$port"
  echo "EVIDENCE=$dir/evidence"
  echo "LOG=$dir/daemon.log"
}
```
Add after `cmd_sql`:
```bash
cmd_exec() {
  local dir db target=notes out
  dir="$(run_dir "${1:-}")"; shift
  if [ "${1:-}" = --seer ]; then target=seer; shift; fi
  if [ "$target" = seer ]; then
    [ -f "$dir/seer_db" ] || die "exec --seer: this run was not started with --adversary"
    db="$(cat "$dir/seer_db")"
  else
    db="$(cat "$dir/db")"
  fi
  out="$(next_evidence "$dir" "exec-$target" query txt)"
  { echo "> [$target] ${1:?SQL}"; printf '%s;\n' "$1" | psql_run -d "$db" 2>&1; } | tee "$out"
  echo "[evidence: $out]" >&2
}
```
In `stop_run`, after the notes-DB drop block, add:
```bash
  if [ -f "$dir/seer_db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/seer_db") with (force)" >/dev/null || true
  fi
```
and change its `rm -rf` line to:
```bash
  rm -rf "$dir/data" "$dir/claude" "$dir/worktrees" "$dir/seer" "$dir/pid" "$dir/port" "$dir/db" "$dir/seer_db"
```
In the dispatch `case`, after `sql) cmd_sql "$@" ;;` add:
```bash
  exec) cmd_exec "$@" ;;
```
and change the usage fallback `sed -n '2,20p'` to `sed -n '2,23p'` (three header lines were added).
**File:** `.claude/skills/verify-notesd/SKILL.md` (Launch block and Drive table)
**Change:** in the Launch code block add the line
`$V up --adversary   # Seer reviewer ON against a throwaway Seer DB built from ${SEER_DIR:-~/seer}/db/migrations`.
Under the paragraph that starts "Each run gets its own database", add:
"Every run pins `NOTESD_ADVERSARY=off`, so a throwaway daemon never reads or writes the owner's
real Seer. `--adversary` turns the reviewer on against its own Seer database (`s_<run>` in the same
container) and a temp `SEER_DIR` that holds only that URL, the three data-tool keys from
`~/seer/.env.local` and Seer's `ticker_cik.csv`; `ADVERSARY_POLL_MS` (default 5000 here) and any
other `ADVERSARY_*` key in your shell pass through. A review it runs is a real, billed Agent SDK
run: set the toggle off first (`exec`, below) unless the journey means to pay."
In the Drive table add the row:
`| Seed | \`$V exec RUN [--seer] "SQL"\` | WRITES to the run's throwaway notes DB, or with \`--seer\` its Seer DB (\`--adversary\` runs). For seeding only; prove state with \`sql\`. |`
**Impact:** existing journeys unchanged except that their daemons now log
`adversary off: NOTESD_ADVERSARY=off`.

### Step 18: Feature map entry
**File:** `.claude/skills/verify-notesd/features/adversary.md` (new), `.claude/skills/verify-notesd/features/README.md` (table)
**Change:** add the entry for the reviewer (phases 5 and 6 extend it with the API/MCP and the wall
page; this phase owns only the "Reviewer" bullets). README row after the Chat row:
`| Seer Adversarial: reviewer, verdicts in Seer, toggle, budget | [adversary.md](adversary.md) | background job (`up --adversary`), Seer DB |`
**Code:**
```markdown
# Seer Adversarial

## Sub-features
- Reviewer (phase 4). A background job in notesd (`NOTESD_ADVERSARY`, default on) polls Seer's DB
  every `ADVERSARY_POLL_MS` for decisions of every active original that has an active `-CX` twin:
  bracket candidates and book rank/kickoff targets in `strategy_candidates`, and early looks at a
  book's next rebalance in `book_previews.next_decision_session` (within 7 days). It never reads a
  hard-coded strategy id.
- One host per decision: a lease row in Seer's `adversary_leases` (expiry by the Seer DB clock);
  a second daemon skips a leased decision and takes over an expired lease.
- Each stock: a gathering run (default `sonnet`) with Seer price context (no network), Finnhub,
  Massive news, SEC filings, WebSearch and `fetch_url`; then a verdict run (default `opus`, no
  tools, structured output). agree/object must cite a page `fetch_url` opened, else it is stored as
  `unsure`. The verdict lands in Seer's `adversary_verdicts` with `decided_at` = Seer DB time; one
  that lands after the session's 09:30 New York open is kept but logged `late` (the engine ignores it).
- Every attempt is a row in mcp-notes `adversary_reviews` (tokens, cost, turns, models, host,
  status `ok`/`failed`/`skipped_budget`/`late`, stage `draft`/`final`). A daily cap
  (`ADVERSARY_DAILY_CAP`, default 15 per WIB day, both machines) reviews bracket picks first, then
  books by earliest open, previews last; picks over the cap get one `skipped_budget` row a day and
  stay absent. A draft from a preview is reused, at no cost, when the real targets appear.
- ON/OFF toggle: `app_settings` key `adversary.auto` `{on, changed_at, host}`, absent = on. While
  off, automatic passes write one `paused` mark per due decision (Seer `adversary_marks`) and review
  nothing; "review now" (`AdversaryService.reviewNow`, phase 5's API) still reviews.
- Before Seer migration 027 exists the job logs "Seer's database has no adversary tables yet" and idles.

## How to get to it (user POV)
- Nothing on the wall yet (phase 6). The owner sees it in Seer: verdict rows for tonight's picks,
  and twins that skip objected stocks. The daemon log says `adversary reviewer on as <host>`.

## Driving it with verify.sh
- `SEER_DIR=<seer checkout with migration 027> $V up --adversary` builds a throwaway Seer DB and
  turns the reviewer on against it. Seed with `$V exec RUN --seer "..."` (a twinned original in
  `strategies` + its `strategy_candidates`), read results with `$V exec RUN --seer "select ..."` and
  `$V sql RUN "select ... from adversary_reviews"`.
- Free journey (no model call): set the toggle off FIRST with
  `$V exec RUN "insert into app_settings (key, value) values ('adversary.auto', '{\"on\": false, \"changed_at\": \"2026-11-05T00:00:00Z\", \"host\": \"verify\"}'::jsonb)"`,
  then seed; within a few polls Seer's `adversary_marks` has one `paused` row per due decision.
- Paid journey: leave the toggle absent, seed one twinned bracket original with two real symbols
  for a session a few days ahead, start with `ADVERSARY_DAILY_CAP=1`; expect one verdict row and one
  `skipped_budget` row. Costs one Sonnet gathering run plus one Opus verdict.

## Gotchas
- A plain `$V up` pins `NOTESD_ADVERSARY=off`; only `--adversary` turns it on, and only against the
  throwaway Seer DB.
- Seed the toggle before the roster: the first poll runs within `ADVERSARY_POLL_MS` of `up`.
- `strategy_candidates` rows for a session whose open has passed are never reviewed (cutoff).
- The integration tests (`tests/integration/adversary`) need `SEER_DIR` pointing at a Seer checkout
  with migration 027, else they skip with that reason.
```
**Impact:** docs only.

## Principles applied

- Boundary discipline: env parsed once in `parseAdversary` (Step 1); Seer rows normalised to typed
  values once in `SeerReader` (Step 9); model output validated once with zod in the agent (Step 12a);
  URLs checked once in `fetch_url` (`publicHttpUrl`). Inside the service nothing re-validates.
- Make illegal states unrepresentable: `PlannedAction` is a discriminated union (only `reuse`
  carries a draft, `skip_budget` carries no supersede id); `SeerWriter` exposes typed methods only,
  no generic `query`, and every statement passes the `assertWritable` allow-list (Step 10); the
  reader holds only a `ReadOnlySource`, so it cannot write.
- Laziness protocol (reuse over new): reads go through the existing read-only connector and lab
  reader (`createConnector('seer')`), the writer reuses `loadDatabaseTarget`/`scrub`, the agent reuses
  `QueryFn`, `claudeEnv`, `findClaudeBin`, the toggle reuses `SessionsRepo.putSetting`, and
  `adversary_reviews` doubles as the usage log (no separate usage table).
- Build the lever: a sed codemod adds the new required `Config.adversary` / `AppDeps.adversary`
  fields to ~10 hand-built test literals and `npm run typecheck` proves none was missed (Step 13);
  `verify.sh up --adversary` + `exec` make the reviewer drivable by any verifier (Step 17).
- Encode lessons in structure: with the reviewer on by default, a throwaway or live-test daemon
  would read the owner's real Seer; `verify.sh` and `tests/live/chat.live.test.ts` now pin
  `NOTESD_ADVERSARY=off`, and `DEFAULT_ADVERSARY_CONFIG.enabled` is false with a test asserting it.
- Test behavior, not implementation: integration tests drive `AdversaryService`'s public API
  against real Postgres with the real Seer schema and assert rows a user (or the engine) would read;
  tools are tested through their handlers with a fake `fetch`; the agent through the `QueryFn` seam.
- Prove it works: the Proof drives a real daemon (free paused-mark journey and one paid real review).

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && npm run typecheck && npm run build`
**Tests:**
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
npm test
SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial npm run test:int
```
(`test:int` with the Seer worktree builds `connectors_seer` from migrations 001-027; the
`tests/integration/adversary` file must report 10 passing tests, not skipped. Without `SEER_DIR`
it must also be green, with the adversary file skipped and its reason in the name.)

**Proof:** a real notesd daemon from this worktree, with the reviewer on against a throwaway Seer DB.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`), extended in Step 17.
- Feature-map entries: `features/adversary.md` (new, reviewer section).
- Setup for every journey: `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && V=.claude/skills/verify-notesd/scripts/verify.sh`.
  Seed SQL used below (save as `$SCRATCH/roster.sql`, where `$SCRATCH` is your scratchpad; `S` is a
  session 3 days ahead and `D` today, both UTC):
  ```sh
  S=$(date -u -d '+3 days' +%F); D=$(date -u +%F)
  ROSTER="INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, gate_applicable, status, twin_of) VALUES
    ('V-BRK', 'VB · Dip check', 'Buys a short dip in a long rise, sells within five sessions', 'zap', 90, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'verify row', true, 'active', NULL),
    ('V-BRK-CX', 'VB+Claude · Dip check', 'Buys a short dip in a long rise, sells within five sessions', 'zap', 91, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'Claude twin', false, 'active', 'V-BRK')"
  CANDS="INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight) VALUES
    ('V-BRK', '$S', '$D', 'bracket', 1, 'AAPL', NULL), ('V-BRK', '$S', '$D', 'bracket', 2, 'MSFT', NULL)"
  ```
- Journey 1 (safety, free): a plain run never reviews.
  `$V up` -> `RUN`, `LOG`; then `grep -c 'adversary off: NOTESD_ADVERSARY=off' "$LOG"` prints `1`;
  `$V down $RUN`.
- Journey 2 (idle before Seer 027, free): build a migrations copy without 027 and start against it:
  `mkdir -p $SCRATCH/seer-026/db && cp -r /home/miftah/.worktrees/seer/seer-adversarial/db/migrations $SCRATCH/seer-026/db/ && rm $SCRATCH/seer-026/db/migrations/027_*.sql`,
  `SEER_DIR=$SCRATCH/seer-026 $V up --adversary`; within 15 s
  `grep -c "Seer's database has no adversary tables yet" "$LOG"` prints `1` and `$V doctor $RUN`
  reports `process ok` and `health ok`. `$V down $RUN`.
- Journey 3 (toggle off writes paused marks, free):
  `SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial $V up --adversary`; then FIRST
  `$V exec $RUN "insert into app_settings (key, value) values ('adversary.auto', '{\"on\": false, \"changed_at\": \"2026-11-05T00:00:00Z\", \"host\": \"verify\"}'::jsonb)"`,
  then `$V exec $RUN --seer "$ROSTER"` and `$V exec $RUN --seer "$CANDS"`; poll
  `for i in $(seq 1 30); do $V exec $RUN --seer "select count(*) from adversary_marks" | grep -qE '^ +1$' && break; sleep 2; done`.
  Pass: `$V exec $RUN --seer "select strategy_id, session_date, mark from adversary_marks"` shows
  exactly one row `V-BRK | $S | paused`; `$V exec $RUN --seer "select count(*) from adversary_verdicts"`
  shows `0`; `$V sql $RUN "select count(*) from adversary_reviews"` shows `0`; the log has no
  `-> object|agree|unsure` line. `$V down $RUN`.
- Journey 4 (one real review, cap respected, PAID):
  `ADVERSARY_DAILY_CAP=1 SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial $V up --adversary`;
  `$V exec $RUN --seer "$ROSTER"`; `$V exec $RUN --seer "$CANDS"`; wait up to 15 min:
  `for i in $(seq 1 180); do $V exec $RUN --seer "select count(*) from adversary_verdicts" | grep -qE '^ +1$' && break; sleep 5; done`.
  Pass, all of:
  `$V exec $RUN --seer "select symbol, verdict, char_length(reason) <= 600 as short, jsonb_array_length(sources) as n_sources, model, prompt_version, lens, decided_at < (('$S'::date + time '09:30') at time zone 'America/New_York') as before_open from adversary_verdicts"`
  shows one row for `AAPL`, `verdict` in agree/object/unsure, `short = t`, `model` starting
  `claude-opus`, `prompt_version` like `adv-v1-` + 12 hex, `lens` like `STRATEGY_A@` + 8 hex,
  `before_open = t`, and `n_sources >= 1` unless the verdict is `unsure`;
  `$V sql $RUN "select symbol, stage, status, input_tokens > 0 as billed, cost_usd > 0 as costed, gather_model, verdict_model, host from adversary_reviews order by symbol"`
  shows `AAPL | final | ok | t | t | claude-sonnet… | claude-opus… | <hostname>` and
  `MSFT | final | skipped_budget | f | f`;
  `$V exec $RUN --seer "select count(*) from adversary_leases"` shows `0`;
  `grep -E 'adversary: V-BRK .* AAPL -> (agree|object|unsure)' "$LOG"` matches. `$V note $RUN "..."`
  each claim, then `$V down $RUN`.
- Neighbor check: the whole `npm run test:int` (sessions, chat, connectors, notes) stays green with
  the new required fields, and Journey 1's daemon serves `$V api $RUN GET /health` = 200 and
  `$V mcp $RUN list '{}'` returns notes as before.
- Cost: Journey 4 only, one review: a Sonnet gathering run (<= 20 turns, a few web pages) plus one
  Opus verdict, roughly $0.50 to $3 on the owner's subscription. Journeys 1 to 3 make no model call.

**Exit criteria:** typecheck, `npm test` and `SEER_DIR=<seer worktree> npm run test:int` green with
the 10 adversary integration tests passing; Journeys 1 to 3 pass; Journey 4 writes exactly one Seer
verdict before the open, one `ok` and one `skipped_budget` review row, and leaves no lease.

## Handoffs

- **Phase 5 (R5):** relay `deps.adversary.events` on `/api/events` as SSE event `adversary`
  (`src/http/api.ts`); routes `GET/PUT /api/adversary/toggle` -> `getToggle()` / `setToggle(on, hostname())`
  and `POST /api/adversary/review-now` -> `void reviewNow(opts)` (fire and forget, answer 202; the
  pass can take many minutes) and `GET .../status` -> `status()`; handle `deps.adversary === null`
  (reviewer off) in every route. `src/adversary/read.ts` may reuse `SeerReader` (it is read-only)
  and `sessionOpenUtc`; coverage per C4 needs `adversary_marks` + verdicts with `decided_at < open`
  (`sessionOpenUtc`). `adversary_reviews` has the usage numbers and `reused_from`. Extend
  `features/adversary.md` with the API/MCP bullets (do not recreate it). `tests/integration/helpers/api-harness.ts`
  now builds `adversary: null`; inject a real `AdversaryService` with `fakeReviewer()` there if routes
  need one. The chat allow-list (`src/chat/status.ts`) is untouched here.
- **Phase 6 (R6):** extend `features/adversary.md` (wall sections) and its README row's Surfaces; do
  not recreate either.
- **Phase 7 (R7):** README configuration rows (keys owned by this phase):
  `NOTESD_ADVERSARY` (on), `ADVERSARY_DAILY_CAP` (15), `ADVERSARY_GATHER_MODEL` (sonnet),
  `ADVERSARY_VERDICT_MODEL` (opus), `ADVERSARY_GATHER_MAX_TURNS` (20),
  `ADVERSARY_STOCK_TIMEOUT_MS` (420000), `ADVERSARY_POLL_MS` (600000); data-tool keys read from
  `SEER_DIR/.env.local` (already there): `FINNHUB_API_KEY`, `MASSIVE_API_KEY`, `SEC_CONTACT_EMAIL`;
  `drizzle/0011_adversary_reviews.sql` must be applied to Neon (`npm run db:migrate`) before the
  restart; a CLAUDE.md Architecture bullet for `src/adversary/*` (one writer of `adversary_reviews`,
  Seer writes only through `seerWriter.ts`); `scripts/install.sh` needs no new step (briefs are read
  from `<repo>/claude/adversary/briefs` at run time, `dist/` sits beside them).
- **Phase 1 (R1), as an assumption to confirm in reconciliation:** the append-only trigger on
  `adversary_verdicts` must allow the supersede UPDATE and must not fire on `TRUNCATE`.
- Not done, deliberately: no money-weighted returns or scorecard (phase 5); no per-review cost cap
  beyond turns and wall clock (`maxBudgetUsd` exists in the SDK; add later if Journey 4 shows a need).

## Rollback

`NOTESD_ADVERSARY=off` in `.env.local` + restart stops the job with no deploy. To undo the phase:
revert its commit(s); `drizzle/0011` is additive, so leave `adversary_reviews` in place (or
`DROP TABLE adversary_reviews` and remove the 0011 journal entry on a database where it was never
needed). Seer rows already written (verdicts, marks) are history and stay: the twins treat them as
they would any verdict decided before the open, and with no new verdicts they copy their originals.
