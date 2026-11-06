# Phase 5: Skills `/v` and `/j`

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R6 — the Claude Code side of "`/v` looks up or adds a vocab entry, `/j` looks up or
adds a journal entry"
**Depends on:** Phase 3 (`dword_vocab_lookup`, `dword_vocab_add`), Phase 4
(`dword_journal_find_similar`, `dword_journal_add`)
**Difficulty:** NORMAL
**Package:** `claude/skills`, `.claude/skills/verify-notesd`

---

## Goal

After this phase, typing `/v <term>[ > <sentence>]` or `/j <saying>` in any Claude Code session on
this machine loads a skill that drives the four dword MCP tools in the right order (lookup/find
first, write only on a miss), writes a dword-register-quality entry itself when needed, and reports
whether the result was found or newly added. `scripts/install.sh` symlinks both skills into
`~/.claude/skills` the same way it does the four existing ones, and `verify-notesd`'s feature map
has a `dword.md` entry proving the tool-call mechanics the skill text relies on.

## Interface Contract

**Creates:**
- `claude/skills/v/SKILL.md`
- `claude/skills/j/SKILL.md`
- `.claude/skills/verify-notesd/features/dword.md`

**Renames:** none
**Deletes:** none
**Signature changes:** none — this phase writes no TypeScript and calls no tool it does not
already expect to exist.

**Requires (from earlier phases), and the exact shapes this phase's skill text assumes:**
- Phase 3 ships `dword_vocab_lookup({ term })` returning `{ found: boolean, entry?: {...}, candidates?: [...] }`,
  and `dword_vocab_add({ term, part_of_speech, pronunciation, definition, examples, origin?, context? })`
  returning **`{ created: boolean, origin_attached: boolean, entry: {...} }`** — **[Reconciled]**
  this phase's original draft assumed a return shape `{ added, entry }`; Phase 3's actual landed
  shape is `created`/`origin_attached` (the latter is true whenever an origin sentence was set on
  this call, whether the row was brand-new or already existed with no prior origin — D4). This
  phase's `SKILL.md` prose never names a raw JSON field, so no skill-text edit was needed; only the
  example output in `dword.md`'s verify script (Step 4) and this contract note changed. Field
  meanings:
  - `term`: the English headword to store (Latin-script, ≤80 chars, ≤6 words — dword's
    `MAX_TERM_CHARS`/`MAX_TERM_WORDS`, `~/daily-words/src/lib/vocab/normalize.ts:14,17`).
  - `part_of_speech`: one of dword's `PART_OF_SPEECH_VALUES` (`vocab-enrich.ts:13-28`).
  - `pronunciation`: IPA string, British RP, ≤60 chars.
  - `definition`: ≤80 chars (aim ≤60).
  - `examples`: array of exactly 3 strings, each ≤120 chars (aim ≤100), each containing the term
    or an inflected form.
  - `origin` (object, present only for non-English input): `{ term: string (the original
    non-English text), language: string, context?: string (the sentence, if one was given) }`.
  - `context` (plain string, present only when `origin` is absent and the input was English with a
    `> sentence`): the sentence to store as `origin_context`. Per the design's D4/5.7 resolution,
    dword's own `dword_vocab_add` sets `origin_term = term` and `origin_language = 'English'` when
    it sees `context` with no `origin`.
  This phase's plan author (me) read these shapes out of the analysis document's "Processing
  chain" and "5.7" sections, not out of a landed `src/mcp/dwordVocabTools.ts` (phase 3's own plan
  file did not exist yet when this phase was planned, since phase planners run in parallel). If
  phase 3 lands a different argument shape, **the reconciler must edit `claude/skills/v/SKILL.md`'s
  tool-call JSON to match** — the skill text is prose, not code, so this is a safe fix-up with no
  recompilation.
- Phase 4 ships `dword_journal_find_similar({ text })` returning
  `{ verdict: 'duplicate' | 'none', entries: [...], layer2_skipped?: true }`, and
  `dword_journal_add({ text, insight, force?, source_note? })` returning **`{ verdict, inserted:
  boolean, entries, entry?, embedded: boolean, layer2_skipped?: true }`** — **[Reconciled]** this
  phase's original draft assumed `{ added, entry }`; Phase 4's actual landed shape uses `inserted`
  (not `added`) alongside the same `verdict`/`entries` the find-similar call returns, plus
  `embedded` (whether a Layer 2 vector was stored alongside the entry). `insight = { meaning: string
  (≤220 chars), whenItApplies: string[] (2-3 items, each ≤120 chars) }` is unchanged. This phase's
  `SKILL.md` prose does not name raw JSON fields either; only `dword.md`'s verify script example
  output (Step 4) and this contract note changed.
