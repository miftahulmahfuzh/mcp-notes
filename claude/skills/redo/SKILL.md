---
name: redo
description: Use when the user types "/redo <method> <TICKER>" (e.g. "/redo A SLB"), or asks to redo, re-check or re-research Claude's Seer Adversarial verdict on one stock, usually because the first review could not open any news page. Redoes the review with real web search and writes the new verdict to Seer, but only while the pick's session has not opened; after the US open it just explains why a redo would be stale.
---

# /redo <method> <TICKER>

Redo Claude's Seer Adversarial review of one pick, this time with working web search, and replace the
old verdict. Example: `/redo A SLB` (`A` is the method: `A-GT`, or the short form `A`).

**Time is the whole point.** A verdict counts only if decided before the US open (09:30 New York) of the
pick's session: 21:30 WIB in US winter, 20:30 WIB in summer. After that the twin ignores it, so a redo
would only update a stale recommendation. The notes daemon checks this, not you; never guess the time.

## Steps

1. Parse the argument: the first word is the method, the second the ticker (any case). A third word
   that looks like a date (YYYY-MM-DD) is the session. If the method or ticker is missing, say so in
   one line and stop.
2. Call `mcp__notes__adversary_redo_context` with `strategy`, `symbol` (and `session` if given).
   - `ok: false`: say the `message` in one or two sentences (unknown method, not a pick, reviewer off,
     Seer unreachable) and stop.
   - `can_redo: false`: **stop here, do not research.** Tell the user in two or three short sentences,
     with the WIB times from `clock`: for `closed`, the session already opened at `open_wib` so a new
     verdict would not count, and that they can redo before the open next time; for `closing`, that it is
     too close to the open (`minutes_to_open` min) to finish a web review, start before `start_by_wib`.
     Offer an analysis-only answer in chat if they want one, labeled "stale, not recorded". Do not write
     anything.
   - `can_redo: true`: continue. Say in one line how long until the open.
3. Research. Follow `rules` from the context exactly, and judge through `lens` using `facts`.
   - `WebSearch` for the company's news, earnings, analyst moves, scheduled events in the method's
     horizon, and the sector or macro story behind a drop; `WebFetch` every page you rely on. Open about
     8 pages at most. If searching or fetching fails, say so and write `unsure` rather than inventing.
   - Use only what was published before now. Never use how the stock traded after the decision night.
4. Decide `agree`, `object` or `unsure` and call `mcp__notes__adversary_redo_submit` with the same
   `strategy`/`symbol`/`session`, the verdict, a `reason` (at most 600 characters, plain words for a
   non-trader, the company's name rather than its ticker, no trading jargon), the `sources` you opened
   (url, title, publisher, published_at when known) and your exact model id as `model`.
5. Report in a few lines: the verdict and why in one or two sentences, what it replaced (`replaced`),
   and that the wall's Seer Adversarial page already shows it. If `ok: false` (`too_late` means the
   open passed while you researched; `leased` means the other machine is reviewing), say that plainly
   and nothing was written. If `downgraded` is true, say the verdict became `unsure` because no page was
   cited.

## Rules

- Never write a verdict without having opened the pages you cite. Never cite a search snippet.
- Never call `adversary_redo_submit` after `can_redo: false`.
- Quote times in WIB. Keep every reply short.
