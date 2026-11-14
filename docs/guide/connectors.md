# Connectors: spending, runs, Seer and daily-words

The `notes` MCP server also reads four of the owner's other apps, straight from their own
databases, so `/n` in Claude Code and the chat bar on the wall can answer "how much did I spend on
meals in October?" or "how did yesterday's run go?" without a copy of that data living in the
notes. Three connectors are read-only. The fourth, daily-words, also takes new vocabulary and
journal entries through `/v`, `/j` and the chat bar, by a separate and narrow write path.

| System | Tools | App | What it holds |
|---|---|---|---|
| `expenses` | `expenses_*` | [expense-tracking](https://github.com/miftahulmahfuzh/expense-tracking) | Expenses parsed from pasted text, in whole rupiah, with categories and receipt photos |
| `runs` | `runs_*` | [run-insights](https://github.com/miftahulmahfuzh/run-insights) | Apple Watch runs (pace, distance, heart rate, splits), the app's analyses, weekly and monthly reviews, the coach Nina |
| `seer` | `seer_*` | [Seer](https://github.com/miftahulmahfuzh/seer) | The trading lab: strategies, positions, trades, the leaderboard, and Sera, the method lab, in `lab/lab.sqlite` |
| `dword` | `dword_*` | [daily-words](https://github.com/miftahulmahfuzh/daily-words) | Vocabulary (words and phrases with definitions, examples and where they were met) and a journal of sayings, each with its insight |

Every tool with its arguments is in [reference/mcp-tools.md](reference/mcp-tools.md), and the
settings are in [reference/configuration.md](reference/configuration.md). Seer Adversarial, which
reviews Seer's picks and writes verdicts into Seer's database through its own writer, is a
different subsystem: see [adversary.md](adversary.md).

## The tool pattern

Each system has the same three layers, and Claude is told to use them in this order:

1. **Curated tools** compute what the app itself shows (a spending breakdown, a run with its
   splits, the leaderboard as the app ranks it). They run fixed, parameterised queries. Use these
   first.
2. **`<system>_schema`** returns the tables, columns, types, comments, approximate row counts and
   constraints from the live database, plus a short text on what the data means (units, date
   rules, what is not stored). Claude calls it before writing SQL so table and column names are
   real.
3. **`<system>_sql`** runs one read-only `SELECT` (or `WITH ... SELECT`) for anything the curated
   tools do not answer. It returns `{columns, rows, row_count, truncated}`, 200 rows by default
   and 1,000 at most (`max_rows`). `truncated: true` means more rows existed. `seer_sql` and
   `seer_schema` also cover the lab: `source: "db"` (Postgres, the default) or `"lab"`
   (`lab.sqlite`, SQLite dialect).

| System | Curated tools |
|---|---|
| `expenses` | [`expenses_spending`](reference/mcp-tools.md#expenses_spending), [`expenses_months`](reference/mcp-tools.md#expenses_months), [`expenses_get`](reference/mcp-tools.md#expenses_get) |
| `runs` | [`runs_list`](reference/mcp-tools.md#runs_list), [`runs_get`](reference/mcp-tools.md#runs_get), [`runs_review`](reference/mcp-tools.md#runs_review) |
| `seer` | [`seer_leaderboard`](reference/mcp-tools.md#seer_leaderboard), [`seer_positions`](reference/mcp-tools.md#seer_positions), [`seer_sera_best`](reference/mcp-tools.md#seer_sera_best) |
| `dword` | [`dword_vocab_lookup`](reference/mcp-tools.md#dword_vocab_lookup), [`dword_vocab_add`](reference/mcp-tools.md#dword_vocab_add), [`dword_journal_find_similar`](reference/mcp-tools.md#dword_journal_find_similar), [`dword_journal_add`](reference/mcp-tools.md#dword_journal_add) |

Units and dates are the apps' own. Days are calendar days in Asia/Jakarta (WIB) and a week runs
Monday to Sunday. Money is whole rupiah, except Seer, which is US dollars and counts New York
trading sessions. Run units are metres, seconds, sec/km and bpm. Dates and times come back as
text in the Jakarta session time zone. For a comparison, Claude calls a tool once per period and
compares the results itself.

## What you can ask

`/n` routes these to the connector tools, not to the notes, and the reply is not a tally: it says
what the data shows, how it compares with the period before, what stands out, and gives at least
one suggestion, with the date range it used. The chat bar answers the same questions in plain
language.

### Spending (expense-tracking)

```
/n how is my spending this week? don't just tally the numbers, give me your read
/n how much did I spend on meals in October?
/n which week this month was the most expensive, and why?
/n show my monthly totals for the last six months. is the trend going up?
/n what was the biggest single purchase last month? show me the whole receipt
/n how much of my spending is eating and drinking compared with everything else?
```

`expenses_spending` takes an inclusive date range of up to 366 days and returns the total, the
split by category (slug and Indonesian label), by day and by ISO week, and the largest items.
Weeks the range cuts are marked partial. `categories` narrows it: `["meals"]` is everyday meals
only, and all eating and drinking is `["meals", "jajan", "dining", "snacks", "drinks"]`.
`expenses_months` gives zero-filled monthly totals with the current month marked in progress.
`expenses_get` opens one expense group: items, note, the original pasted text and photos.

### Runs (run-insights)

```
/n i did a run yesterday. show me how it went. what are your thoughts on this run?
/n compare my running this month with last month
/n what did the app's weekly review say about last week?
/n how did my heart rate zones look on Sunday's long run?
/n is my easy pace improving over the last eight weeks?
/n what has Nina told me about recovery lately?
```

`runs_list` returns reviewed runs in a range with key metrics, the app's headline for each and
period totals. `runs_get` takes a run id or a date (every run that day) and returns metrics,
per-km splits, heart-rate zones, the runner's note and the app's latest analysis. `runs_review`
returns the app's latest week or month review; when the app has not written one, `review` is null
and the totals still hold. Records, badges and the coach's chat are reached through `runs_schema`
and `runs_sql`.

### Seer and Sera

```
/n what's on the Seer leaderboard right now?
/n which strategy leads, and over what window?
/n what positions are open, and how are they doing?
/n what are the best sera methods that we have found up until now?
/n which Sera methods were eligible when they ran?
/n how many trades did the champion strategy make last month?
```

`seer_leaderboard` ranks the paper strategies the way the app does, over a common window, with
the benchmark, retired and too-new strategies listed apart with a reason. Returns, drawdowns and
Sharpe exclude the owner's monthly top-ups; `current_equity_usd` is the real balance.
`seer_positions` lists open bracket orders and book positions with marks and unrealised P&L.
`seer_sera_best` gives the best dev variant of each Sera method by MAR; `eligible_at_run` is the
verdict when the trial ran, so Claude says "eligible when it ran". Questions about Claude's
verdicts on Seer's picks belong to [adversary.md](adversary.md).

### daily-words

```
/v perch
/v in the nick of time
/v put up with > he put up with a lot from his neighbours
/v lari > Dia lari ke sekolah setiap pagi
/j A stitch in time saves nine
/j the obstacle is the way
/n how many words did I add to daily-words this month?
/n which sayings in my journal are about patience?
```

The first six write (see the next section). The last two are read questions that go through
`dword_schema` and `dword_sql`.

## daily-words: `/v` and `/j`

Two skills, `claude/skills/v` and `claude/skills/j`, work from any repository. The app has no
model in this loop: Claude writes the entry or the insight itself, inside daily-words' own
limits, and the tools store exactly what they are given.

### `/v <word or phrase>[ > <sentence>]`

1. **Parse.** The text is split on the first `>`: the term before it, the sentence you met it in
   after it. A trailing `-` left from typing `->` is dropped.
2. **English or not.** A non-English word (`lari`) is looked up and stored under its English
   headword (`run`), with the original word, its language and the sentence kept as the origin.
3. **Look up first** with `dword_vocab_lookup`. It matches, in order: the exact term, the
   original word behind an English entry, and an inflected form of the same single word
   (`studying` finds `study`). A near-identical spelling (`naive` for `naïve`) comes back as
   `candidates`, not as found, and Claude asks which one you meant.
4. **Found:** Claude shows the stored entry and stops. Nothing is written.
5. **Not found:** Claude writes the entry in dictionary register (part of speech, British IPA, a
   one-clause definition, exactly three example sentences that contain the term) and calls
   `dword_vocab_add`. An English term's sentence goes in `context`; a non-English term's goes in
   `origin`.

What `dword_vocab_add` guarantees, whoever calls it:

- A term already held is returned with `created: false`. Nothing is inserted twice.
- A sentence is stored as the entry's origin only when the entry has no origin yet
  (`origin_attached: true`). An existing origin is never overwritten.
- At most 50 adds in a rolling 24 hours, the app's own cap. Past it the tool refuses.
- The limits are the app's: a term of at most 80 characters and 6 words, a pronunciation of at
  most 60, a definition of at most 80, three examples of at most 120 each, a sentence of at most
  200.

### `/j <a line>`

1. **Check for a duplicate first** with `dword_journal_find_similar`, the same two-layer check
   daily-words runs:
   - Layer 1: an exact match after normalising whitespace, quote and dash glyphs, accents, case
     and punctuation at the edges. Free, no network.
   - Layer 2, only on a Layer 1 miss: an OpenRouter embedding of the line compared with the
     owner's stored entries. A cosine distance under 0.25 is a duplicate.
2. **`verdict: "duplicate"`:** Claude shows the existing entry with its insight and saves nothing,
   unless you say to save it anyway ("save anyway", "add it too"). Then it calls the add with
   `force: true`, which inserts a second row.
3. **`verdict: "none"`:** Claude writes the insight (what the line asserts, in at most 220
   characters, and two or three concrete everyday situations it fits, at most 120 each, always
   in English) and calls `dword_journal_add`. The entry is saved ready to read.

`dword_journal_add` runs the identical check itself, so a duplicate cannot slip in by skipping
the first call. A failed or unavailable embedding never blocks a save: the result carries
`layer2_skipped: true`, the entry is inserted, and daily-words' own backfill embeds the line
later. Layer 2 uses the `OPENROUTER_API_KEY` of mcp-notes (real environment first, then its
`.env.local`).

### From the chat bar

The chat agent has no skills and no slash commands. Its system prompt teaches the same flows, so
plain language works, and a message that starts with `/v` or `/j` is read for its meaning:

```
add the word perch, as in: the sparrow sat on its perch by the window
what does genteel mean? add it if I don't have it
save this: a stitch in time saves nine
```

One difference from `/v`: when the word is already held, has no origin, and you gave a sentence,
the chat agent calls `dword_vocab_add` again so the one-time origin attach runs. The `/v` skill
stops at "found".

### The write path

Reads and writes are separate code. The read connector cannot write, and the writer
(`src/dword/writer.ts`) can do exactly four things:

| Statement | When |
|---|---|
| `INSERT INTO vocab_entries` | A new vocabulary entry |
| `UPDATE vocab_entries` setting the three origin columns, guarded by `origin_term IS NULL` | Attaching a first origin to an existing entry |
| `INSERT INTO journal_entries` | A new journal entry |
| `INSERT INTO journal_entry_embeddings` | That entry's embedding row (a `failed` row when no vector was made, which the app's backfill retries) |

Every statement is parameterised and checked against that list before it reaches a connection
(`assertWritable`): one statement at a time, only those three tables, no other `UPDATE` shape, no
`DELETE` ever. The writer has a 15 second timeout.

### `DWORD_USER_EMAIL`

daily-words has user accounts, so every curated dword tool acts as one user: the one whose email
`DWORD_USER_EMAIL` names in mcp-notes' environment or `.env.local`. The email is resolved to a
user id on every call, never cached.

| Setting | Answer |
|---|---|
| Unset or blank | `daily-words user not configured: set DWORD_USER_EMAIL in .env.local` |
| An email with no account | `daily-words user <email> not found` |

In both cases the four curated tools refuse and nothing is written. `dword_schema` and
`dword_sql` need no user and keep working.

## How a connector finds its database

Nothing is configured in mcp-notes beyond, optionally, where the sibling repositories are. A
connector reads the app's own `.env.local`:

1. **Find the repository.** The default is a sibling of the home directory; a setting overrides
   it. Settings are read from the real environment first, then from mcp-notes' `.env.local`, on
   every call.

   | System | Setting | Default |
   |---|---|---|
   | `expenses` | `EXPENSE_TRACKING_DIR` | `~/expense-tracking` |
   | `runs` | `RUN_INSIGHTS_DIR` | `~/run-insights` |
   | `seer` | `SEER_DIR` | `~/seer` |
   | `dword` | `DAILY_WORDS_DIR` | `~/daily-words` |

2. **Read `<repo>/.env.local`** and take `DATABASE_URL` or `DATABASE_URL_UNPOOLED`, preferring the
   direct (non-pooler) host: a Neon pooler rejects the startup options that make the session
   read-only.
3. **Open one connection, run one query, close it.** There is no pool and no cache. Rotated
   credentials work without a restart, and a tool that is never called connects to nothing.
4. **Seer's lab** is the file `<SEER_DIR>/lab/lab.sqlite`.

Nothing from those files is copied into this repository, a log, a note or a tool result.

## How it stays read-only

A write would have to get past three independent layers.

- **The SQL guard** (`src/connectors/guard.ts`), for `_sql` tools only. Comments, string literals
  and quoted identifiers are masked first, so a word inside a literal is never judged. What is
  left must be exactly one statement starting with `SELECT` or `WITH`. It is refused if it
  contains a second statement, a writing or schema word (`INSERT`, `UPDATE`, `DELETE`, `INTO`,
  `CREATE`, `DROP`, `COPY`, `PRAGMA`, `ATTACH`, transaction control and the like), a function
  with effects outside the query (`pg_terminate_backend`, `set_config`, `pg_read_file`,
  advisory locks, `dblink`, `load_extension`), or a row lock (`FOR UPDATE`, `FOR SHARE`). The
  answer is `<app> query failed: refused before reaching the database: <reason>`.
- **The session.** Every Postgres connection starts with `default_transaction_read_only=on`, a
  statement timeout and `TimeZone=Asia/Jakarta`.
- **The transaction.** Every query runs inside `BEGIN READ ONLY` and is rolled back. A write fails
  at the database even if a tool were wrong.

`lab.sqlite` is opened with `readOnly: true` in a short-lived child process, so it takes no write
lock and is safe while Seer's own jobs use the file. Curated tools skip the guard because their
SQL is fixed in the code, but they run on the same read-only session and transaction.

## Limits and timeouts

| Limit | Value |
|---|---|
| Statement timeout | 10 seconds. `CONNECTOR_TIMEOUT_MS` changes it (100 to 300,000 ms; anything else is ignored), read on every call |
| Connection timeout | The statement timeout, capped at 10 seconds |
| Rows from `_sql` | 200 by default, 1,000 at most, with `truncated` |
| daily-words write | 15 seconds |
| `expenses_spending` range | 366 days |
| daily-words adds | 50 vocabulary entries per rolling 24 hours |

## Quirks and limits

- **A missing sibling is one short error, not an outage.** Every failure is a single line that
  names the app, and the notes, the other connectors and the rest of the turn keep working.
  Claude is told to say so and answer from the rest.

  | Situation | Answer |
  |---|---|
  | No repository at the path | `<app> is not reachable: no repository at ~/<dir>` |
  | No `.env.local` in it | `<app> is not reachable: no .env.local in ~/<dir>` |
  | No database URL in that file | `<app> is not reachable: ~/<dir>/.env.local has no DATABASE_URL or DATABASE_URL_UNPOOLED` |
  | Database down, bad credentials, network | `<app> is not reachable: <reason>` |
  | SQL error, timeout, guard refusal | `<app> query failed: <reason>` |

- **Errors are scrubbed.** The connection URL, user, password and host are replaced with `***`
  in every message, and a reason is cut at 300 characters.
- **The tools are always registered.** A machine without `~/seer` still lists `seer_*`; each call
  answers "not reachable". The second laptop works the same way and needs its own checkouts.
- **Nothing is cached in the notes database.** Every answer is read at the moment of the call, so
  a slow or sleeping database makes that call slow.
- **Seer Adversarial does write to Seer**, through its own allow-listed writer, not through this
  connector. The connector guard is never loosened for it. See [adversary.md](adversary.md).
- **The server's instructions describe the connectors as "three of the user's own apps, strictly
  read-only"** and list the dword tools among the curated ones without saying they can write. The
  `/v` and `/j` skills and the chat prompt carry the daily-words rules.
- **`/v` and `/j` exchanges are not saved to the chat history.** The capture hook stores `/n`
  turns only (see [claude-code.md](claude-code.md)). The same request typed in the chat bar is
  saved like any other chat turn.
- **Layer 2 needs a key.** Without `OPENROUTER_API_KEY` the journal check is Layer 1 only, so a
  reworded copy of a saved line is not caught.
- **A forced duplicate is a real second row.** Nothing here can delete it; remove it in
  daily-words.
- **The mirrored limits can drift.** daily-words' rules (parts of speech, length ceilings, the
  daily cap) are copied into `src/dword/rules.ts`, and the journal normalisation into
  `src/dword/journalSimilarity.ts`. `tests/unit/dword/rules.drift.test.ts` fails when they differ
  from the real repository.
- **No pictures of the connectors exist in these guides** on purpose: the only data they can show
  is real spending, runs, positions, vocabulary and journal lines.

## Where the code is

| Path | What it holds |
|---|---|
| `src/connectors/names.ts` | The four systems, every tool name, each system's label, setting and default directory |
| `src/connectors/register.ts` | Registers `_schema`, `_sql` and the curated tools on the MCP server |
| `src/connectors/env.ts` | Settings, repository lookup, reading the sibling `.env.local`, picking the direct URL, secrets to scrub |
| `src/connectors/connector.ts`, `pg.ts`, `lab.ts` | One query per call: the read-only Postgres run and the `lab.sqlite` reader process |
| `src/connectors/guard.ts`, `sql.ts`, `schema.ts` | The `SELECT`-only guard, the `_sql` tool, the `_schema` tool |
| `src/connectors/errors.ts`, `rows.ts`, `types.ts` | Error wording and scrubbing, the row cap, limits and interfaces |
| `src/connectors/expenses/`, `runs/`, `seer/` | Each system's description and curated tools |
| `src/connectors/dword/` | The daily-words description and the `DWORD_USER_EMAIL` lookup |
| `src/mcp/dwordTools.ts`, `dwordVocabTools.ts`, `dwordJournalTools.ts` | The four curated daily-words tools |
| `src/dword/writer.ts`, `rules.ts`, `journalSimilarity.ts` | The write allow-list, the mirrored limits, the duplicate check's normalisation and threshold |
| `claude/skills/v`, `claude/skills/j` | The `/v` and `/j` skills |
| `src/chat/prompt.ts` | The chat bar's connector and daily-words paragraphs |

## Proving a change

- **Never against the real apps.** A proof uses a throwaway database built from the sibling
  repository's migrations, never its real `.env.local`, which names production.
- **daily-words:** the feature map entry `.claude/skills/verify-notesd/features/dword.md` has the
  whole recipe: build a scratch dword database in the verify Postgres container from
  `~/daily-words/drizzle/*.sql`, point `DAILY_WORDS_DIR` and `DWORD_USER_EMAIL` at it, run
  `verify.sh up`, then drive `dword_vocab_lookup`, `dword_vocab_add`, `dword_journal_find_similar`
  and `dword_journal_add` with `verify.sh mcp`. `verify.sh sql` reads the notes database only;
  read dword rows with `psql` in the container.
- **Expenses, runs, Seer:** `npm run test:int` runs `tests/integration/connectors/`, which
  rebuilds each schema from the sibling repository's migrations, seeds made-up rows and skips a
  repository that is missing. `core.int.test.ts` proves the database refuses a write even without
  the guard.
- **Unit tests:** `tests/unit/connectors/` (guard, env, fail-soft answers, each curated tool's
  maths) and `tests/unit/dword/` (writer allow-list, similarity, drift).
- **The guard alone** can be checked on any throwaway daemon, because it refuses before a
  connection is opened:

  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V mcp RUN expenses_sql '{"sql":"delete from x"}'
  # expense-tracking query failed: refused before reaching the database: only SELECT or WITH ... SELECT is allowed, not DELETE
  ```

- A real `/v` or `/j` session and a chat-bar turn are model runs that `verify.sh` does not script.
  The chat journey in `dword.md` is billed; run it once, when the chat path changes.
