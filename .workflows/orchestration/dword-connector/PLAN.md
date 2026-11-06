# Plan: dword connector (`/v` vocabulary, `/j` journal)

**Slug:** dword-connector
**Date:** 2026-11-06T07:01:15+07:00
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/dword-connector`
**Branch:** `feature/dword-connector` (base: `origin/main` @ `2df19b9`)
**Phases:** 6
**Status:** phase 3/6 complete
**Coordinator:** —

---

## Why

From mcp-notes note [G-NPQ](http://localhost:7317/?note=G-NPQ) (full text in the analysis document
under "Original User Request"), building on the agreed design brief
`docs/plans/2026-11-05-dword-connector-design.md`: connect mcp-notes to `~/daily-words` so
`/v <word or phrase> [> <sentence>]` looks up or adds a `vocab_entries` row, and
`/j <wise words>` looks up or adds a `journal_entries` row, from Claude Code and from the wall
chat. No UI. Five decisions (D1-D5, design §2) are closed and not reopened by any phase: a direct
allow-listed SQL writer like `seerWriter.ts`; Claude writes the explanation itself; a journal
near-duplicate is shown and nothing is inserted unless `force: true`; a vocab hit's `origin_context`
is attached only when the row has no origin yet; wall chat is a later phase after the Claude Code
path works.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Verify design §3 against `~/daily-words` and §4 against mcp-notes; correct what's wrong | 1, 2, 3, 4 |
| R2 | Settle 5.3 (journal similarity) and 5.7 (English term + sentence) by measurement/reading | 3, 4 |
| R3 | Decide `DWORD_USER_EMAIL` resolution and missing/unknown behavior | 1 |
| R4 | Exact parameterised SQL for every write, and the `assertWritable` allow-list rules | 2 |
| R5 | Tests against a throwaway Postgres from dword's migrations, skip when `~/daily-words` missing, never touch production/`~/.claude` | 1, 3, 4 |
| R6 | `/v`/`/j` skill texts, wall chat prompt/allow-list, `verify-notesd` feature-map entries | 5, 6 |

R1 spans phases 1-4 because the corrected facts (examples char limits, the connector
registration touch points, the harness file split, the embeddings transport) are embodied in the
plumbing, the writer/rules, and both tool phases, not in one place. R5 spans 1 (harness plumbing: a
new `SystemId`) and 3/4 (the actual integration test files, one per domain, matching the existing
one-file-per-system pattern).

## Scope

**In scope:** a 4th connector system `dword` (`src/connectors/dword/*`, `names.ts`, `env.ts`,
`register.ts` entries); `src/dword/rules.ts` and `src/dword/writer.ts`; four curated MCP tools
(`dword_vocab_lookup`, `dword_vocab_add`, `dword_journal_find_similar`, `dword_journal_add`) plus
the generic `dword_schema`/`dword_sql`; `claude/skills/v/SKILL.md` and `claude/skills/j/SKILL.md`;
wall chat allow-list and system-prompt additions (`src/chat/status.ts`, `src/chat/prompt.ts`);
`verify-notesd` feature-map entries; `README.md` env table rows; integration tests against a
throwaway Postgres rebuilt from dword's own `drizzle/` migrations.

**Out of scope (design §8, unchanged):** any web UI; any change to `~/daily-words`'s own code;
deleting or editing existing dword rows; calling dword's GLM prompts; dword's share, chat and
gamification features; a notes-side cache of dword data; an attempt/usage log table for dword
writes (considered in the analysis — `reviewsRepo.ts` is a precedent for a *reviewer's own*
attempt log, not a generalizable pattern dword's user-initiated single inserts need; no such table
is added unless a later phase finds dedup/audit actually requires one, which none do).

## Invariants

1. `npm run typecheck`, `npm test` and `npm run test:int` are green at the end of every phase.
2. D1-D5 (design §2) are never reopened.
3. The `/v` separator is a single `>`: split on the first `>`, trim both sides.
4. Nothing in `~/daily-words` is written, changed, or imported as code; its migrations are read as
   files by the test harness only, exactly like the three existing connectors.
5. Every statement `src/dword/writer.ts` sends is parameterised (`$1…`), never string-concatenated,
   and passes through `assertWritable`-style allow-list checks before it reaches a connection.
6. No test suite that runs in `npm test` or `npm run test:int` ever touches dword's production Neon
   database or `~/.claude`; any live check against real dword data is opt-in and separate, following
   `tests/integration/connectors`'s existing Neon-refusal pattern (`connectorsAdminUrl()`).
7. Ids are never invented (dword's own uuid defaults and mcp-notes' node/note id generators are the
   only sources of ids anywhere in this feature).
8. dword's limits (POS enum, char/word ceilings, example rules, insight ceilings) live in exactly
   one module, `src/dword/rules.ts`, each constant commented with the dword source file it mirrors.

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| 5.3: is OpenRouter's embedding comparable to dword's stored vectors, or is a lexical fallback needed as the normal path? | Comparable — measured cosine distance 0.000000 for identical text and 0.00006 drift on cross-entry distance, against dword's real production rows. Use Layer 2 with the 0.25 threshold as-is; keep the lexical fallback only as a failed-call degrade. | 1: analysis's own empirical measurement (the task's explicit instruction to "measure on the real journal READ-ONLY" and decide) |
| 5.7: what does an English term + sentence store for `origin_language`? | `origin_term = term`, `origin_context = sentence`, `origin_language = 'English'` | 4: the design doc's own stated instinct (§5.7, "likely... `English`"), confirmed uncontradicted by dword's CHECK or any other constraint |
| Where do the four curated MCP tools live — one `src/mcp/dwordTools.ts` (design §5.2's literal naming) or split by domain? | Split: `src/mcp/dwordVocabTools.ts` (phase 3) and `src/mcp/dwordJournalTools.ts` (phase 4), both registered from one `registerDwordCurated` call added in `src/connectors/register.ts` | 6: surrounding convention — every other connector's curated tools are domain-scoped per file (`expenses/curated.ts`, `seer/curated.ts` are single-domain systems, but `adversaryTools.ts`/`sessionTools.ts` each own one concern); splitting lets phases 3 and 4 build and test independently without a same-file collision, which the design's filename was a suggestion rather than a D1-D5 decision |
| Is a dword-write attempt/usage log table needed, mirroring `adversary_reviews`? | No — out of scope unless a phase finds dedup/audit genuinely requires it (none does) | 5: the user's raw input (§8 "Out of scope" lists exactly what the feature must do; an audit log was never asked for) + `reviewsRepo.ts`'s own nature (a *reviewer's* attempt log, not a generic write log) |
| (Surfaced in reconciliation) 5.3's near-duplicate comparison: strict `<` or `<=`? Phase 4's code used `<`; the plan index and design doc's prose both said `<=`. | Strict `<`, matching dword's own `isNearDuplicate`. Read `~/daily-words/src/lib/journal/similarity.ts:186-188` directly during reconciliation: `return distance < NEAR_DUPLICATE_MAX_DISTANCE;`, with the file's own comment stating "the comparison is strict — `distance < T` warns, `distance === T` does not — per the asymmetry at the top of this file." Phase 4's code already matched; no code changed, only this record. | 3: the plans' own code blocks, verified directly against dword's real source rather than its own summarizing prose — "mirror, do not invent" applies to the operator exactly as much as the number |
| (Surfaced in reconciliation) Where does `NEAR_DUPLICATE_MAX_DISTANCE = 0.25` live — `src/dword/rules.ts` (phase 2) or `src/dword/journalSimilarity.ts` (phase 4)? Phase 2 never defined it; phase 4 assumed it came from `rules.ts` anyway. | `src/dword/journalSimilarity.ts` (phase 4), next to the other constants/functions already ported there from the same dword source file (`similarity.ts`), commented with `similarity.ts:176` as its source. Invariant 8 ("dword's limits ... live in exactly one module, `src/dword/rules.ts`") is read as governing validation ceilings (POS enum, char/word/example/insight limits); a dedup-algorithm threshold is a different kind of constant, and citing its real source in a different module keeps the invariant's spirit. | 3: the plans' own code blocks — phase 4 already organizes `journalSimilarity.ts` as one file ported wholesale from `similarity.ts`; the threshold from that same source file follows the same organization rather than splitting one source file's constants across two destination modules |
| (Surfaced by write-set gate) `src/connectors/names.ts` written concurrently by phases 3 and 4 (same `CONNECTOR_TOOL_NAMES.dword` array literal; phase 4 also imports phase 3's `registerDwordVocabCurated`) | ORDER: add edge 3 → 4 (phase 4 now depends on 1, 2, 3); waves become 1 → 2 → 3 → 4 → 5 → 6 | 6: SKILL.md ORDER remedy; the two edits sit on one literal (anchors within 3 lines), so isolation would only defer the conflict, and reconciliation #3 already made 4 depend on 3 to compile |

## Open Questions

(none — every fork above was decided by a stated rung; nothing here is irreversible)

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Connector plumbing (done 2026-11-06) | R1, R3, R5 | `src/connectors`, `src/config.ts` | ~8 | — | NORMAL | `.workflows/plan/dword-connector/phase-1.md` | P1-NOTES-A074 | — |
| 2 | Writer and rules (done 2026-11-06) | R1, R4 | `src/dword` | ~4 | 1 | HARD | `.workflows/plan/dword-connector/phase-2.md` | P1-NOTES-A075 | — |
| 3 | Vocab tools (done 2026-11-06) | R1, R2, R5 | `src/mcp`, `tests/integration/connectors` | ~4 | 1, 2 | HARD | `.workflows/plan/dword-connector/phase-3.md` | P1-NOTES-A076 | — |
| 4 | Journal tools | R1, R2, R5 | `src/mcp`, `tests/integration/connectors` | ~4 | 1, 2, 3 | HARD | `.workflows/plan/dword-connector/phase-4.md` | P1-NOTES-A077 | — |
| 5 | Skills `/v` and `/j` | R6 | `claude/skills`, `.claude/skills/verify-notesd` | ~5 | 3, 4 | NORMAL | `.workflows/plan/dword-connector/phase-5.md` | P1-NOTES-A078 | — |
| 6 | Wall chat | R6 | `src/chat`, `.claude/skills/verify-notesd` | ~4 | 3, 4, 5 | NORMAL | `.workflows/plan/dword-connector/phase-6.md` | P1-NOTES-A079 | — |

Phases 3 and 4 share depends-on (1, 2) but touch disjoint files (per the Decisions split above) and
may run concurrently.

### Phase 1 — Connector plumbing
**Satisfies:** R1, R3, R5
**Owns:** `src/connectors/names.ts` (`dword` added to `CONNECTOR_SYSTEMS`, `CONNECTOR_TOOL_NAMES`
(generic schema/sql names only — curated names are added by phases 3/4), `SYSTEM_META`);
`src/connectors/env.ts` (`DAILY_WORDS_DIR` added to `SETTING_KEYS`); `src/connectors/register.ts`
(`DWORD_ABOUT` in `ABOUT`, `dword: createDwordConnector()` in `defaultConnectors()`); new
`src/connectors/dword/index.ts` (thin wrapper, mirrors `seer/index.ts`); `src/config.ts`
(`DWORD_USER_EMAIL` parsing, added to `loadConfig()`); `README.md` env table rows; the test harness
(`tests/integration/connectors/siblings.ts`/`harness.ts`) gains `'dword'` as a `SystemId`, with the
resolver for dword's `users.id` (`SELECT id FROM users WHERE email = $1`, resolved fresh per call,
refusal on missing/unmatched email) plus the two refusal-message builder functions phase 2's writer
re-uses for its own, pg.Client-based equivalent (Reconciliation Log #1).
**Does not touch:** `src/dword/*` (phase 2), any MCP tool file (phases 3/4), skills/chat (5/6).
**Exit criteria:** `dword_schema` and `dword_sql` work end to end against a throwaway dword-shaped
Postgres; `DWORD_USER_EMAIL` resolves to a real `users.id` or refuses clearly; `npm run typecheck`
and `npm test` pass.

### Phase 2 — Writer and rules
**Satisfies:** R1, R4
**Owns:** new `src/dword/rules.ts` (every mirrored dword limit, each constant commented with its
dword source file — including `JOURNAL_TEXT_MIN/MAX` and `JOURNAL_SOURCE_NOTE_MAX` from dword's
`src/lib/journal/limits.ts`, added during reconciliation after phase 4's draft needed them and
phase 2's original draft never enumerated that file — Reconciliation Log #15 — plus a drift test
that compares them to dword's real source when `~/daily-words` is present and skips otherwise); new
`src/dword/writer.ts` (the allow-listed SQL
writer: exact statements for `INSERT INTO vocab_entries`, `UPDATE vocab_entries SET
origin_term/origin_language/origin_context … WHERE origin_term IS NULL`, `INSERT INTO
journal_entries`, `INSERT INTO journal_entry_embeddings`; `assertWritable`-shaped allow-list
rejecting anything else, reusing `loadDatabaseTarget`, `CONNECTOR_PG_TYPES`, `scrub` from
`src/connectors/*`, and phase 1's two refusal-message builders for its own pg.Client-based user-id
lookup, since it cannot reuse phase 1's `Connector`-based `resolveDwordUserId` directly
(Reconciliation Log #1)).
**Does not touch:** `src/connectors/*` (owned by phase 1; only imported), any MCP tool file.
**Exit criteria:** unit tests prove `assertWritable` refuses every statement outside the allow-list
(including a second statement, a `DELETE`, any other table, an `UPDATE` without the `origin_term IS
NULL` guard); the drift test passes against real `~/daily-words` when present and skips cleanly
when absent.

### Phase 3 — Vocab tools
**Satisfies:** R1, R2, R5
**Owns:** new `src/mcp/dwordVocabTools.ts` (`dword_vocab_lookup`, `dword_vocab_add`); the curated
names added to `CONNECTOR_TOOL_NAMES.dword` and wired into `registerDwordCurated` (owned jointly
with phase 4 — see phase 4's note on `register.ts`'s curated call); `tests/integration/connectors/
dword.vocab.curated.int.test.ts`. Implements the 5.7 resolution (`origin_language = 'English'`
case) and the D4 conditional origin-attach.
**Does not touch:** `src/dword/writer.ts`/`rules.ts` (phase 2, only imported), journal tools
(phase 4's file).
**Exit criteria:** lookup hit/miss, add with unique-index collision (returns existing row), add with
origin attach (only when no prior origin), daily-limit refusal — all proven against the throwaway
Postgres harness; never touches production Neon.

### Phase 4 — Journal tools
**Satisfies:** R1, R2, R5
**Owns:** new `src/mcp/dwordJournalTools.ts` (`dword_journal_find_similar`, `dword_journal_add`);
new `src/dword/journalSimilarity.ts` (ported Layer 1 hashing from dword's `similarity.ts`, plus
`NEAR_DUPLICATE_MAX_DISTANCE` — reconciled to live here, not in phase 2's `rules.ts`; see
Reconciliation Log #5); the curated names appended to `CONNECTOR_TOOL_NAMES.dword` after phase 3's
own two (reconciled ownership: phase 3 appends its two first, this phase appends its two after,
landing on the final six-name array — Reconciliation Log #2); the new `src/mcp/dwordTools.ts`
barrel and the one `registerDwordCurated(server, connectors.dword)` call added to
`src/connectors/register.ts` (this phase's job unconditionally, not "whichever phase lands
second" — Reconciliation Log #2); `tests/integration/connectors/
dword.journal.curated.int.test.ts`. Implements the 5.3 resolution (Layer 2 via OpenRouter at the
0.25 threshold, strict `<` comparison confirmed against dword's real source — Reconciliation Log
#6 — never blocking a save on a failed embedding call).
**Does not touch:** `src/dword/writer.ts`/`rules.ts` (phase 2, only imported), vocab tools
(phase 3's file).
**Exit criteria:** duplicate found → shown, nothing inserted; `force: true` → inserted; no
duplicate → inserted with `insight_status = 'ready'`; a simulated embedding failure still inserts
the entry (no embeddings row, no block) — all against the throwaway Postgres harness.

### Phase 5 — Skills `/v` and `/j`
**Satisfies:** R6
**Owns:** new `claude/skills/v/SKILL.md`, `claude/skills/j/SKILL.md` (format per
`check-seer-adversarial-nightly/SKILL.md`: `name`/`description`/`argument-hint` frontmatter, H1,
short "what this does", numbered steps — lookup/find-similar first, add on a miss, reply stating
found vs. added); confirms (does not assume) whether `scripts/install.sh`'s skill-symlink step is
glob-based over `claude/skills/*`, adding the two new directories explicitly if it is not; new
`.claude/skills/verify-notesd/features/dword.md` (or an extension, following the four-section
contract) covering the Claude Code skill path.
**Does not touch:** `src/chat/*` (phase 6).
**Exit criteria:** `/v <term> > <sentence>` and `/j <text>` work end to end in a real Claude Code
session against the throwaway daemon; `verify-notesd`'s `$V` commands for this entry are
copy-pasteable and pass.

### Phase 6 — Wall chat
**Satisfies:** R6
**Owns:** `src/chat/status.ts` (`DWORD_TOOL_NAMES`, the four curated tool names, added **only** for
bespoke status captions and this file's own tests — **not** spliced into `allowedChatTools()`,
since `dword` is already a `CONNECTOR_SYSTEMS` member from phase 1 and all six of its tool names
already reach the allow-list through `ALL_CONNECTOR_TOOL_NAMES`; phase 6's own plan corrects this
draft's original phrasing — see its "Load-bearing finding" and Principles Applied sections);
`src/chat/prompt.ts` (a new paragraph in `buildChatSystemPrompt`'s `sections`, since the chat agent
has no skill-loading and no slash-command parsing — natural-language triggers only, matching the
existing connectors' paragraph style); confirms `/v`/`/j`-equivalent wall-chat exchanges are
captured into chat history (the existing `POST /api/chat` route already captures every exchange
unconditionally — this phase verifies, not builds, unless a gap is found); the `verify-notesd`
`dword.md` entry gains its wall-chat section (`## Wall chat (phase 6)`, appended after phase 5's
`## Claude Code skills (phase 5)` — confirmed matching, no heading mismatch).
**Does not touch:** skills (phase 5, already shipped), MCP tool files (phases 3/4).
**Exit criteria:** a wall-chat message like "add the word perch, as in..." runs the same
lookup/find-similar-then-add flow as the skill, through `verify-notesd`'s Playwright driving of the
wall; the exchange appears in chat history.

## Reconciliation Log

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | `resolveDwordUserId` had four different shapes across phases: phase 1's real file (`src/connectors/dword/user.ts`, `(connector: Connector, email: string \| null)`); phase 2's writer assumed `(client: pg.Client, email: string \| undefined)` at the same path; phase 3 wrote its own local `(connector, email)` copy inside `dwordVocabTools.ts` with different refusal wording; phase 4 assumed a self-sufficient `(connector)` exported from `dword/index.ts`. | Deleted-then-used / contract drift | Read phase 1's actual file: it exports `resolveDwordUserId(connector, email)` from `src/connectors/dword/user.ts`, plus (added during reconciliation) two message-builder functions `dwordUserNotConfiguredMessage()`/`dwordUserNotFoundMessage(email)`. Phases 3 and 4 (both hold a `Connector`) now import and call this function directly, each keeping its own small `emailOf` thunk (`options.userEmail ?? (() => loadConfig().dword.userEmail)`) to read `DWORD_USER_EMAIL` and supply it as the second argument — phase 3's local duplicate is deleted. Phase 2's writer holds a raw `pg.Client`, not a `Connector` (`Connector.query()` refuses non-SELECT statements, and the two transports' `query()` results are shaped incompatibly), so it cannot call phase 1's function; it now has its own tiny `resolveUserIdFromClient(client, email)` that runs the identical query against its own client and throws using the same two imported message builders, so the refusal text is identical regardless of transport. |
| 2 | Shared edit surface: `src/connectors/register.ts`'s curated-registration call and `CONNECTOR_TOOL_NAMES.dword`'s array literal were each independently touched by phase 3's and phase 4's drafts. | File collision / duplicate work | Verified phase 3 exports `registerDwordVocabCurated(server, connector, options?)` under exactly the name and two-argument shape phase 4's barrel (`src/mcp/dwordTools.ts`) already expects — no rename needed. Assigned `register.ts`'s one edit solely to phase 4 (phase 3's plan already deferred it, confirmed consistent). Assigned `names.ts`'s array region to phase 3 first; rewrote phase 4's Step 6 to assume phase 3's two-name state and append its own two after it, landing on the single six-name array `['dword_schema', 'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add', 'dword_journal_find_similar', 'dword_journal_add']` instead of two competing full-literal diffs. |
| 3 | Phase 4's barrel (`src/mcp/dwordTools.ts`) imports phase 3's `registerDwordVocabCurated`, so it cannot type-check until phase 3 has also landed, even though phase 4's table lists "Depends on: 1, 2" only. | Broken-build phase (self-flagged, verified sanctioned) | Confirmed this is deliberate and already called out by phase 4's own plan (its "Before you start" section and Verification notes), matching the precedent phase 1 cites from `CONNECTORS_PLAN.md`: phases 3 and 4 are one concurrent wave, integrated and full-suite-tested together, not required to be green in total isolation from each other. No change made; cross-referenced explicitly in both phases' text so a future reader does not mistake it for an oversight. |
| 4 | `tests/unit/connectors/names.test.ts` and `tests/unit/chat-status.test.ts` (both owned only by phase 1) hardcoded dword's tool-name count as literals (`dword: 2`, totals `17` / `19+5+3+17+2`). Neither phase 3 nor phase 4 lists these files in "Owns," so both would fail the moment either phase appended a curated tool name, with nothing to fix them until phase 6. | Gap (incremental test-count assertions) | Rewrote both assertions in phase 1 to derive every count from `CONNECTOR_TOOL_NAMES`/`ALL_CONNECTOR_TOOL_NAMES` at runtime instead of a literal, per the instruction to prefer the dynamic fix over pushing an update obligation onto two later phases. Both files are now green, unmodified, through phases 1-5; phase 6's own full-file rewrite (already planned) supersedes them once the set is complete and the count is permanently frozen. |
| 5 | `NEAR_DUPLICATE_MAX_DISTANCE` (dword `similarity.ts:176`) was flagged by phase 2 as out of its enumerated list of limits, with no definite owner; phase 4 assumed it would still come from `rules.ts`, which phase 2 never defines it in. | Gap (unowned constant) | Placed it in phase 4's own `src/dword/journalSimilarity.ts`, beside the other constants/functions already ported there from the same `similarity.ts` source file, commented with `similarity.ts:176` as its source — recorded as a Decision (see Decisions table) since it is a placement fork, not a mechanical fix. |
| 6 | Phase 4 used strict `<` for the near-duplicate comparison ("mirroring dword's own `isNearDuplicate`"), while the plan index's design-doc-derived prose and this plan's own draft text said `<=`. | Contract drift (verified, not a bug) | Read `~/daily-words/src/lib/journal/similarity.ts` directly (lines 171-188) during reconciliation: `isNearDuplicate` returns `distance < NEAR_DUPLICATE_MAX_DISTANCE`, strict, and the file's own comment states the boundary is deliberate ("`distance === T` does not" warn). Phase 4's code already matches dword's real source; no code changed. Recorded as a Decision (see Decisions table) since it overrides the plan index's own summarizing prose. |
| 7 | Phase 3's `vocabAdd`/`finishCollision` assumed `writer.insertVocabEntry` throws a Postgres `23505` error on a unique-index collision, and that `NewVocabEntry`/`attachOrigin` accept `userId` and origin fields directly on the initial insert. Phase 2's actual writer never throws for this case (`INSERT ... ON CONFLICT (user_id, lower(term)) DO NOTHING RETURNING ...` resolves to `null`), `NewVocabEntry` has no `userId` or origin fields (the writer resolves the user id itself; origin is always a separate `attachVocabOrigin` call), and `attachVocabOrigin` returns a `boolean`, not a row. | Contract drift / would-not-compile | Rewrote phase 3's `vocabAdd`/`finishCollision` to branch on `insertVocabEntry`'s `null` return instead of catching a Postgres error code; removed the `pgErrorCode`/`PG_UNIQUE_VIOLATION` logic entirely; added a `reloadEntry` helper to re-read the full row after an insert or a successful attach, since neither writer method's `RETURNING` clause carries every column this tool's JSON shape needs. Widened phase 2's `VocabOrigin.originContext` from `string` to `string \| null` (an origin may have no "as in ..." sentence). The MCP tool's external argument/response shapes (`created`, `origin_attached`) were already correct in phase 3's own integration test and needed no change. |
| 8 | Phase 4 assumed `NewJournalEntry`/`NewJournalEmbedding` carry a `userId` field and that `DwordWriter`'s `userEmail` constructor option is optional. Phase 2's actual types have no `userId` field on either input (same internal-resolution pattern as the vocab side) and `userEmail` is a **required** constructor field. | Contract drift / would-not-compile | Removed `userId` from both call sites in phase 4's `dwordJournalTools.ts`; added the required `userEmail` thunk to every `DwordWriter` construction in phase 4 (the default writer inside `registerDwordJournalCurated`, and the integration test's writer) — the test now passes `userEmail: () => OWNER_EMAIL` explicitly (via `registerDwordJournalCurated`'s own new `userEmail` option, added to match phase 3's shape) instead of mutating `process.env.DWORD_USER_EMAIL`. |
| 9 | Phase 3 and phase 4 both assumed `config.dwordUserEmail: string \| null`; phase 1's actual `Config` nests it at `config.dword.userEmail` (`DwordConfig`). | Unmet assumption | Fixed both phases' `emailOf` thunks, doc comments and Interface Contract text to read `loadConfig().dword.userEmail`. |
| 10 | Phase 3 imported three `rules.ts` constants under names phase 2 does not export: `PRONUNCIATION_MAX`, `DEFINITION_MAX`, `EXAMPLES_REQUIRED` vs. phase 2's actual `PRONUNCIATION_MAX_CHARS`, `DEFINITION_MAX_CHARS`, `EXAMPLES_COUNT`. | Rename / would-not-compile | Renamed every reference (imports, Zod schema field builders, JSDoc) in phase 3 to phase 2's real exported names. |
| 11 | Phase 3's `requireValidContext` reimplemented the exact `raw.trim().length > MAX_CONTEXT_CHARS` ceiling phase 2's own `validateDwordContext` already checks. | Duplicate work | Phase 3's `requireValidContext` now calls phase 2's `validateDwordContext` and throws based on its result, so the ceiling is enforced in exactly one place. |
| 12 | Phase 5's Interface Contract and `dword.md` verify-script example output assumed `dword_vocab_add`/`dword_journal_add` return `{ added, entry }`. Phase 3/4's actual shapes are `{ created, origin_attached, entry }` and `{ verdict, inserted, entries, entry?, embedded, layer2_skipped? }`. | Contract drift (downstream prose) | Corrected phase 5's Interface Contract text and every `# ->` example-output line in `dword.md`'s verify script to the real field names. `claude/skills/v/SKILL.md` and `j/SKILL.md`'s own prose name no raw JSON fields (they describe behavior, not wire shapes) and needed no edit. |
| 13 | General pass: verified phase 6's three load-bearing assumptions (`SYSTEM_META.dword.caption = 'reading daily-words'`; the final 6-name `CONNECTOR_TOOL_NAMES.dword` order; phase 5's `## Claude Code skills (phase 5)` H2 in `dword.md`, which phase 6 appends `## Wall chat (phase 6)` after) against phases 1/3/4/5's actual landed content. | Verification (no conflict found) | All three match exactly — phase 6 needs no edit. |
| 14 | General pass: verified phase 2's four allow-listed SQL statement shapes (`INSERT INTO vocab_entries ...`, the one allowed `UPDATE vocab_entries` origin-attach, `INSERT INTO journal_entries ...`, `INSERT INTO journal_entry_embeddings ...`) against phases 3/4's actual call sites, after fixes #7 and #8 above. | Verification (no conflict after #7/#8) | Column lists and parameter order now match exactly — phases 3/4 no longer pass extra `userId`/origin columns into the writer's typed inputs. |
| 15 | General pass: phase 4 imports `JOURNAL_TEXT_MIN`, `JOURNAL_TEXT_MAX`, `JOURNAL_SOURCE_NOTE_MAX` from `src/dword/rules.ts`, sourced from dword's `src/lib/journal/limits.ts` — a file phase 2's draft never enumerated or read, so these three constants did not exist anywhere in phase 2's plan. Phase 4 also imported the insight bound constants under shorter names (`INSIGHT_MEANING_MIN`, `INSIGHT_WHEN_ITEM_MAX`, etc.) than phase 2's actual, longer exported names (`INSIGHT_MEANING_MIN_CHARS`, `INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS`, etc.). | Gap (unowned constants) + rename / would-not-compile | Read `~/daily-words/src/lib/journal/limits.ts` directly during reconciliation and confirmed phase 4's cited values (`2`, `1000`, `200`) are correct; added `JOURNAL_TEXT_MIN`, `JOURNAL_TEXT_MAX`, `JOURNAL_SOURCE_NOTE_MAX` to phase 2's `rules.ts` (the module that already owns every other dword limit) with a drift-test case added alongside, per the "gaps are assigned to the phase that already owns that package" rule. Renamed phase 4's insight-bound imports and Zod field builders to phase 2's real, longer names throughout. |

## Rollback

Per phase: each phase's own files are new or additive (no existing connector/chat/skill file loses
behavior other connectors depend on), so reverting a phase is `git revert` of that phase's commit(s)
on `feature/dword-connector`. As a whole: delete the branch and worktree; nothing in `~/daily-words`
was ever written, so there is no data to roll back there. If phase 2's writer ships before phases
3/4 land, it has no caller yet and is inert — safe to merge incrementally.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/DWORD_CONNECTOR_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows,
resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/DWORD_CONNECTOR_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/DWORD_CONNECTOR_PLAN.md
