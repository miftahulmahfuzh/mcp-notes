# Design: connect mcp-notes to daily-words (`/v` vocabulary, `/j` journal)

Status: design agreed in discussion on 2026-11-05, not yet analyzed. Next step: run `/analyze` on this file.
No UI. Backend, MCP tools, two Claude Code skills, and the wall chat prompt.

## 1. Goal

`daily-words` (dword, `~/daily-words`, live at dword.site) is the user's vocabulary and wise-words app. mcp-notes should read and write it from Claude Code and from the wall chat bar.

Two triggers:

```
/v <word or phrase>
/v <word or phrase> > <sentence it was read in>
/j <wise words>
```

The separator is a single `>` (changed from `->` on 2026-11-05 for typing speed). Everything before the first `>` is the term, everything after it is the sentence.

Examples: `/v pendulous breasts`, `/v perch > she watched sima ting jerk backward on his perch`, `/j most things in life don't go according to one's wishes`. Non-English input to `/v` must work. (The user's first message said the trigger was "j" for both; this plan reads it as `/v` for vocabulary and `/j` for journal.)

### `/v` flow
1. Look the term up in dword's `vocab_entries` for the owner. If it exists, return it.
2. If it is missing, Claude writes the English explanation itself and inserts a new `vocab_entries` row.
3. A non-English term follows dword's existing convention: `term` is the **English** word, and `origin_term`, `origin_language` and `origin_context` record the foreign word, its language and the sentence.
4. The sentence after `>` selects the right sense (for example `perch` as a bird's roost) and is stored as `origin_context`.

### `/j` flow
1. Look for the same or a similar entry in `journal_entries`. If one is found, show it and its insight, and insert nothing (decision D3).
2. If none is found, Claude explains the saying itself and inserts a new entry with `insight` filled in and `insight_status = 'ready'`.

## 2. Decisions already made (do not reopen in analysis)

| # | Decision |
|---|---|
| D1 | Write path is a direct SQL writer into dword's database, allow-listed like `src/adversary/seerWriter.ts`. Not dword's HTTP API (it needs Auth.js sessions), and not importing dword code (it uses `server-only` and the `@/` alias). |
| D2 | Claude writes the explanation, examples and insight itself, in the session. dword's GLM prompts are not called. The MCP tool validates what Claude sends against dword's own limits. |
| D3 | Journal near-duplicate found: show the existing entry and insert nothing, unless the user says "save anyway" (then `force: true`). Mirrors dword's own warn-then-force behavior. |
| D4 | Vocab hit with a `> sentence`: show the entry; store the sentence as `origin_context` only when the row has no origin yet, in one conditional statement (mirrors dword's `attachOrigin`). Never overwrite an existing origin. |
| D5 | Wall chat bar is in the same plan, as a later phase after the Claude Code path works. |

## 3. What dword looks like (facts found, verified in `~/daily-words`)

- Next.js on Neon Postgres (`ap-southeast-1`), Auth.js with `strategy: 'database'` sessions. Multi-user: every row has `user_id` (uuid, FK to `users`).
- `vocab_entries` (`src/lib/db/schema.ts`):
  - `term` text; `source` is `'manual' | 'suggested' | 'shared'`; `status` is `'active' | 'mastered'`.
  - `part_of_speech` is one of `PART_OF_SPEECH_VALUES` in `src/lib/llm/prompts/vocab-enrich.ts` (noun, verb, adjective, adverb, pronoun, preposition, conjunction, interjection, determiner, phrase, idiom, phrasal verb, abbreviation, other).
  - `pronunciation` is British RP, max 60 characters. `definition` is at most 80 characters (prompt target 60). `examples` is a jsonb array of exactly 3 strings, each max 120 characters and each containing the term.
  - `enrichment_status` is `'ready'` for a complete row.
  - `origin_term`, `origin_language`, `origin_context` are all null for plain English adds.
  - Unique index `(user_id, lower(term))`. CHECK `vocab_entries_origin_context_needs_term`: `origin_context` may only be set when `origin_term` is set.
  - Per-day add limit `DAILY_ADD_LIMIT = 50` (`src/lib/db/queries/vocab.ts`).
- Existing writers to copy semantics from: `createVocabEntry`, `createLookedUpVocabEntry`, `attachOrigin`, `findEntryByNormalizedTerm`, `listTermsForDedup` (all `src/lib/db/queries/vocab.ts`). The non-English prompt is `src/lib/llm/prompts/vocab-translate.ts`.
- Dedup beyond the unique index: `src/lib/vocab/dedup.ts` (`normalizeForDedup`, `foldMorphology`, `dedupKey`) and `src/lib/vocab/near-duplicate.ts` (`findNearDuplicate`).
- `source = 'manual'` counts toward dword's collector level, which `/profile` recomputes on read, so no gamification write is needed. New words enter daily cards by least-recently-shown with no extra step.
- `journal_entries`: `text`, `source_note`, `insight` jsonb `{ meaning (<=220 chars), whenItApplies: 2-3 strings (<=120 chars each) }`, `insight_status` is `'none' | 'pending' | 'ready' | 'failed'`, `insight_requested_at`. Prompt and rules: `src/lib/llm/prompts/journal-insight.ts` (English always, dictionary register, no advice, no praise, concrete everyday situations).
- `journal_entry_embeddings`: one row per entry; `text_sha` (sha256 of exact text), `norm_sha` (sha256 of `normalizeForCompare(text)`), `embedding vector(1536)`, `model`, `status`. Duplicate check (`src/lib/journal/duplicate-check.ts`): Layer 1 is `norm_sha` equality; Layer 2 is cosine distance <= `NEAR_DUPLICATE_MAX_DISTANCE = 0.25` (`src/lib/journal/similarity.ts`, tuned for `text-embedding-3-small` at 1536 dimensions; its comment records that `3-large` fails). A row saved without an embedding is picked up by dword's own backfill (`selectPendingForBackfill`), so the writer may skip embeddings.
- dword's `.env.local` points at the real Neon database. This feature writes to production data, which is why the allow-list matters.
- dword runs on port 3200 and has its own verify skill (`.claude/skills/verify-daily-words`); its throwaway-DB approach is the model for our integration tests.

## 4. What mcp-notes already provides (verified)

- Connector pattern: `src/connectors/*` (`connector.ts`, `env.ts`, `names.ts`, `register.ts`, `guard.ts`, `sql.ts`, `schema.ts`). Systems are `expenses | runs | seer`; each has `*_schema`, `*_sql`, and curated tools; sibling repos are found through `*_DIR` env vars read from `.env.local` on every call (`connectorSettings`, `pickDirectUrl`, `prepareUrl`). Adding a system is one entry in `CONNECTOR_SYSTEMS`, `CONNECTOR_TOOL_NAMES`, `SYSTEM_META`, plus a directory.
- Write precedent: `src/adversary/seerWriter.ts` with `assertWritable()` (one statement, table allow-list, verb rules), reusing `loadDatabaseTarget`, `CONNECTOR_PG_TYPES`, `scrub`.
- Skills: `claude/skills/{n,migrate,check-seer-adversarial-nightly}` symlinked into `~/.claude/skills` by `scripts/install.sh`.
- Wall chat bar: `src/chat/*` (Claude Agent SDK, GLM fallback, tool allow-list built from `ALL_CONNECTOR_TOOL_NAMES`). It does not use skills, so `/v` and `/j` need handling in its system prompt and allow-list.
- Embeddings: `src/embeddings/*`, OpenRouter, `EMBEDDING_DIMENSIONS = 1536`.

## 5. Proposed design

### 5.1 New connector `dword`
- `SYSTEM_META.dword`: `repoDirEnv: 'DAILY_WORDS_DIR'`, default `~/daily-words`, label `daily-words`, caption `reading daily-words`, `hasLab: false`.
- Read-only `dword_schema` and `dword_sql` through the existing guard, like the other systems.
- Add `DAILY_WORDS_DIR` to `SETTING_KEYS` in `src/connectors/env.ts`, and `README.md`'s env table.
- New setting `DWORD_USER_EMAIL` (in mcp-notes `.env.local`): the owner's `users.email`. The daemon resolves it to `users.id` on each call. No tool argument ever carries a user id. Missing or unknown email: a clear error, no write.

### 5.2 Curated tools (`src/mcp/dwordTools.ts`, names added to `names.ts`)
- `dword_vocab_lookup { term }`: normalize with dword's rules, then match in order: exact `lower(term)`; `origin_term` match (so a foreign word that was added before is found); dedup-key (`foldMorphology`) match; near-duplicate. Returns `{ found, entry | candidates }`, where the entry has term, POS, pronunciation, definition, examples, origin fields, status. Read-only.
- `dword_vocab_add { term, part_of_speech, pronunciation, definition, examples[3], origin?: { term, language, context? }, context? }`: validates everything against dword's limits (section 5.4), inserts with `source = 'manual'`, `enrichment_status = 'ready'`, honors the 50-per-day limit and the unique index. On a unique collision it returns the existing row instead of failing. Applies D4's conditional `origin_context` attach when the row exists and has no origin.
- `dword_journal_find_similar { text }`: Layer 1 `norm_sha` equality, then Layer 2 as in 5.3. Returns the matching entries with their insights and a verdict (`duplicate | none`).
- `dword_journal_add { text, source_note?, insight: { meaning, whenItApplies[] }, force? }`: runs the same duplicate check; if a duplicate is found and `force` is not true it returns the match and inserts nothing (D3); else inserts with `insight_status = 'ready'`.

### 5.3 Journal similarity (open for analysis, with a recommended default)
Problem: Layer 2 needs an embedding made with the same model as the stored vectors, or distances mean nothing, and mcp-notes embeds through OpenRouter.
Recommended default, in order:
1. Layer 1 `norm_sha` (port `normalizeForCompare` exactly; pin it with a test against fixtures taken from dword).
2. Layer 2 only when the OpenRouter model id for `openai/text-embedding-3-small` is confirmed to produce comparable vectors and `journal_entry_embeddings.model` of existing rows is compatible; use `<=>` with the 0.25 threshold.
3. If Layer 2 is unavailable, fall back to a lexical candidate search (Postgres `simple` full text plus trigram on `text`) and let Claude judge the shortlist in the session. Never block a save on a failed embedding call, same rule as dword.
The analysis must decide between (2) and (3) by measuring on the user's real journal (read-only), and record the numbers.

### 5.4 Validation (mirror, do not invent)
One module `src/dword/rules.ts` holds the limits copied from dword with a comment naming the source file for each: POS enum, definition <= 80, pronunciation <= 60 and non-empty, exactly 3 examples each <= 120 chars and each containing the term (case-insensitive), term length and word count from `src/lib/vocab/normalize.ts` (`MAX_TERM_CHARS`, `MAX_TERM_WORDS`), context length from `validateContext`, insight meaning <= 220, whenItApplies 2 to 3 items <= 120. A drift test compares these constants to dword's source files when `~/daily-words` is present, and skips when it is missing (same rule as the other connector tests).

### 5.5 Writer (`src/dword/writer.ts`)
- Allow-list like `assertWritable`: one statement; `INSERT INTO vocab_entries`, `INSERT INTO journal_entries`, `INSERT INTO journal_entry_embeddings` (only if 5.3 chooses to store vectors), `UPDATE vocab_entries SET origin_term/origin_language/origin_context ... WHERE origin_term IS NULL`. No `DELETE`, no other tables, no other updates.
- Every statement carries the resolved `user_id`; reads and writes are scoped by it.
- Uses the direct (unpooled) URL from dword's `.env.local` through `pickDirectUrl` and `prepareUrl`; secrets scrubbed from errors via `scrub`.
- All tool inputs go through parameters (`$1...`), never string concatenation.

### 5.6 Skills and wall chat
- `claude/skills/v/SKILL.md` and `claude/skills/j/SKILL.md`, symlinked by `scripts/install.sh`. The `v` skill parses `<term> > <sentence>` (split on the first `>`, both sides trimmed; a trailing `-` on the term side is dropped so the old `->` still works; a term never legitimately contains `>`; no `>` means no sentence), detects language, and instructs Claude: lookup first; on a miss, write the entry in dword's register (British RP pronunciation, definition under 60 characters, three examples each containing the English term, sense chosen from the sentence, for non-English input the English term goes in `term`); then add. The `j` skill instructs: find similar first; on a miss, write the insight in dword's journal register (meaning plus 2 to 3 concrete situations, English, no advice, no praise); then add. Both reply with the stored entry and say whether it was found or newly added.
- Wall chat: extend the chat system prompt (`src/chat/prompt.ts`) and the tool allow-list (`ALL_CONNECTOR_TOOL_NAMES` plus the four curated tools) so a message starting `v ` or `j ` (and `/v`, `/j`) runs the same flow. Capture of `/n`-style exchanges (`POST /api/capture/claude-code`) is checked for `/v` and `/j` so they also appear in chat history.
- `claude/hooks/notes-prompt.mjs` must stay I/O-free when no node id matches; do not touch it for this feature.

### 5.7 Edge cases for analysis to settle
- Phrase terms such as `pendulous breasts`: confirm dword accepts multi-word terms (`MAX_TERM_WORDS`) and that POS `phrase` or `idiom` is chosen correctly.
- English term with a sentence: the CHECK needs `origin_term` when `origin_context` is set. Decide what to store for an English term (likely `origin_term` = the term itself, `origin_language` = `English`) and confirm that does not change how dword renders the row. Check how dword's own add path with a context sentence behaves, and match it.
- A word already held under a different surface form (`perches` vs `perch`): lookup via dedup key; report it, do not insert.
- Both-machines rule: the dword database is shared Neon, so there is no `not_on_this_machine` problem here, but the writer must still handle a failed connection with a clear error and no partial write.
- Daily limit of 50 reached: return a clear error.
- Non-English input where the model reports "already English" or "not a word" (dword's `status` values): tell the user instead of inserting.

## 6. Phases (for `/analyze` to refine)
1. Connector plumbing: `names.ts`, `env.ts`, `DAILY_WORDS_DIR`, `dword_schema`, `dword_sql`, `DWORD_USER_EMAIL` resolution, README env table.
2. Writer and rules: `src/dword/writer.ts`, `src/dword/rules.ts`, drift test, allow-list unit tests.
3. Vocab tools: `dword_vocab_lookup`, `dword_vocab_add`, integration test against a throwaway Postgres rebuilt from dword's `drizzle/` migrations.
4. Journal tools: `dword_journal_find_similar` (decide 5.3 by measurement), `dword_journal_add`, integration tests.
5. Skills `/v` and `/j`, `install.sh` symlinks, `verify-notesd` feature-map entries.
6. Wall chat: prompt, allow-list, history capture.

## 7. Proof (use `verify-notesd` before calling it done)
- Unit: `assertWritable` refuses every statement outside the allow-list; rules reject bad limits; `normalizeForCompare` and dedup-key parity fixtures.
- Integration (`npm run test:int` style, skips when `~/daily-words` is missing): lookup hit and miss; add idempotent on the unique index; origin attach only when null; non-English add stores English `term` plus origin; journal duplicate shows and does not insert; `force` inserts; daily limit.
- Live (opt-in, never in `npm test`): against a throwaway dword DB, not the production Neon.
- Manual on the real daemon only after the above: `/v perch > she watched sima ting jerk backward on his perch`, a non-English word, and `/j` with a known and an unknown saying.

## 8. Out of scope
Any web UI; changes to dword's own code; deleting or editing existing dword rows; calling dword's GLM prompts; dword's share, chat and gamification features.

## 9. Analysis results (added by `/analyze`, 2026-11-06, session 20261106-070115-DW6C)

Full detail in `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`. Corrections and resolutions only:

- **5.3 resolved, not left open.** Measured live (read-only) against dword's two real `ready` `journal_entry_embeddings` rows: re-embedding the exact same text through OpenRouter's `openai/text-embedding-3-small` gave **cosine distance 0.000000** against dword's own OpenAI-native stored vector, and the cross-entry distance matched within 0.00006 (0.799019 stored vs. 0.799077 fresh). OpenRouter and dword's embeddings are the same vector space here. **Use Layer 2 with the existing 0.25 threshold as-is**; the lexical fallback is kept only as a never-block-the-save degrade for a failed/timed-out embedding call, not as a routine workaround.
- **5.7 resolved.** Dword's own `POST /api/vocab` route only ever writes `origin_term`/`origin_context` inside the non-English `lookup`-token branch; a plain English add with a sentence is a case dword's code structurally never reaches, so there is no existing value to copy. The CHECK ties only `origin_context` to `origin_term`; `origin_language` is unconstrained. Decision: `origin_term = term`, `origin_context = sentence`, `origin_language = 'English'`.
- **§3 correction:** `examples` is Zod-capped at 120 chars, but the enrichment prompt instructs the model to keep each example ≤100 chars (`vocab-enrich.ts:179`). Say "Zod-enforced ≤120, model-instructed ≤100," not "max 120."
- **§3 correction:** dword's journal embeddings come from **OpenAI's native `/v1/embeddings`** (`EMBEDDING_BASE_URL` default `https://api.openai.com/v1`, `src/lib/llm/embed.ts`), authenticated by a separate `EMBEDDING_API_KEY` that is **not** the shared `OPENROUTER_API_KEY` — confirmed absent from dword's own `.env.local`. This does not change the design (5.3's measurement shows the vectors are comparable anyway), but "dword embeds via OpenRouter" would have been wrong to assume.
- **§4 correction:** "adding a system is one entry in `CONNECTOR_SYSTEMS`, `CONNECTOR_TOOL_NAMES`, `SYSTEM_META`, plus a directory" is incomplete. `src/connectors/register.ts` also needs a new `ABOUT` entry, a `defaultConnectors()` case, and (once curated tools exist) a curated-registration call — `schema.ts`/`sql.ts` are generic and need no change, and `src/mcp/server.ts` needs no change (it calls `registerConnectorTools` once, generically).
- **§4 correction:** the integration-test harness functions are split across two files, not one — `tests/integration/connectors/harness.ts` and `tests/integration/connectors/siblings.ts`. A 4th system needs no new branches in either file, only a new `SystemId` entry, because dword's migrations already use the same drizzle-journal layout `migrationFiles`/`buildSystemDb` already handle.
- **§4 correction:** `ALL_CONNECTOR_TOOL_NAMES` is consumed in `src/chat/status.ts` (`allowedChatTools()`), not a `src/chat/tools.ts` — no such file exists.
- **§4 note:** there are four skill directories today (`migrate`, `n`, `check-seer-adversarial-nightly`, `redo`), not fewer; `check-seer-adversarial-nightly/SKILL.md` is the freshest template for `/v`/`/j`'s frontmatter and body shape. Whether `scripts/install.sh`'s symlink loop is glob-based over `claude/skills/*` (so two new directories are picked up automatically) was not confirmed by this analysis — phase 5 must check before assuming it.
- **R3 (user resolution), not previously decided in this doc:** `DWORD_USER_EMAIL` is a new single optional string in mcp-notes' `.env.local`, parsed like `parseEmbeddings()` (`src/config.ts:279`). It is resolved to `users.id` fresh on every call (`SELECT id FROM users WHERE email = $1`, `users.email` is unique and not null), never cached in `Config`. Missing/unset `DWORD_USER_EMAIL` or an unmatched email is a clear refusal with no write attempted.
