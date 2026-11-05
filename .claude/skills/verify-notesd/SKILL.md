---
name: verify-notesd
description: Prove a notesd change works by driving a real, throwaway instance of the daemon (HTTP API, MCP tools, the wall web app) and capturing evidence. Use before reporting any mcp-notes change as done, when a plan's Proof section names feature-map entries, when a reviewer or swarm verifier must confirm another agent's work, or to reproduce a bug on main. Never touches the live daemon on 7317, Neon, ~/mcp-notes-data or ~/.claude.
---

# verify-notesd

"Tests pass" is not proof. Proof is the real daemon, built from the checkout under test, doing the
thing a user does, with the action and the resulting state saved as evidence a reviewer can open.

All driving goes through one script. Run it from the checkout (or worktree) being verified:

```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V            # usage
```

## Launch

```sh
$V up                 # prints RUN=<id>, URL=http://127.0.0.1:<port>, EVIDENCE=<dir>
$V up --web           # also rebuild web/dist first: REQUIRED when the change touches web/
$V up --sessions      # seed CLAUDE_HOME with tests/fixtures/claude-home (Projects page has data)
$V up --embed         # keep OPENROUTER_API_KEY: real embeddings, billed (default: off, search = fallback)
$V up --adversary     # Seer reviewer ON against a throwaway Seer DB built from ${SEER_DIR:-~/seer}/db/migrations
```

Each run gets its own database in the Docker container `mcp-notes-pg-verify` (127.0.0.1:55436,
created on first use, all migrations applied), a free port, its own `NOTES_DATA_DIR` and an
empty `CLAUDE_HOME`. The daemon runs from source with `tsx`, so server changes need no build. `up`
returns only after `/health` answers. Runs are isolated, so parallel verifiers each `up` their own.

Every run pins `NOTESD_ADVERSARY=off`, so a throwaway daemon never reads or writes the owner's
real Seer. `--adversary` turns the reviewer on against its own Seer database (`s_<run>` in the same
container) and a temp `SEER_DIR` that holds only that URL, the three data-tool keys from
`~/seer/.env.local` and Seer's `ticker_cik.csv`; `ADVERSARY_POLL_MS` (default 5000 here) and any
other `ADVERSARY_*` key in your shell pass through. A review it runs is a real, billed Agent SDK
run: set the toggle off first (`exec`, below) unless the journey means to pay.

## Doctor

```sh
$V doctor RUN
```

Read-only: process alive, `/health` answers, the port is owned by this run's process group, the
database answers, which checkout/HEAD it serves. Run it before the first drive and again after
any drive that surprised you. `code WARN HEAD moved` means the instance serves old server code:
`down` and `up` again.

## Drive

| Surface | Command | Notes |
| --- | --- | --- |
| HTTP | `$V api RUN METHOD /path ['{json}']` | Sends a same-origin `Origin` header, so bin/reveal routes accept it. |
| Upload | `$V upload RUN /api/images FILE ['body text']` | Multipart `file` (+ optional `body`). `/api/files` for non-images. Fixtures: `tests/fixtures/images/{plain.png,exif.jpg,photo.heic}`. |
| MCP | `$V mcp RUN TOOL '{json}'`, `$V mcp RUN --list` | Real MCP client over `/mcp`. Argument schemas live in `src/mcp/*.ts`. |
| Wall | `$V ui RUN steps.mjs` | Playwright, chromium, 1400x900. Records a video, a final screenshot, console errors. |
| State | `$V sql RUN "select ..."` | Read-only transaction against the run's DB. Use it to prove side effects. |
| Seed | `$V exec RUN [--seer] "SQL"` | WRITES to the run's throwaway notes DB, or with `--seer` its Seer DB (`--adversary` runs). For seeding only; prove state with `sql`. |
| Log | `$V note RUN "what this proved"` | Appends to `evidence/LOG.md`, the human-readable summary. |

A `steps.mjs` file (write it in the scratchpad, not the repo):

```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByLabel('Note text').fill('hello #demo')
  // ...act like the user, then assert on what the user would see:
  await page.getByText('hello').first().waitFor()
  await shot('after-save')
  log('note appears on the wall after save')
}
```

Prefer `getByRole` / `getByLabel` with the aria-labels the wall already has (`New note`,
`Note text`, `Delete note`, `Recycle bin`, `Projects`, `Chat history`, `Toggle sidebar`,
`Send`, ...; `grep -rhoE 'aria-label="[^"]+"' web/src` lists them) and the `data-testid`s
(`graph`, `project-view-toggle`, ...). Never use coordinates. A step that throws fails the run,
and you still get the screenshot and video.

## Evidence

Everything lands in `~/.local/state/notesd-verify/<RUN>/evidence/`, numbered in drive order:
`NN-api-*.txt` (request + status + body), `NN-mcp-*.txt`, `NN-sql-*.txt`, `NN-ui-*.{txt,png,webm}`,
and `LOG.md`.

Proof standards:
- Drive the real user path: the HTTP route, MCP tool or button a user would hit, not a service
  function or a test-only hook.
- Capture the action AND the resulting state. A `201` alone is not proof that the note exists.
  Read it back (`GET`, MCP `get`, or `sql`).
- Check side effects as well as the screen: rows written, files under the run's data dir,
  revisions kept, events seen by the wall.
- For a bug fix, show the failure first (on main or before the fix), then the pass.
- If you could not drive something, say `inconclusive` and name why. Never report a pass you
  did not observe, and never weaken a journey to make it pass.

The report you hand back lists the evidence files that prove each claim, one line each.

## Cleanup

```sh
$V down RUN       # kills exactly the process group `up` started, drops the run's DB, deletes its data dir
$V down --all     # every run still up
$V ls             # runs, state, evidence count
```

Evidence always survives `down`. Run `down` after every run, including failed ones. Never
`pkill node` or kill by name. The live daemon on 7317 is the user's.

## Feature map

`features/README.md` indexes what notesd does and what proves each feature works. A plan's
**Proof** section names entries from it. When your change adds or alters a user-facing feature,
update its entry (or add one) in the same change. Entries describe user-observable behavior,
not implementation.

## Gotchas

- `--web` matters: without it the wall serves whatever `web/dist` was built last, which may not
  be your change. `up` builds web only when `web/dist` is missing or `--web` is passed.
- Never drive these in verification, because they reach outside the sandbox: `POST .../reveal`
  (opens Windows Explorer), `POST /api/sessions/:id/resume` and the MCP `session_resume` tool
  (spawn real Claude sessions in tmux), and `/api/chat` / the chat bar (runs a real Claude
  agent and bills tokens). Drive chat only when the change is in chat, and say so in the report.
- Connector tools (`expenses_*`, `runs_*`, `seer_*`) read the user's real sibling databases.
  Read-only, but not sandboxed: prefer `npm run test:int` for them.
- Images made on "another machine" (`available: false`) cannot be produced locally. Insert a row
  with a different host via a test, not via this harness.
- Without `--embed`, search runs in full-text mode and reports `fallback`. That is expected, not a
  failure. Semantic ranking needs `--embed`.
