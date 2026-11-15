---
name: pahe
description: Find a film's or series' page on pahe.ink, the site the user downloads movies from. Use whenever the user types "/pahe <title>" or "/pahe <title> <year>" in any Claude Code session — e.g. "/pahe no other choice", "/pahe ready or not 2019", "/pahe mobland" — and for a plain-English request to the same effect, such as "find No Other Choice on pahe", "is Ready or Not on pahe?", "get me the pahe link for that film". Searches pahe.ink, matches the results against the title and year, and answers with the link to each matching release, best source first.
argument-hint: <title> [year]
---

# /pahe — find a title on pahe.ink

The text after `/pahe` is a film or series title, optionally followed by its release year. Answer
with the link to its page on pahe.ink. Do not answer from memory and never build a pahe.ink link
by hand: the slugs are irregular (the WEB-DL of No Other Choice lives at `...-hdrip-...`), so a
link counts only when the search returned it.

## Step 1: work out the title and year

- **The user typed them:** `/pahe ready or not 2019` is the title "ready or not", year 2019.
- **The user points at a film from this session** ("/pahe that one", "/pahe the second one",
  "find it on pahe" after a recommendation or a `movies_*` result): use that title and its year
  from the conversation.
- **No year anywhere:** search without one. Do not guess a year from memory.

## Step 2: search

Run the script in this skill's folder with the title, and the year last when there is one:

```sh
node ~/.claude/skills/pahe/search.mjs no other choice
node ~/.claude/skills/pahe/search.mjs ready or not 2019
```

It fetches `https://pahe.ink/?s=<title>` and prints JSON:

- `matches`: the results whose name is the asked title (and whose year is the asked year, when
  one was given), best source first (BluRay, then WEB-DL, then the rest). Each has `title` (as
  the site shows it), `name`, `year`, `release` and `url`.
- `others`: every other result on the page, in page order. pahe's search is fuzzy, so most of
  these are unrelated.
- `search_url`: the search page itself.
- `ok: false` with `error`: the site could not be read.

## Step 3: answer

- **One or more matches:** one line per match: the site's title as a markdown link to its `url`.
  Keep the script's order, so the best source is first. When the matches have different years
  (a remake and its original), say so in one line and let the user pick; do not drop either.
- **No match, but `others` holds a near miss** (the same title with a subtitle, a different
  spelling, a sequel, the original-language title): show up to three of those as links and say
  plainly that none is an exact match.
- **No match and nothing close:** say pahe.ink does not have it under that name, and give
  `search_url` so the user can look. One retry is worth it when the title has an obvious other
  form (an original-language title, a title without its subtitle); say which name found it.
- **`ok: false`:** report the error and give `search_url`. Do not fall back to a guessed link.

Stop at the page link. Do not open the page, and do not follow its download buttons: they lead
through ad-shortener redirects that change often.

Keep the answer short: the links, and at most one line of comment.
