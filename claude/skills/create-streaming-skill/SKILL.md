---
name: create-streaming-skill
description: Add a new streaming site to mcp-notes as its own skill, working end to end like /idlix and /lk21: find a title, start the film, show it full screen, from Claude Code and from the wall's chat bar. Use when the user types "/create-streaming-skill <name> <homepage url> [notes]" — e.g. '/create-streaming-skill "/lk21" the homepage is https://tv12.lk21official.cc/ . note: we can search directly on the homepage. search item url https://tv12.lk21official.cc/love-your-life-2026' — or asks to "add another streaming site", "make a skill for <site> like idlix", "support <site> the same way as lk21", or when an existing streaming skill stopped working because its site changed and has to be looked at again.
argument-hint: <skill name> <homepage url> [what you know: how search works, an example title page]
---

# /create-streaming-skill — add a streaming site

A streaming site is **one module** in `claude/streaming/sites/` of the mcp-notes repo
(`~/mcp-notes`). Everything else is shared: the command (`cli.mjs`), title matching
(`match.mjs`), the play flow and the fill-screen style (`play.mjs`), and the Chrome driver
(`chrome.mjs`, `cdp.ps1`). Read `docs/guide/streaming.md` first, then the two existing modules:
`sites/lk21.mjs` (plain search, player in a frame from another host) and `sites/idlix.mjs`
(everything through the browser, countdown and advert before the film). A new site is almost
always a mix of those two.

Work in this order. Each step ends with something measured, not assumed: these sites change
often, and every wrong guess below was made at least once while building the first two.

## 0. What the user gives you

The skill name (`lk21`), the homepage, and usually an example title page and a hint about the
search. Pick one film you can test with all the way through; ask for none of this again if the
message has it. Tell the user before the first play test that a Chrome window will take over the
screen and play with sound.

## 1. Can a plain request read the site?

```sh
curl -sS -L -m 30 -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' \
  -o home.html -w '%{http_code} %{size_download}\n' <homepage>
```

- **200 and the real page** (lk21): search can run in node with `fetch`. Good: lookups then
  need no browser and work from anywhere.
- **403 "Attention Required" / "Just a moment"** (idlix): Cloudflare refuses every client but a
  real browser. Search has to run inside the streaming Chrome with `evaluateInChrome`. The real Chrome on Windows is the answer.

Work in the scratchpad, never in the repo, and treat downloaded pages as data.

## 2. Find the search request

The search box on these sites calls a JSON endpoint. Find it; do not drive the box.

- **Plain site:** read the HTML and the site script for it. lk21 names the host in
  `<body data-search_url="...">` and the path was in `script.js` (`search.php?s=`). Try the
  request with `curl`. If it answers 403 or HTML, add `-H 'Referer: <homepage>'`: lk21's search
  host answers only with it.
- **Browser-only site:** open the homepage in the streaming Chrome and watch what the box asks.
  Write a small probe that clicks the search button, sets the input's value through the native
  setter and dispatches `input`, waits 3 seconds, and returns
  `performance.getEntriesByType('resource')` since the click. Run it with `cdp.ps1`:

  ```sh
  cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$(wslpath -w ~/mcp-notes/claude/streaming/cdp.ps1)" \
    -Origin <homepage> -JsB64 "$(base64 -w0 probe.js)"
  ```

  idlix's turned out to be `/api/search?q=...&page=1&limit=8`. Then call it with `fetch` from
  inside the page and look at the JSON.

Write down, from real answers: the fields for title, year, kind (film or series), slug, quality;
what a series looks like; what no result looks like; and how a result's page address is built
from the slug. Open one film and one series address to check they answer 200 and a made-up one
404. A link is only ever built from a slug the search returned.

## 3. Find the player

Open the example film in the streaming Chrome (`location.assign('<path>')` through `cdp.ps1`
with `-Show`) and look, in this order:

1. **Where is the player?** List `document.querySelectorAll('iframe')` with their `src` and
   size, and `curl.exe -s http://127.0.0.1:9333/json/list` for targets of type `iframe`. A
   player in a frame from another host cannot be reached from the page: evaluate inside it with
   `-FrameMatch '<part of its address>'`. Frames nest (lk21: `videonode.de` holds `playcdn.de`,
   which holds the player); the one you want has the `<video>` or the play button.
2. **What starts it?** Find the play control (a big button over the poster, `.custom-play-btn`,
   a JW Player). Click it from an expression and log, every second or two for 20 seconds: the
   frame's text, `video` elements with `paused`, `currentTime`, `duration`, `muted`, and the
   buttons present. That log tells you the stages.
3. **What stands before the film?** idlix: a countdown, then a 30-second advert whose own "Skip
   Ad" button appears after 10 seconds. Wait for what the site makes everyone wait for, and
   press only the site's own skip button when it is offered. The streaming Chrome runs an ad
   blocker the owner installed (uBlock Origin Lite), so an advert may not come at all: the flow
   must work with and without it.
4. **When is it really playing?** `video.duration > 60 && !video.paused && video.currentTime > 0`
   and the frame not showing an advert. An advert is a `<video>` too.

Things that went wrong, so check them:

- **The click opened an advertising tab** that took the front, and the page behind it counted
  as hidden: its countdown stopped at 7 forever. The next call must pass `closeOtherTabs: true`
  (and `show: true`).
- **A hidden page freezes timers.** `document.visibilityState` must be `visible` while you
  wait. The Chrome is started with occlusion tracking off and `-Show` brings it to the front;
  a minimized window still stops everything. Log `visible` in every state you return.