- Both phases register these four tool names verbatim (`dword_vocab_lookup`, `dword_vocab_add`,
  `dword_journal_find_similar`, `dword_journal_add`) reachable through the `notes` MCP server at
  `/mcp` — this phase calls them by exactly these names and no others.

**Leaves alone (owned by others):** `src/chat/*`, `src/chat/prompt.ts`, `src/chat/status.ts`
(Phase 6 — wall chat's own natural-language path to the same four tools); `src/mcp/dwordVocabTools.ts`,
`src/mcp/dwordJournalTools.ts` (Phases 3/4 — this phase only calls them, never edits them);
`src/connectors/*`, `src/dword/*` (Phases 1/2).

**Shared-file note for the reconciler:** Phase 6's own plan appends a `## Wall chat (phase 6)`
section to `.claude/skills/verify-notesd/features/dword.md` after this phase creates it with a
`## Claude Code skills (phase 5)` section. Phase 6 must not overwrite phase 5's section, and should
also widen `features/README.md`'s `dword` row's "Surfaces" cell from "MCP, Claude Code skills" to
add "wall chat" — this phase does not do that edit itself (it only knows about its own surface).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/skills/v/SKILL.md` | create | the `/v` skill: parse the separator, judge English vs. non-English, call `dword_vocab_lookup`, write the entry and call `dword_vocab_add` on a miss, reply |
| `claude/skills/j/SKILL.md` | create | the `/j` skill: call `dword_journal_find_similar`, write the insight and call `dword_journal_add` on no-match or explicit "save anyway", reply |
| `scripts/install.sh` | modify | add `v` and `j` to `SKILL_NAMES` (line 38) so the existing symlink/registration loop picks up both new skills |
| `.claude/skills/verify-notesd/features/dword.md` | create | feature-map entry for the Claude Code skill surface, following the four-section contract |
| `.claude/skills/verify-notesd/features/README.md` | modify | add one table row for the `dword` feature |

## Implementation Steps

### Step 0: Confirm `scripts/install.sh`'s skill loop is not glob-based

Read before assuming anything: `scripts/install.sh:38` is

```sh
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo)
```

an explicit array, consumed at lines 113-114 (`die` if `$SKILLS_SRC_DIR/$sk/SKILL.md` is missing
for any name in the array), 129-131 (refuse to clobber a non-symlink), 241-250 (`link_skill`:
`mkdir -p "$SKILLS_DIR"`, then for each name, symlink `$SKILLS_SRC_DIR/$sk` ->
`$SKILLS_DIR/$sk`), and 338-339 (printed in the install summary). **It is not glob-based.** A new
`claude/skills/v/` and `claude/skills/j/` directory is invisible to `install.sh` until their names
are added to this array — confirmed, not assumed, per the phase brief's instruction.

### Step 1: Add `v` and `j` to `scripts/install.sh`'s skill list

**File:** `scripts/install.sh:38`
**Change:** one-line edit, nothing else in the file changes (the loop, the `die` checks and the
summary print all key off this one array).
**Code:**
```sh
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo v j)
```
**Impact:** the next `scripts/install.sh` run symlinks `~/.claude/skills/v -> claude/skills/v` and
`~/.claude/skills/j -> claude/skills/j`, exactly like the four existing skills. Idempotent, like
every other `install.sh` step. (Per this repo's own memory note "No human in the loop", whoever
implements this phase runs `scripts/install.sh` themselves after landing it — that is an
implementation-time action, not part of this plan's Proof, since Proof must be something a
stranger verifier can run without touching the real `~/.claude/skills` or the real systemd unit.)

### Step 2: Write `claude/skills/v/SKILL.md`

**File:** `claude/skills/v/SKILL.md` (new)
**Change:** new file, full contents below.
**Code:**
```markdown
---
name: v
description: Look up or add a word or phrase in the user's personal vocabulary app, daily-words (dword), through the notes MCP server. Use whenever the user types "/v <word or phrase>" or "/v <word or phrase> > <sentence>" in any Claude Code session — e.g. "/v perch", "/v genteel", "/v in the nick of time", "/v pendulous breasts > she watched the dancer, her pendulous breasts bouncing with each step", "/v lari > Dia lari ke sekolah setiap pagi", "/v put up with -> he put up with a lot". Also use for a plain-English request to the same effect, such as "add this word to my vocab list", "look up genteel in dword", "save this phrase to daily-words".
argument-hint: <word or phrase>[ > <sentence>]
---

# /v — dword vocabulary

