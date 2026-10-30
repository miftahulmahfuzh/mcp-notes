# Iteration 5 — Connectors

One `/analyze` run covering ROADMAP iteration 5. Everything below the line is the owner's
request, verbatim input for /analyze Step 0.

---

Build mcp-notes iteration 5 ("Connectors") from docs/ROADMAP.md. The "Fixed decisions" table in
docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Other systems"
row (read-only; credentials read at runtime from each repo's `.env.local`; every connection
`default_transaction_read_only = on`; per system a `schema` tool, a row-limited `sql` tool and a
few curated tools; Seer also reads `~/seer/lab/lab.sqlite` read-only). Iterations 1–4 are on
main (plans: docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md, docs/plans/CHAT_BAR_BRAIN_PLAN.md).

The three systems are my own apps, each with its own Neon database and its own README:
  - ~/expense-tracking: expenses parsed from pasted text, in rupiah, grouped by month, with
    categories and photos (README.md, lib/db/schema.ts).
  - ~/run-insights: Apple Watch runs read from screenshots (pace, distance, heart rate, splits),
    weekly/monthly reviews, and a coach, Nina (README.md, lib/db/schema.ts).
  - ~/seer: a quantitative trading lab. Strategies, positions, trades, a leaderboard, and Sera,
    the method lab, whose experiments live in ~/seer/lab/lab.sqlite (README.md, db/, lab/,
    engine/).
Read each repo's schema and README to learn what the data means. Do not edit anything in those
repos, and do not import their code: they are separate projects that change on their own.

R1 — Connector core. One connector module per system behind a shared shape, so a fourth system
is one more module. Each connector:
  - reads that repo's `.env.local` at call time (not at daemon start, so rotated credentials work
    without a restart) and never copies a secret into this repo, a log, a note or a tool result;
  - opens its Postgres connection with `default_transaction_read_only = on` and also runs every
    query inside a read-only transaction, so a write fails at the database even if a tool were
    wrong;
  - has a statement timeout and a row cap, and returns rows as compact JSON with the column
    names;
  - fails soft: a missing repo, a missing `.env.local` or an unreachable database is a short tool
    error ("expense-tracking is not reachable: …"), never a daemon crash, and the other
    connectors keep working.
Seer's lab.sqlite is opened read-only (`mode=ro`, no write lock taken, safe while Seer's own
processes use the file).

R2 — MCP tools, per system, registered on the existing `notes` MCP server so `/n` and the chat
bar get them with no extra registration:
  - `<system>_schema`: tables, columns, types and the comments or meaning a reader needs, built
    from the live database (and for Seer, also lab.sqlite).
  - `<system>_sql`: a single read-only SELECT (or WITH … SELECT), row-limited, for questions the
    curated tools do not cover. For Seer it takes a `source` of `db` or `lab`.
  - A few curated tools per system that answer the common questions in one call, with
    descriptions written for Claude. Pick them from the usage examples and from what each app's
    own UI shows. At least:
      expense-tracking: spending for a date range (totals by category and by day, the largest
        items) and a single expense with its items.
      run-insights: runs in a date range with their key metrics, and one run in full (splits,
        heart rate, the app's own analysis text if it stores one).
      seer: the current leaderboard and open positions, and the best Sera methods so far with
        the metrics the lab uses to rank them.
  Dates use my timezone (WIB, Asia/Jakarta), money stays in rupiah as integers, and units are
  the app's own.
  The MCP server instructions gain one short paragraph on the connectors: they are read-only,
  what each system is, and "prefer the curated tools, use `_sql` only when they don't answer".

R3 — Chat bar and /n. The chat bar agent (src/chat) allows the new tools exactly as it allows
the notes tools, and its status line gets captions for them ("reading expenses", "reading
runs", "reading seer"). The `/n` skill (claude/skills/n/SKILL.md) learns that questions about
spending, runs and Seer go to those tools, and that the answer should say what the data shows
and what Claude thinks about it, not just a tally.

R4 — Fix from iteration 4. Chat bar answers that cite web pages end with raw markdown links
("[BookBrowse summary](https://…)"), because the answer panel renders plain text. Make links
readable in the panel: either the panel turns URLs and markdown links into real, underlined
links in the design's caption style, or the system prompt asks for bare URLs. Planner's choice,
but the panel must never show raw markdown link syntax.

R5 — Tests. Unit tests for the read-only guard (writes and multi-statement SQL rejected before
they reach the database), the row cap, env loading and the fail-soft paths. Integration tests run
each connector against a Docker Postgres seeded from that repo's drizzle migrations (read from
the sibling repo at test time, skipped with a clear message if the repo is absent), plus a
temporary SQLite file for the lab. Prove that an INSERT through `_sql` fails inside the
database, not only in the guard. No test touches the real Neon databases. One opt-in live check
(excluded by default) runs each `_schema` tool against the real databases, read-only.

Acceptance (through `/n` in Claude Code and through the chat bar at http://localhost:7317):
  /n how are my spending this week? don't just tally the numbers and give me your inputs
  /n i did a run yesterday. show me how it went. what are your thoughts on this run?
  /n what are the best sera method that we have found up until now?
  /n compare my running this month with last month
  how much did i spend on meals in october, and which week was the worst?

Out of scope: any write to the three systems; changes to the three repos; embeddings and
semantic search (iteration 6); image sync; connectors to anything else; caching their data in
the notes database.