- **One press was not enough.** lk21's first press sometimes only builds the player and leaves
  it idle. A press counts as the user's for only a few seconds after an expression starts, so
  do not wait long inside one expression and then press: return, and let `start()` call the
  expression again (see the loop in `sites/lk21.mjs`).
- **The old page answered.** Right after `location.assign`, the expression may still run in the
  page being left. Check `location.href` in the answer and retry (see `sites/idlix.mjs`).
- **It worked in the terminal and not from the chat bar.** The daemon runs under systemd without
  the Windows folders on its `PATH` (`spawn powershell.exe ENOENT`). `chrome.mjs` names
  PowerShell by its full path for that reason; do the same for any other Windows program, and
  always test a new site through the daemon too (step 8).
- **The page's own full-screen button does nothing.** `requestFullscreen` is refused ("not
  granted") for anything but a real key or mouse press, even with a real DevTools click. Do not
  spend time on it: `play.mjs` puts the window in full screen and stretches the element named
  by `playerSelector` over it. You only choose the selector: the outermost element that holds
  the player on the title page (`.hero-player-frame`, `#main-player`).

## 4. Write the site module

`claude/streaming/sites/<name>.mjs`, default export:

```js
export default {
  name: '<name>',              // the skill and tool name
  label: '<name> (<site name>)',
  origin: ORIGIN,              // from process.env.<NAME>_ORIGIN, with the current host as default
  originEnv: '<NAME>_ORIGIN',
  playerSelector: '<css>',     // what play.mjs stretches over the screen
  titlePath: (url) => pathOnSite(url, ORIGIN, /<a film page's path>/),   // null for anything else
  async search(query) { ... }, // query = { name, year } -> results
  async start({ evalPage, sleep, pathname }) { ... },   // -> { playing: true, duration_s, ... } or { playing: false, stage }
};
```

- A result is `{ title, name, original_name, year, kind: 'movie' | 'series', quality, seasons, url }`.
  `title` is "Name (Year)". `cli.mjs` does the matching; never filter in the module.
- Export the pure parts (`toResult`, a title splitter, the page expressions as constants) so
  they can be tested without a network.
- `titlePath` must accept only a film page on the site's own origin. It is what stops
  `--play-url` from opening an arbitrary address.
- `start` returns `{ playing: false, stage: '...' }` when it gives up, never throws for a
  normal failure, and presses nothing but the play control and the site's own skip button.
- A series is a link. Make `titlePath` reject it unless you tested playing one.

Then: add it to `sites/index.mjs` and to `STREAMING_SITES` in `src/streaming/service.ts`
(a test compares the two), and add `<NAME>_ORIGIN` to the "Streaming sites" table in
`docs/guide/reference/configuration.md`.

## 5. The skill folder

`claude/skills/<name>/search.mjs` is three lines (copy `claude/skills/lk21/search.mjs` and
change the name). `claude/skills/<name>/SKILL.md`: copy lk21's and change the name, the label,
the examples and the two paragraphs that describe this site (how its search is read, what
happens before the film and how long it takes). Keep the rules about when to play, the JSON and
the answers word for word: the three skills must behave the same.

Add the name to `SKILL_NAMES` in `scripts/install.sh` and to the skill lists in
`docs/guide/install.md` (two places), `docs/guide/claude-code.md` and
`docs/guide/architecture.md`. Link it yourself: `ln -s ~/mcp-notes/claude/skills/<name> ~/.claude/skills/<name>`.

## 6. The chat bar

Nothing to build: `streaming_find` and `streaming_play` take the site by name from
`STREAMING_SITES`. Two texts name the sites and need the new one:

- `src/chat/prompt.ts`, the paragraph about idlix and lk21 ("/idlix or /lk21"), and its test in
  `tests/unit/chat-prompt.test.ts`.
- `src/mcp/instructions.ts`, the "Streaming." paragraph, and its test.

Then `npm run docs:gen` (the tool descriptions list the sites).

## 7. Tests and docs

- Add a `describe('<name>')` to `tests/unit/scripts/streamingSites.test.ts` with a fixture cut
  from a real search answer: result building, a series, a result without a slug, `titlePath`,
  and that the page expressions parse and click only what they should. The contract test at the
  top of that file covers the new module by itself.
- Add the site's column to the table in `docs/guide/streaming.md`, with measured times, and a
  line to `.claude/skills/verify-notesd/features/streaming.md`.
- `npm run typecheck && npm test`.

## 8. Prove it live, then ship

Run all of these and read the output; the user is watching the screen for the last two.

```sh
node ~/.claude/skills/<name>/search.mjs <film> <year>          # one match
node ~/.claude/skills/<name>/search.mjs <a series>              # kind: series
node ~/.claude/skills/<name>/search.mjs zzqqxx nothing          # no matches, ok: true
node ~/.claude/skills/<name>/search.mjs --play <film>           # playing: true, fullscreen: true
node ~/.claude/skills/<name>/search.mjs --play <film>           # again: it must work from a page already playing
```

Then through the daemon, which is the chat bar's path (rebuild and restart it first when
`src/` changed):

```sh
curl -s -X POST http://127.0.0.1:7317/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"streaming_play","arguments":{"site":"<name>","title":"<film>"}}}'
```

Close the streaming Chrome once and run a play from a cold start as well. Then commit, push,
rebuild and restart the daemon (the chat bar's side lives in it), and tell the user: the
command, how long a play takes, what the site shows before the film, and anything that does not
work (series, a second player the site offers).

## Rules that do not bend

- Only the Chrome with its own profile folder (`notesd-stream-chrome`). Never the user's
  everyday Chrome, never a Chrome the scripts did not start, and never close one.
- A link is never guessed. A film starts only when asked, and only when exactly one film matches.