The text after `/v` names one word or phrase to look up or add in the user's personal vocabulary
app, daily-words (dword), reached through the `notes` MCP server's `dword_vocab_lookup` and
`dword_vocab_add` tools (they appear as `mcp__notes__dword_vocab_lookup` and
`mcp__notes__dword_vocab_add`). Do not answer from memory or guess that a word exists: dword's own
database is the source of truth, and a "found" answer must come from `dword_vocab_lookup`.

## Step 1: parse the input

The separator is a single `>`. Split the text after `/v` on the **first** `>` only — everything
before it is the term, everything after it (even if it contains another `>`) is the sentence.
Trim both sides.

- No `>` anywhere in the input: the whole trimmed input is the term, and there is no sentence.
- A `>` present: `term = trim(before the first '>')`, `sentence = trim(after the first '>')`.
  If, after trimming, `term` ends with a trailing `-` (someone typing the old `"->"` separator out
  of habit), drop that trailing `-` and trim again. A term never legitimately contains `>` or ends
  in `-`, so this is always safe.

Examples:
- `perch` -> term `perch`, no sentence.
- `pendulous breasts > she watched the dancer, her pendulous breasts bouncing with each step.` ->
  term `pendulous breasts`, sentence `she watched the dancer, her pendulous breasts bouncing with
  each step.`.
- `put up with -> he put up with a lot.` -> split on the first `>` gives raw term `put up with -`
  and sentence `he put up with a lot.`; the raw term ends with `-` after trimming, so strip it:
  term `put up with`.

## Step 2: decide English or non-English

Judge the term the way a dictionary editor would, not a strict machine check:

- Archaic, literary, dialect and regional English words are English ("genteel", "vittles",
  "perambulate").
- British and American spellings are both English; never "correct" one into the other.
- Proper nouns and words derived from them are English ("Dickensian").
- Abbreviations are English ("i.e.").
- Technical, legal and medical terms are English.
- Anything written in a different language's vocabulary or script (Indonesian "lari", Spanish
  "lugar", Japanese, etc.) is non-English.

**If the term is English:** `english_term` is the term as given (cleaned per Step 4), and, if a
sentence was given, keep it as `sentence_for_context` (used as the `context` argument in Step 5 —
NOT as `origin`).

**If the term is non-English:** decide the single best English headword that translates or glosses
it — this is what gets looked up and stored. Call it `english_term`. Keep the original input text
as `origin_term`, name the source language in English (e.g. `"Indonesian"`, `"Spanish"`) as
`origin_language`, and keep any given sentence as `origin_context`.

## Step 3: look up first

Call `dword_vocab_lookup` with `{ "term": english_term }`.

