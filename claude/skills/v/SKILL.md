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
sentence was given, keep it as `sentence_for_context` (used as the `context` argument in Step 4 —
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
