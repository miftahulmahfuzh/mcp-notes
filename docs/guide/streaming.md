# Streaming and download sites

Films the library does not have are found on three outside sites, each with its own skill:

| Site | Skill | What it does | Chat bar |
| --- | --- | --- | --- |
| pahe.ink (downloads) | `/pahe <title> [year]` | Finds the title's page and links each release, BluRay first | Yes, through `WebFetch` |
| idlix (streaming) | `/idlix <title> [year]` | Finds the title, starts the film, shows it full screen | Yes, through `streaming_play` |
| lk21 (streaming) | `/lk21 <title> [year]` | The same | Yes, through `streaming_play` |

Nothing is downloaded and nothing is stored: these are lookups, and for the streaming sites a
browser being driven on your screen.

Contents: [pahe.ink](#paheink) · [The streaming sites](#the-streaming-sites) ·
[What you can ask](#what-you-can-ask) · [How a film is started](#how-a-film-is-started) ·
[The streaming Chrome](#the-streaming-chrome) · [In the chat bar](#in-the-chat-bar) ·
[Adding a site](#adding-a-site) · [Failure answers](#failure-answers) ·
[Where the code is](#where-the-code-is) · [Proving a change](#proving-a-change)

## pahe.ink

```text
/pahe no other choice
/pahe ready or not 2019
```

- **In Claude Code** the `/pahe` skill (`claude/skills/pahe`) runs `search.mjs`, which fetches
  `https://pahe.ink/?s=<title>` and reads only the search results, not the page's menus and
  featured posts.
- **In the chat bar** the same request, or "find it on pahe" after a recommendation, reads that
  page with `WebFetch`.

The answer is a link per matching release, BluRay first, then WEB-DL. A result matches when its
name is the asked title, and its year is the asked year when one was given; without a year, a
remake and its original are both shown. The search is fuzzy, so most results are unrelated: with
no exact match the answer shows up to three near misses, or says the site does not have the title
and gives the search link. A link is never built by hand, because the addresses are irregular,
and the lookup stops at the title's page: the download buttons behind it are not followed.

## The streaming sites

Both streaming skills run one command, `claude/streaming/cli.mjs`, with a module per site in
`claude/streaming/sites/`:

| | idlix | lk21 |
| --- | --- | --- |
| Address | `https://z2.idlixku.com` (`IDLIX_ORIGIN`) | `https://tv12.lk21official.cc` (`LK21_ORIGIN`) |
| A plain request | Refused: Cloudflare answers 403 to `curl`, `WebFetch` and a headless browser | Answered |
| Search | The site's own `/api/search`, asked from inside the streaming Chrome | The search host named on the home page (`data-search_url`), asked directly |
| A film's page | `/movie/<slug>` | `/<slug>` |
| A series | `/series/<slug>`: a link, not started | Forwards to another site: a link, not started |
| Before the film | A 7-second countdown, then an advert with "Skip Ad" after about 10 seconds | Nothing |
| The player | In the page itself | In a frame from another host, inside a second one |
| Time to a playing film | About 25 seconds | 6 to 20 seconds |

Both sites move between hosts (`z1`, `z2`; `tv11`, `tv12`). Set the `*_ORIGIN` variable when one
has moved: see [configuration](reference/configuration.md#streaming-sites).

A result matches when its English or original-language name is the asked title, and its year is
the asked year when one was given. A link is never built by hand: it counts only when the site's
search returned it.

## What you can ask

In Claude Code:

```text
/idlix no other choice
/lk21 ready or not 2019
is la brea on idlix?
find no other choice on lk21
```

- **`/idlix <title>` or `/lk21 <title>` puts the film on** when exactly one film matches.
- **A question is a lookup.** "Is it on idlix?" answers with the link and starts nothing.
- **Several matches start nothing.** The answer lists them; say which one and it is played by
  its link.
- **A series is a link only.** It has episodes to choose, and on lk21 it lives on another site.

## How a film is started

1. The streaming Chrome window comes to the front and opens the film's page.
2. The site's play button is pressed. On idlix the advertising tab that press opens is closed,
   the countdown is waited out and the site's own "Skip Ad" is pressed when the advert offers it.
   On lk21 the press goes to the player inside its frame, and the player's own play is pressed
   again when the first press only set it up.
3. Once the film is running, the window goes full screen and the player is stretched over it.

Things that are not obvious:

- **The film plays in the streaming Chrome, not in your own browser.** A link opens a fresh page,
  and a page that is already playing cannot be handed over through one. That Chrome has no ad
  blocker.
- **Full screen is the F11 kind.** A page's own full-screen button is refused for a click that
  does not come from the keyboard or mouse, so the whole window goes full screen and a style
  stretches the player over it. F11 leaves it; Esc removes the style and shows the page.
- **A hidden page stops a countdown.** Chrome is started with
  `--disable-features=CalculateNativeWinOcclusion`, so a window covered by another still counts
  as visible, and the window is brought to the front. Minimizing it during the wait stops the
  flow; the answer says at which stage, and asking again starts over.
- **One film at a time.** Starting a film closes the tabs of the other site.

## The streaming Chrome

`claude/streaming/cdp.ps1` is the Windows half. WSL cannot reach Windows loopback, so the part
that talks to Chrome runs in Windows PowerShell, as with VLC.

- It uses a Chrome with its own profile folder, `%LOCALAPPDATA%\notesd-stream-chrome`, and
  DevTools port 9333. Chrome refuses a debugging port on the default profile, so your everyday
  Chrome, its tabs and its logins are never touched.
- When that Chrome is not running it is started minimized, and it stays open afterwards: about
  4 seconds cold, under a second warm.
- One call evaluates one JavaScript expression, in the site's tab or in an embedded frame whose
  address matches a pattern, and prints the reply. Options bring the window to the front, make
  it full screen, and close the tabs that are not on the site.
- It never touches a Chrome it did not start, and never closes one.

## In the chat bar

The chat bar has no shell, so the daemon runs the same command for it through two MCP tools
(also available to Claude Code):

- `streaming_find` asks one site or all of them for a title and returns the links.
- `streaming_play` starts a film: by site and title, or by the link of a result.

"/idlix no other choice" or "put it on lk21" in the chat bar calls `streaming_play`; "where can
I watch it?" calls `streaming_find`. The bar never starts a film it was not asked to start. The
tools work on the machine with Windows Chrome; on the other one `streaming_play` answers with
the error and the bar gives the link. `NOTESD_STREAMING=off` turns both tools off.

## Adding a site

The `/create-streaming-skill` skill (`claude/skills/create-streaming-skill`) holds the method:
how to find a site's search request and its player, which of the two patterns above it follows,
and the list of files a new site touches. In short, a site is one module in
`claude/streaming/sites/` with a `search`, a `titlePath`, a `start` and a `playerSelector`, a
line in `sites/index.mjs` and in `STREAMING_SITES` (`src/streaming/service.ts`), and a skill
folder with a `SKILL.md` and a three-line `search.mjs`.

## Failure answers

| Answer | Meaning |
| --- | --- |
| `streaming_off` | `NOTESD_STREAMING=off`, or the daemon was started without the tools |
| `no_chrome` | Chrome is not installed on the Windows side |
| `chrome_not_reachable`, `no_tab` | Chrome did not start, or the site's page did not load in time |
| `the site answered HTTP 403` | Cloudflare is now refusing the real Chrome too |
| `no_frame` | lk21's player frame did not appear: the player changed, or the page is not a film |
| `the page has no play button` | idlix's page changed, or it is a series page |
| `playing: false` with `stage` | Where the flow stopped: `countdown`, `advert`, `play_button`, `loading`, `film` (the player is there and did not start) |
| A host that does not resolve | The site moved: set its `*_ORIGIN` |

A failure never falls back to a guessed link.

## Where the code is

| Path | What |
| --- | --- |
| `claude/streaming/cli.mjs` | The one command: find, `--play`, `--play-url` |
| `claude/streaming/sites/*.mjs`, `sites/index.mjs` | One module per site, and the list of them |
| `claude/streaming/match.mjs`, `play.mjs`, `chrome.mjs` | Title matching; the shared play flow and the fill-screen style; running `cdp.ps1` |
| `claude/streaming/cdp.ps1` | The Windows half: Chrome, tabs, frames, one expression |
| `claude/skills/pahe/`, `idlix/`, `lk21/` | The skills; `pahe/search.mjs` also holds the title parsing the others share |
| `claude/skills/create-streaming-skill/` | How to add a site |
| `src/streaming/service.ts` | `scriptRunner`: the daemon's way to run `cli.mjs` |
| `src/mcp/streamingTools.ts` | `streaming_find`, `streaming_play` |
| `src/chat/prompt.ts` | When the chat bar looks and when it plays |

## Proving a change

The feature map entry is `.claude/skills/verify-notesd/features/streaming.md`.

- Matching, result building and the tools are unit-tested with no network:
  `npx vitest run tests/unit/scripts tests/unit/streaming.test.ts tests/unit/mcp.streamingTools.test.ts`.
- A lookup on the live site is free: `node claude/streaming/cli.mjs lk21 ready or not 2019`.
  The idlix one opens the streaming Chrome, minimized.
- Playing is proven only live, and it takes over the screen and starts a film with sound:
  `node claude/streaming/cli.mjs lk21 --play <film>`. Run it when the owner expects it. A
  throwaway daemon never has the streaming tools (`deps.streaming` is unset), so they answer
  `streaming_off` there.