- **`found: true`:** the term is already in dword. Reply with the stored entry (format in Step 6)
  and say it was already there. **Stop here — do not call `dword_vocab_add`,** even if the user
  gave a sentence this time. (dword's own add tool handles attaching a first sentence to an
  existing word with no origin yet; that is not this skill's job.)
- **`found: false` with a non-empty `candidates` list:** these are close existing matches (a
  different inflection, or dword's own near-duplicate check). Show the candidate(s) briefly and
  ask whether one of them is what the user meant. If they confirm one, treat it exactly like a hit
  (reply with that entry, do not add). If they say it is a different word, or there are no
  candidates, continue to Step 4.
- **`found: false`, no candidates:** continue to Step 4.

## Step 4: write the entry yourself (on a miss)

dword has no enrichment model in the loop here — you write the entry, in the register of a printed
dictionary: plain, precise, unfussy, no hedging, no meta-commentary. These limits are hard, not
suggestions — mirrored from dword's own `vocab-enrich.ts`:

- `part_of_speech`: exactly one of `noun`, `verb`, `adjective`, `adverb`, `pronoun`, `preposition`,
  `conjunction`, `interjection`, `determiner`, `phrase`, `idiom`, `phrasal verb`, `abbreviation`,
  `other`. For a multi-word term whose meaning is not the sum of its parts, use `idiom`. For a verb
  plus particle, use `phrasal verb`. For a literal multi-word term, use `phrase`.
- `pronunciation`: IPA, between slashes, British Received Pronunciation, aiming well under 60
  characters, hard ceiling 60. For a phrase, transcribe the whole phrase. Example: `/dʒɛnˈtiːl/`.
- `definition`: one line, one clause, aim 60 characters, hard ceiling 80. Lower-case start unless a
  proper noun. No full stop at the end. Do not use the term itself inside the definition. Do not
  write "a word meaning" or "used to describe". One sense only — the one a general reader is most
  likely to have met. For an idiom, give the idiomatic meaning, never the literal one.
- `examples`: exactly 3 complete sentences, each containing the term or an inflected form of it,
  aiming under 100 characters each, hard ceiling 120. Each ends with a full stop. Three different
  everyday contexts, not three variations of one situation. No numbering, no quotes around them.
- `english_term` itself must be clean: letters, spaces, apostrophes, hyphens and full stops only,
  starting with a letter, at most 80 characters, at most 6 words. If your gloss needs more than 6
  words, tighten it to the core phrase.

Then call `dword_vocab_add`:

- English term, no sentence: `{ "term": english_term, "part_of_speech": ..., "pronunciation": ...,
  "definition": ..., "examples": [...] }`.
- English term, with `sentence_for_context`: add `"context": sentence_for_context` to the same
  object (no `origin` field).
- Non-English term: add `"origin": { "term": origin_term, "language": origin_language, "context":
  origin_context }` (omit `origin.context` if no sentence was given) to the same object. Do not
  also pass a top-level `context` in this case.

## Step 5: if a tool call fails

A failed `dword_vocab_lookup`/`dword_vocab_add` names the system and the reason ("dword is not
reachable: ...", a missing/unknown `DWORD_USER_EMAIL`, the daily add limit reached). Tell the user
which call failed and why, in one line. Do not guess at an entry, do not retry silently, and do not
fall back to writing a note instead.

## Step 6: reply

```
**<term>** · <part_of_speech> · <pronunciation>
<definition>
- <example 1>
- <example 2>
- <example 3>
[From <origin_language>: "<origin_term>"[ — <origin_context>]]

Found in dword. / Added to dword.
```
The `[From ...]` line appears only when the stored entry has an origin. Say plainly which case it
was (already there vs. just added) in the last line. Keep the rest of the reply to this shape —
no extra commentary unless the user asked a follow-up question.
```

**Impact:** new skill, additive; no existing file changes behavior.

### Step 3: Write `claude/skills/j/SKILL.md`

**File:** `claude/skills/j/SKILL.md` (new)
**Change:** new file, full contents below.
**Code:**
```markdown
---
name: j
description: Look up or add a saved line — a proverb, maxim, quote or turn of phrase — in the user's personal journal app, daily-words (dword), through the notes MCP server. Use whenever the user types "/j <saying>" in any Claude Code session — e.g. "/j A stitch in time saves nine", "/j the obstacle is the way", "/j <a line from a book or film they just read or watched>". Also use for a plain-English request to the same effect, such as "save this line to my journal", "add this quote to dword", "I want to keep this saying". If dword reports the line as a near-duplicate of one already saved, show the existing entry and stop unless the user explicitly says something like "save anyway" or "save it anyway, it's different" — then save it with force.
argument-hint: <saying, quote or line to save>
---

# /j — dword journal

The text after `/j` is one saved line — a proverb, maxim, sentence from a book or film, or a
phrasing the user liked — to look up or add in the user's personal journal app, daily-words
(dword), reached through the `notes` MCP server's `dword_journal_find_similar` and
`dword_journal_add` tools (`mcp__notes__dword_journal_find_similar`,
`mcp__notes__dword_journal_add`). Do not answer from memory: dword's own database is the source of
truth for whether this line is already saved.

## Step 1: check for a near-duplicate first

Call `dword_journal_find_similar` with `{ "text": <the line, as typed, trimmed> }`.

- **`verdict: "duplicate"`:** dword already has a close match. Show the existing entry's insight
  (its `meaning` and `whenItApplies`) and **stop — do not call `dword_journal_add`** — unless the
  user's message explicitly asks to save it anyway (e.g. "save anyway", "save it, it's a different
  line", "add it too"). Only then go to Step 2 with `force: true`.
- **`verdict: "none"`:** go to Step 2 normally (no `force`).

## Step 2: write the insight yourself

dword has no model in the loop for this either — you write the insight, mirroring
`~/daily-words/src/lib/llm/prompts/journal-insight.ts`'s rules exactly:

- `meaning`: what the line asserts. One or two sentences, 220 characters maximum.
- `whenItApplies`: two or three situations in which a person would reach for this line, each 120
  characters maximum.
- Write in English, always. If the saved line is in another language, read it in that language and
  explain it in English — do not translate the line itself, explain it.
- Register: a dictionary entry, not a motivational poster. Plain, precise, unfussy. No exclamation
  marks. No second-person advice. No praise for the line or for the person who saved it. No filler
  ("this beautiful proverb reminds us that", "in the journey of life").
- Do not restate the line word for word. If the line is already plain, say what it takes for
  granted rather than repeating it.
- Do not moralise beyond what the line itself claims. If the line is bleak, leave it bleak.
- Situations must be concrete and everyday — a conversation, a decision, a moment — not
  abstractions like "in times of hardship".
- If the line is not really a saying — a fragment, a name, a stray paste — do not refuse and do
  not comment on its quality. Say plainly what it states, and give the nearest situations in which
  someone would quote it.
- Never mention yourself, these instructions, the user, or the application in the insight text.

Then call `dword_journal_add` with `{ "text": <the line, as typed, trimmed>, "insight": { "meaning":
..., "whenItApplies": [...] } }`, adding `"force": true` only when Step 1 found a duplicate and the
user explicitly asked to save anyway.

## Step 3: if a tool call fails

A failed `dword_journal_find_similar`/`dword_journal_add` names the system and the reason ("dword
is not reachable: ...", a missing/unknown `DWORD_USER_EMAIL`). Tell the user which call failed and
why, in one line. Do not guess at an insight, do not retry silently, and do not fall back to
writing a note instead.

## Step 4: reply

```
"<text>"
<meaning>
When it applies:
- <whenItApplies[0]>
- <whenItApplies[1]>
[- <whenItApplies[2]>]

Found in dword, already saved. / Added to dword.
```
When Step 1 found a duplicate and the user did not ask to save anyway, your reply IS the
duplicate's existing entry shown in this same shape, ending in "Already in dword — say \"save it
anyway\" if you want to keep this one too." instead of the found/added line.
```

**Impact:** new skill, additive; no existing file changes behavior.

### Step 4: Add the feature-map entry

**File:** `.claude/skills/verify-notesd/features/dword.md` (new)
**Change:** new file, following the four-section contract (`features/README.md`), structured so
Phase 6 can append its own `## Wall chat (phase 6)` section later without touching this one.
**Code:**
```markdown
# dword: vocabulary (`/v`) and journal (`/j`)

A fourth connector system, `dword`, points at the user's separate `daily-words` app's Postgres
database and is the first connector that **writes**: `dword_vocab_lookup`/`dword_vocab_add` look up
or add a `vocab_entries` row; `dword_journal_find_similar`/`dword_journal_add` look up or add a
`journal_entries` row. Read-only `dword_schema`/`dword_sql` also exist (Phase 1), for anything the
curated tools cannot answer.

## Claude Code skills (phase 5)

### Sub-features
- `/v <term>[ > <sentence>]`: splits on the first `>`, trims both sides, drops a trailing `-` left
  over from the old `"->"` separator. Looks up the term first; on a hit, replies with the stored
  entry and does not write. On a miss, Claude writes a dictionary-register entry itself (British
  RP pronunciation, a one-clause definition, exactly 3 examples, the correct part of speech
  including `idiom`/`phrasal verb`/`phrase` for multi-word terms) and adds it. A non-English term
  stores the English gloss as `term` and the original text, its language and any sentence as
  `origin`; an English term with a sentence stores the sentence as `context` (dword's own 5.7
  resolution then sets `origin_language = 'English'`).
- `/j <saying>`: checks for a near-duplicate first (`dword_journal_find_similar`); on a
  `"duplicate"` verdict, shows the existing entry's insight and does not write, unless the user
  explicitly says to save it anyway (`force: true`). On `"none"`, Claude writes the insight itself
  (meaning ≤220 chars, 2-3 concrete everyday situations ≤120 chars each, English always, dictionary
  register, no advice or praise — mirrors dword's own `journal-insight.ts` prompt) and adds it.
- Either skill also accepts a plain-English request with the same intent ("add this word to my
  vocab list", "save this quote to dword"), per each `SKILL.md`'s `description`.
- The existing `notes-capture` Stop hook (`claude/hooks/notes-capture.mjs`) already captures the
  whole `/v`/`/j` exchange into the wall's `claude_code` chat history; this phase adds no new
  capture-path code.

### How to get to it (user POV)
Type `/v <word or phrase>` or `/v <word or phrase> > <sentence>`, or `/j <saying>`, in any Claude
Code session on this machine (the skills are symlinked into `~/.claude/skills` by
`scripts/install.sh`, reading `~/daily-words`'s database through `DAILY_WORDS_DIR` and
`DWORD_USER_EMAIL` in mcp-notes' own `.env.local`). The reply names the stored entry and whether it
was found or newly added.

### Driving it with verify.sh
A real Claude Code session reading a skill is not something `verify.sh` drives (the same reason it
never drives `/api/chat`: it would be a real, unscripted model run). This phase proves the
mechanics the skill text relies on instead — the exact MCP tool sequence `/v`/`/j` call in order —
against a throwaway daemon and a throwaway dword-shaped Postgres, never `~/daily-words`'s own
database.

Build the throwaway dword database in the same Postgres container `verify.sh` already uses
(`mcp-notes-pg-verify`, 127.0.0.1:55436, password `mcpnotes` — see `verify.sh`'s `PG_CONTAINER`/
`PG_PORT`/`PG_PASSWORD`), from `~/daily-words`'s own migrations, reusing Phase 1's test-harness
approach of rebuilding dword's schema from its `drizzle/*.sql` files rather than touching the real
one:

```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
DWD="${DAILY_WORDS_SRC:-$HOME/daily-words}"          # a daily-words checkout, read-only
DWORDDB=dword_v_$$
S=$(mktemp -d); mkdir -p "$S/daily-words"
P() { docker exec -i mcp-notes-pg-verify psql -v ON_ERROR_STOP=1 -X -q -U postgres "$@"; }

P -c "create database $DWORDDB"
for f in "$DWD"/drizzle/0*.sql; do P -d "$DWORDDB" < "$f"; done   # file-name order == migration order

cat > "$S/daily-words/.env.local" <<EOF
DATABASE_URL=postgres://postgres:mcpnotes@127.0.0.1:55436/$DWORDDB
DATABASE_URL_UNPOOLED=postgres://postgres:mcpnotes@127.0.0.1:55436/$DWORDDB
EOF

EMAIL=verify@dword.invalid
P -d "$DWORDDB" -c "insert into users (email) values ('$EMAIL')"

DAILY_WORDS_DIR="$S/daily-words" DWORD_USER_EMAIL="$EMAIL" $V up
```

Then, against that `RUN`:

```sh
# /v: miss, add, re-lookup is a hit
$V mcp RUN dword_vocab_lookup '{"term":"perch"}'
# -> {"found":false}
$V mcp RUN dword_vocab_add '{"term":"perch","part_of_speech":"noun","pronunciation":"/p3:tS/","definition":"a place where a bird rests","examples":["The sparrow sat on its perch.","She watched from her perch above the crowd.","The cat leapt onto the high perch."]}'
# -> {"created":true,"origin_attached":false,"entry":{"term":"perch",...}}
$V mcp RUN dword_vocab_lookup '{"term":"perch"}'
# -> {"found":true,"entry":{"term":"perch",...}}   -- the skill stops here, never re-adds

# /v: non-English origin shape round-trips
$V mcp RUN dword_vocab_add '{"term":"run","part_of_speech":"verb","pronunciation":"/rAn/","definition":"to move quickly on foot","examples":["He runs to school every morning.","She ran the last mile.","They run together on weekends."],"origin":{"term":"lari","language":"Indonesian","context":"Dia lari ke sekolah setiap pagi."}}'
# -> {"created":true,"origin_attached":true,"entry":{"term":"run",...}}
P -d "$DWORDDB" -c "select origin_term, origin_language, origin_context from vocab_entries where term='run'"
# -> origin_term=lari, origin_language=Indonesian, origin_context=Dia lari ke sekolah setiap pagi.

# /v: English term + sentence stores context, origin_language defaults to 'English' (phase 3's 5.7 resolution)
$V mcp RUN dword_vocab_add '{"term":"linger","part_of_speech":"verb","pronunciation":"/lINg@/","definition":"to stay somewhere longer than necessary","examples":["We lingered over coffee.","Her perfume lingered in the room.","He lingered at the door, unsure."],"context":"We lingered at the gallery."}'
# -> {"created":true,"origin_attached":true,"entry":{"term":"linger",...}}
P -d "$DWORDDB" -c "select origin_term, origin_language, origin_context from vocab_entries where term='linger'"
# -> origin_term=linger, origin_language=English, origin_context=We lingered at the gallery.

# /j: none, add, exact-text duplicate, force
$V mcp RUN dword_journal_find_similar '{"text":"A stitch in time saves nine."}'
# -> {"verdict":"none","entries":[]}
$V mcp RUN dword_journal_add '{"text":"A stitch in time saves nine.","insight":{"meaning":"Acting early on a small problem prevents a bigger one later.","whenItApplies":["Fixing a small leak before it floods the kitchen.","Raising a minor disagreement before it grows into a feud."]}}'
# -> {"verdict":"none","inserted":true,"entries":[],"entry":{...},"embedded":false,"layer2_skipped":true}  -- no OPENROUTER_API_KEY in this run, so Layer 2 is skipped (see Gotchas)
$V mcp RUN dword_journal_find_similar '{"text":"A stitch in time saves nine."}'
# -> {"verdict":"duplicate","entries":[{"text":"A stitch in time saves nine.","insight":{...}}]}   -- the skill shows this and stops
$V mcp RUN dword_journal_add '{"text":"A stitch in time saves nine.","insight":{"meaning":"Acting early on a small problem prevents a bigger one later.","whenItApplies":["Fixing a small leak before it floods the kitchen.","Raising a minor disagreement before it grows into a feud."]},"force":true}'
# -> {"verdict":"duplicate","inserted":true,"entries":[{...}],"entry":{...},"embedded":false}  -- a Layer-1 hit never computes a vector, forced or not
P -d "$DWORDDB" -c "select count(*) from journal_entries where text = 'A stitch in time saves nine.'"
# -> 2  -- "save anyway" inserted a second row instead of being blocked

$V down RUN
P -c "drop database $DWORDDB with (force)"
```

The exact pronunciation/example wording above is illustrative; what each step's *response shape*
proves is what matters (`found`/`created`/`inserted` booleans, `origin_*` columns, `verdict`, the duplicate-row
count), not the literal text any run happens to write.

### Gotchas
- This never touches `~/daily-words`'s real database: the throwaway `dword_v_<pid>` database lives
  in `mcp-notes-pg-verify`, built fresh from `$DWD/drizzle/*.sql` and dropped at the end. `$DWD`
  itself (default `~/daily-words`) is read only for its migration files, never written, never run.
- `$V exec`/`$V sql` read the **notes** database, not dword's; read dword rows with
  `docker exec mcp-notes-pg-verify psql ... -d $DWORDDB`, as shown above.
- Real env wins over `.env.local` (same rule the Seer Adversarial entry documents), so
  `DAILY_WORDS_DIR`/`DWORD_USER_EMAIL` set before `$V up` reach the daemon even though `cmd_up`'s
  own fixed env list does not mention them.
- No `--embed` is used above: journal similarity's Layer 2 (OpenRouter cosine distance) is skipped
  without `OPENROUTER_API_KEY`, same as search falling back to full-text. The `"none"`/`"duplicate"`
  verdicts above both come from Layer 1 (exact-text match), which needs no API key and costs
  nothing. Layer 2's threshold behavior is Phase 4's own proof, not this one's.
- A real Claude Code session actually reading `/v`/`/j`'s `SKILL.md` and typing the tool calls is
  not exercised by this script — same policy as not driving the chat bar. The mechanics above are
  what the skill text depends on; the prose itself is reviewed, not executed, by this harness.
- `scripts/install.sh`'s symlink step is never run by `verify.sh` (it touches the real
  `~/.claude/skills` and a systemd unit) — confirm the array edit by reading the file
  (`grep -n '^SKILL_NAMES=' scripts/install.sh`), not by running the installer in verification.
```

**Impact:** new feature-map entry, additive.

### Step 5: Add the `README.md` table row

**File:** `.claude/skills/verify-notesd/features/README.md`
**Change:** insert one row after the `adversary.md` row (the last one), before the trailing prose
paragraph.
**Code:**
```markdown
| dword vocabulary (`/v`) and journal (`/j`) | [dword.md](dword.md) | MCP, Claude Code skills |
```
**Impact:** the feature map lists the new entry; Phase 6 will widen the Surfaces cell to add "wall
chat" when it lands (see Handoffs).

## Principles applied

- Laziness protocol: reused `check-seer-adversarial-nightly`'s and `n`'s exact frontmatter shape
  (`name`/`description`/`argument-hint`) and `install.sh`'s existing one-array convention instead
  of inventing a new skill-discovery mechanism or a second place to register skill names.
- Boundary discipline: the skill text states dword's length/POS/example limits so Claude writes a
  conforming entry on the first try, but it is not a second validator — the one enforcement point
  stays in `src/dword/rules.ts`/`writer.ts` (Phase 2) and the tools built on them (Phases 3/4); the
  skill never re-implements a parser or a length check that could drift from theirs.

## Verification

**Build:** none — this phase adds no TypeScript. `npm run typecheck` still passes (unaffected).
**Tests:** none new — `npm test` and `npm run test:int` still pass (unaffected); this phase owns no
test files.
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`$V`), plus direct `docker exec ... psql` against a
  throwaway dword database built in `mcp-notes-pg-verify` from `~/daily-words`'s own
  `drizzle/*.sql` files — never `~/daily-words`'s real database.
- Feature-map entries: `.claude/skills/verify-notesd/features/dword.md` (`## Claude Code skills
  (phase 5)` section), `features/README.md` (new row).
- Journeys (all in `dword.md`'s "Driving it with verify.sh", reproduced in Step 4 above):
  1. `/v` miss -> add -> re-lookup is a hit: `dword_vocab_lookup` on `perch` returns `found:false`;
     `dword_vocab_add` returns `created:true` with the entry; a second `dword_vocab_lookup` on
     `perch` returns `found:true` with the same entry — proves the skill's lookup-first,
     add-on-miss, never-re-add-on-hit sequence is real.
  2. Non-English origin shape: `dword_vocab_add` with `term:"run"` and `origin:{term:"lari",
     language:"Indonesian", context:"..."}` round-trips; reading `vocab_entries` back by
     `docker exec ... psql` shows `origin_term=lari`, `origin_language=Indonesian`,
     `origin_context` set — proves the non-English argument shape the skill's Step 4 constructs is
     accepted and stored.
  3. English + sentence shape: `dword_vocab_add` with `term:"linger"` and `context:"..."` (no
     `origin`) round-trips; reading the row back shows `origin_term=linger`,
     `origin_language=English` — proves the skill's "English term with a sentence" branch (which
     omits `origin` and passes bare `context`) produces the 5.7-resolved row.
  4. `/j` none -> add -> exact-duplicate -> force: `dword_journal_find_similar` on a fresh saying
     returns `verdict:"none"`; `dword_journal_add` adds it; re-running `find_similar` with the same
     text returns `verdict:"duplicate"` with the stored insight; `dword_journal_add` with the same
     text and `force:true` inserts a second row (`select count(*) ... = 2`) — proves the skill's
     find-first, stop-on-duplicate-unless-"save anyway" sequence is real.
- Neighbor check: the existing connector tools (`expenses_*`, `runs_*`, `seer_*`) and generic
  `dword_schema`/`dword_sql` are untouched by this phase (no file this phase edits is imported by
  them); a smoke check is `$V mcp RUN --list` on the same `RUN` showing all of
  `dword_vocab_lookup`, `dword_vocab_add`, `dword_journal_find_similar`, `dword_journal_add`,
  `dword_schema`, `dword_sql` alongside the pre-existing tool names, confirming this phase did not
  accidentally shadow or rename anything Phase 1/3/4 registered.
- Cost: $0. No `--embed` (Layer 1 exact-match only, no OpenRouter call), no live Claude Code
  session, no billed Agent SDK run — only direct MCP tool calls against a throwaway daemon and a
  throwaway Postgres database.
**Exit criteria:** `claude/skills/v/SKILL.md` and `claude/skills/j/SKILL.md` exist with the
contents in Steps 2-3; `scripts/install.sh:38`'s `SKILL_NAMES` includes `v` and `j`
(`grep -n '^SKILL_NAMES=' scripts/install.sh` shows both); all four journeys above pass against a
throwaway daemon and throwaway dword Postgres; `features/dword.md` and `features/README.md` carry
the new entries.

## Handoffs

- Phase 6 appends a `## Wall chat (phase 6)` section to `.claude/skills/verify-notesd/features/dword.md`
  (this phase's section is `## Claude Code skills (phase 5)`, left alone) and should also widen
  `features/README.md`'s `dword` row's Surfaces cell from "MCP, Claude Code skills" to add "wall
  chat" — not done here since this phase only knows about its own surface.
- If Phase 3's `dword_vocab_add`/`dword_vocab_lookup` or Phase 4's `dword_journal_add`/
  `dword_journal_find_similar` land with field names or shapes different from the ones recorded
  under "Requires" above (read from the analysis document, not from a landed phase-3/4 plan, which
  did not exist yet when this phase was planned), the reconciler must edit the tool-call JSON in
  `claude/skills/v/SKILL.md` and `claude/skills/j/SKILL.md` to match the landed signatures. This is
  a prose edit with no code or test to re-run.
- Actually running `scripts/install.sh` to symlink the two new skills into the real
  `~/.claude/skills` (and the resulting daemon rebuild/restart) is implementation-time work for
  whoever lands this phase, not something this plan's Proof performs — verification only confirms
  the array edit is present in the source file.

## Rollback

`git revert` the commit(s) that add `claude/skills/v/`, `claude/skills/j/`, the `install.sh`
one-line edit, and the two feature-map files/row. If `scripts/install.sh` has already been run
against the real machine, re-run it after the revert (or run `rm ~/.claude/skills/v
~/.claude/skills/j` by hand) to remove the now-dangling symlinks — `install.sh` itself never
deletes a skill symlink for a name no longer in `SKILL_NAMES`. No dword or mcp-notes database state
is affected either way: this phase writes no rows anywhere outside its own throwaway Proof run.
