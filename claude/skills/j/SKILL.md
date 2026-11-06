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
