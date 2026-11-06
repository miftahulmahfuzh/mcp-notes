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
