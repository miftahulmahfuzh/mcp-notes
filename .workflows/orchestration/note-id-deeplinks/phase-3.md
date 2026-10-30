# Phase 3: note-links Claude Code mod

**Plan set:** `NOTE_ID_DEEPLINKS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-180927-N8LK_code_analyzer.md`
**Satisfies:** R3 — note ids in Claude's replies are drawn as links to the wall, and `/open <id>` opens a note in the Windows browser from WSL
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `claude/mods/note-links`

---

## Goal

After this phase the repo holds a Claude Code mod, `claude/mods/note-links`, kept as source like `claude/skills/n`.
Once a person turns it on, every free-standing upper-case note id in an assistant reply is drawn as
`[A-B32](<wall>/?note=A-B32)` (an OSC 8 Ctrl-click link in the terminal), and `/open <id>` opens
`<wall>/?note=<ID>` in the Windows default browser via `explorer.exe`, with a fallback chain. The wall
base URL comes from a `userConfig` option (default `http://localhost:7317`), discovered from
`claude mcp get notes` while the option is left at its default.

**Prototype status.** Every file below was written and run in a scratch copy before this plan was
written (`/tmp/claude-1000/-home-miftah-mcp-notes/e30b4676-77de-4cec-91f5-c581ea53af4e/scratchpad/note-links/`):
`claude plugin validate` printed `✔ Validation passed`, `claude plugin test` printed `107 pass / 0 fail`,
and `tsc -p` over the folder (with the 2.1.314 declarations laid in `.claude-plugin/types/claude-code/`) exited 0.
The code blocks are those files verbatim.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates (all new files, all under `claude/mods/note-links/`):**
- `.claude-plugin/plugin.json` — plugin `note-links` v0.1.0; `userConfig` keys `wallUrl` (string, default `http://localhost:7317`), `discoverWallUrl` (boolean, default `true`), `linkifyReplies` (boolean, default `true`); `"types": "./types/index.d.ts"`
- `hooks/hooks.json` — `modules: ["./register.ts"]`
- `hooks/register.ts` — `register` (hooks `session.start`, `command.run{command=open}`, `ui.render{component=AssistantMessage}`), `settingsOf`, `DISCOVERY_TIMEOUT_MS`; `$.state` key `note-links.wall`
- `hooks/linkify.ts` — `DEFAULT_WALL`, `ID_PATTERN`, `hasCandidate`, `normalizeId`, `normalizeWallUrl`, `noteUrl`, `noteLink`, `wallFromMcpGet`, `splitFences`, `linkify`
- `hooks/open.ts` — `Run`, `RunInit`, `RunResult`, `Opener`, `OpenOutcome`, `EXPLORER_FALLBACK`, `OPEN_TIMEOUT_MS`, `OPENERS`, `openUrl`, `USAGE`, `idArgument`, `openCommand`
- `types/index.d.ts` — `NoteLinksWall`; `PluginState['note-links'] = { wall: NoteLinksWall }`
- `tests/linkify.test.ts`, `tests/open.test.ts`, `tests/register.test.ts`
- `tsconfig.json`, `README.md`
- Slash command `/open <note id>` (registered at `session.start`)

**Modifies:** `README.md` — one line in the "Repository layout" code block (after line 706, `claude/skills/n the /n skill, ...`).
**Signature changes:** none
**Requires (from earlier phases):** none. Shares with Phase 1 only the URL shape `<wall>/?note=<ID>` (Invariant 4); Phase 1 makes the wall honour it. The mod is correct and testable before Phase 1 lands (the link just opens the wall unscrolled).
**Leaves alone (owned by others):** `web/**` and the README "A tour of the wall" paragraph (Phase 1); `src/mcp/*`, `claude/skills/n/SKILL.md`, the README clickable-ids subsection, `docs/INSTALL.md` (Phase 2); `vitest.config.ts`, `tsconfig*.json`, `package.json`, `scripts/install.sh`, `.gitignore` (nobody).

## Decisions taken in this phase

| Fork | Chosen | Why |
|---|---|---|
| Rewrite form | `next({ ...e, props: { ...e.props, text } })` | The phase scope wrote `next({...e, text})`; the 2.1.314 types (`RenderInputOf`, `RenderPropsOf.AssistantMessage`) put `text` under `e.props`. Code wins on facts. |
| Redraw `UserMessage` too? | **No.** `AssistantMessage` only. | The person's prompt row is drawn as plain text ("A rewrite is printable text"), not markdown, so `[A-B32](url)` would show its brackets. `/open` covers ids the person types. Reconciler: the index's Decision "Build the mod" lists "ids typed by the person" as a value; that value is delivered by `/open`, not by the redraw. |
| Tool results (`ToolResult`) | Not redrawn | They hold JSON from `mcp__notes__*`; rewriting would corrupt it. |
| Case rule | Redraw: upper-case dashed `A-B32` only. `/open`: any case, dash optional (same as `src/notes/ids.ts` `normalizeId`) | Lower-case words (`e-mail`, `t-shirt`) and lower-case hex never link. |
| Requirement-id collisions | Documented limitation: an upper-case word of the exact shape (`X-RAY`, `R-123`) is linked | Telling it from an id would need a server round-trip per draw. Pinned by a test. |
| Wall URL source | `wallUrl` option; while it is the default and `discoverWallUrl` is on, `claude mcp get notes` at `session.start` (background) and lazily in `/open`; result kept in `$.state` so drawings re-render when it lands | No hard-coded port without an override. Verified on this machine: `claude mcp get notes` prints `URL: http://localhost:7317/mcp`, exit 0. |
| Opener chain | `explorer.exe` (PATH) -> `/mnt/c/WINDOWS/explorer.exe` -> `powershell.exe -NoProfile -NonInteractive -Command Start-Process '<url>'` -> `cmd.exe /c start <url>` (cwd `/mnt/c`); explorer's exit code ignored (exits 1 on success, same rule as `src/http/reveal.ts` `spawnDetached`); powershell/cmd need exit 0 | `wslview`/`xdg-open` are absent here. The wall URL is restricted (`normalizeWallUrl`) to have no quotes, spaces or parentheses, so the PowerShell quoting and the markdown link are safe. |
| Where tests run | `claude plugin test claude/mods/note-links` only | `vitest.config.ts` includes only `tests/unit/**` and `web/src/**`; `tsconfig.json` includes only `src`/`tests`. The mod is invisible to `npm test` / `npm run typecheck`, so nothing there needs changing and the phase cannot break them. |
| `LICENSE` | Not added | The repo has no LICENSE; inventing one is not this phase's call. `validate` lists it as a *plugin-directory* problem only, which does not change its result. |

## Files

| File | Action | What changes |
|---|---|---|
| `claude/mods/note-links/.claude-plugin/plugin.json` | create | manifest, `userConfig`, types contract |
| `claude/mods/note-links/hooks/hooks.json` | create | names `./register.ts` |
| `claude/mods/note-links/hooks/linkify.ts` | create | pure id/URL rules and `linkify` |
| `claude/mods/note-links/hooks/open.ts` | create | `/open` text and opener chain, `run` injected |
| `claude/mods/note-links/hooks/register.ts` | create | the hooks module |
| `claude/mods/note-links/types/index.d.ts` | create | `$.state` contract (`note-links.wall`) |
| `claude/mods/note-links/tsconfig.json` | create | editor / `tsc -p` config from the types header |
| `claude/mods/note-links/tests/linkify.test.ts` | create | table-driven linkify + false positives + idempotence |
| `claude/mods/note-links/tests/open.test.ts` | create | opener chain, id argument, `/open` text |
| `claude/mods/note-links/tests/register.test.ts` | create | the hooks through the engine's test kit |
| `claude/mods/note-links/README.md` | create | what it does, settings, turning it on, checking it |
| `README.md` | modify (line 706, insert after) | one "Repository layout" line |

## Implementation Steps

All paths below are relative to the worktree root `/home/miftah/.worktrees/mcp-notes/note-id-deeplinks`.
Do not create `claude/mods/note-links/.claude-plugin/types/`: Claude Code lays it (with its own `.gitignore`) when it loads the mod.

### Step 1: Manifest
**File:** `claude/mods/note-links/.claude-plugin/plugin.json` (new)
**Change:** Plugin name, options, and the types contract that declares the `$.state` key (without it `validate` fails with `note-links.wall is not declared`).
**Code:**
```json
{
  "name": "note-links",
  "version": "0.1.0",
  "description": "Note ids (A-B32) in Claude's replies become links to the mcp-notes wall, and /open <id> opens a note in the browser from WSL.",
  "author": {
    "name": "miftahulmahfuzh"
  },
  "types": "./types/index.d.ts",
  "userConfig": {
    "wallUrl": {
      "type": "string",
      "title": "Wall URL",
      "description": "Base URL of the mcp-notes wall, without a trailing slash. Left at the default, the URL is taken from `claude mcp get notes` when discovery is on.",
      "default": "http://localhost:7317"
    },
    "discoverWallUrl": {
      "type": "boolean",
      "title": "Find the wall from the notes MCP server",
      "description": "At session start, read the notes server's URL from `claude mcp get notes` and use it (less /mcp) while Wall URL is left at its default.",
      "default": true
    },
    "linkifyReplies": {
      "type": "boolean",
      "title": "Link note ids in replies",
      "description": "Redraw Claude's replies so every free-standing note id is a link to the wall. Off leaves only /open.",
      "default": true
    }
  }
}
```
**Impact:** none outside the folder.

### Step 2: Hooks manifest
**File:** `claude/mods/note-links/hooks/hooks.json` (new)
**Code:**
```json
{
  "description": "Links note ids in replies to the mcp-notes wall; /open <id> opens one in the browser",
  "modules": ["./register.ts"]
}
```
**Impact:** none.

### Step 3: Pure linkify module
**File:** `claude/mods/note-links/hooks/linkify.ts` (new)
**Change:** The id rules (copied from `src/notes/ids.ts`: `ID_PATTERN`, `LOOSE_ID`, `normalizeId`; the mod cannot import from `src/`, it runs in the engine's own environment with no Node), wall-URL rules, and the scanner. No lookbehind regexes and no imports, so it runs in any ES2023 engine.

How the scanner decides (each rule has a test row in Step 8):
1. `splitFences` cuts out fenced blocks (``` / ~~~, closed by the same character at least as long; unclosed runs to the end).
2. In the rest, left-to-right: a backslash skips the next char; a backtick run skips to the matching run of the same length (inline code); `[`/`![` skips a whole inline link, image, `[text][ref]` or a line-start `[ref]: url`; `<scheme:...>` skips an autolink; at a word start, `scheme://...` or `www....` skips to the next space.
3. Otherwise `X-YYY` (upper-case/digits) is linked only when the char before is not one of ``0-9A-Za-z _ - . / \ @ # $ % & = + ~ :`` and the char after is not one of ``0-9A-Za-z _ - / \ @ # $ % & = + ~ ( [`` and is not `.`/`:` followed by a letter or digit (file name, host, port, `file:line`).
**Code:**
````ts
/**
 * Note ids in markdown become links to the mcp-notes wall.
 *
 * Pure: no engine, no `$`, no imports. The hooks module and the tests import it.
 *
 * A note id is one character, a dash, three characters, all from [0-9A-Z] (`A-B32`), the same
 * rule as `src/notes/ids.ts`. In a reply only the upper-case, dashed form is linked, and only
 * where it stands alone: not inside a fenced code block, an inline code span, a markdown link,
 * an autolink, a bare URL, a path, a file name, a hash, a UUID or a longer dashed word.
 * `normalizeId` (used by `/open`) is looser: any case, dash optional.
 */

/** The wall the daemon serves when nothing else is known. */
export const DEFAULT_WALL = 'http://localhost:7317'

/** Canonical form only. */
export const ID_PATTERN = /^[0-9A-Z]-[0-9A-Z]{3}$/

const LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/

/** A candidate anywhere in a text: the fast path skips texts without one. */
const ANY_CANDIDATE = /[0-9A-Z]-[0-9A-Z]{3}/

/** True when `text` holds something id-shaped, before any boundary rule. */
export function hasCandidate(text: string): boolean {
  return ANY_CANDIDATE.test(text)
}

/** A character right before a candidate that makes it part of something longer. */
const BAD_BEFORE = /[0-9A-Za-z_\-./\\@#$%&=+~:]/

/** A character right after a candidate that makes it part of something longer. */
const BAD_AFTER = /[0-9A-Za-z_\-/\\@#$%&=+~([]/

/** After a candidate, `.` or `:` followed by a letter or digit is a file name, host or port. */
const JOINER = /[.:]/
const ALNUM = /[0-9A-Za-z]/

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** `[text](url "title")`, `![alt](url)`, `[text][ref]`: the whole construct is left alone. */
const LINK_AT = /!?\[(?:[^[\]\\\n]|\\.)*\](?:\((?:<[^<>\n]*>|[^()\\\s]|\\.|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|\[[^[\]\n]*\])/y

/** `<scheme:...>` autolinks. */
const AUTOLINK_AT = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y

/** `scheme://...` and `www....` up to the next space or angle bracket. */
const URL_AT = /(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|www\.)[^\s<>]*/y

/** `[label]: url` reference definitions, at the start of a line. */
const REFDEF_AT = /[ \t]{0,3}\[[^[\]\n]+\]:[^\n]*/y

/** Case-insensitive, dash-tolerant: `ab32`, `a-b32`, ` A-B32 ` -> `A-B32`; null for anything else. */
export function normalizeId(input: string): string | null {
  const m = LOOSE_ID.exec(input.trim().toUpperCase())
  if (m === null) return null
  return `${m[1]}-${m[2]}`
}

/**
 * The wall's base URL from a setting or from the MCP URL: trimmed, `/mcp` and trailing slashes
 * dropped. Null unless it is http(s) with a host and no query, fragment, space, parenthesis
 * or quote (a parenthesis ends the markdown link early, a quote breaks the PowerShell fallback).
 */
export function normalizeWallUrl(raw: string): string | null {
  let s = raw.trim()
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/mcp$/i, '')
  s = s.replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/?#()<>'"`]+(?:\/[^\s?#()<>'"`]*)?$/i.test(s)) return null
  return s
}

/** `<wall>/?note=<ID>`. `wall` is already normalised; `id` is canonical. */
export function noteUrl(wall: string, id: string): string {
  return `${wall}/?note=${id}`
}

/** `[<ID>](<wall>/?note=<ID>)`, the link form every phase writes. */
export function noteLink(wall: string, id: string): string {
  return `[${id}](${noteUrl(wall, id)})`
}

/**
 * The `URL:` line of `claude mcp get notes`, as the wall's base URL; null when there is none
 * or it is not an http(s) URL.
 */
export function wallFromMcpGet(stdout: string): string | null {
  const m = /^\s*URL:\s*(\S+)\s*$/m.exec(stdout)
  if (m === null || m[1] === undefined) return null
  return normalizeWallUrl(m[1])
}

type Segment = { isCode: boolean; text: string }

/** The lines of a text, each with its own line break. */
function linesOf(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const k = text.indexOf('\n', from)
    if (k === -1) {
      if (from < text.length) out.push(text.slice(from))
      return out
    }
    out.push(text.slice(from, k + 1))
    from = k + 1
  }
}

/**
 * Splits a markdown text into fenced code blocks (``` or ~~~, closed by a fence of the same
 * character at least as long; an unclosed fence runs to the end) and everything else.
 */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { isCode: false, text: '' }
  let fence: { char: string; length: number } | null = null
  const flush = (isCode: boolean) => {
    if (current.text !== '') out.push(current)
    current = { isCode, text: '' }
  }
  for (const line of linesOf(text)) {
    const body = line.replace(/\r?\n$/, '')
    if (fence === null) {
      const open = FENCE_OPEN.exec(body)
      const marker = open?.[1]
      const info = open === null ? '' : body.slice(open[0].length)
      const isFence = marker !== undefined && !(marker.startsWith('`') && info.includes('`'))
      if (isFence) {
        flush(true)
        fence = { char: marker.charAt(0), length: marker.length }
      }
      current.text += line
      continue
    }
    current.text += line
    const close = FENCE_CLOSE.exec(body)
    const marker = close?.[1]
    if (marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length) {
      fence = null
      flush(false)
    }
  }
  flush(false)
  return out
}

function startsCandidate(text: string, i: number): boolean {
  if (!ID_PATTERN.test(text.slice(i, i + 5))) return false
  const before = i > 0 ? text[i - 1]! : ''
  if (before !== '' && BAD_BEFORE.test(before)) return false
  const after = text[i + 5]
  if (after === undefined) return true
  if (BAD_AFTER.test(after)) return false
  if (JOINER.test(after)) {
    const next = text[i + 6]
    if (next !== undefined && ALNUM.test(next)) return false
  }
  return true
}

function matchAt(re: RegExp, text: string, i: number): string | null {
  re.lastIndex = i
  const m = re.exec(text)
  return m === null ? null : m[0]
}

/** Length of the run of `ch` starting at i. */
function runAt(text: string, i: number, ch: string): number {
  let j = i
  while (text[j] === ch) j++
  return j - i
}

/** End index (exclusive) of the inline code span opened by the backtick run at i, or -1. */
function codeSpanEnd(text: string, i: number): number {
  const n = runAt(text, i, '`')
  let j = i + n
  while (j < text.length) {
    const k = text.indexOf('`', j)
    if (k === -1) return -1
    const m = runAt(text, k, '`')
    if (m === n) return k + m
    j = k + m
  }
  return -1
}

/** Linkify one stretch of markdown that holds no fenced code block. */
function linkifyProse(text: string, wall: string): string {
  let out = ''
  let plainFrom = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      i = Math.min(text.length, i + 2)
      continue
    }
    if (ch === '`') {
      const end = codeSpanEnd(text, i)
      i = end === -1 ? i + runAt(text, i, '`') : end
      continue
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      if (i === 0 || text[i - 1] === '\n') {
        const def = matchAt(REFDEF_AT, text, i)
        if (def !== null) {
          i += def.length
          continue
        }
      }
      const link = matchAt(LINK_AT, text, i)
      if (link !== null) {
        i += link.length
        continue
      }
    }
    if (ch === '<') {
      const auto = matchAt(AUTOLINK_AT, text, i)
      if (auto !== null) {
        i += auto.length
        continue
      }
    }
    if (ALNUM.test(ch) && (i === 0 || !ALNUM.test(text[i - 1]!))) {
      const url = matchAt(URL_AT, text, i)
      if (url !== null) {
        i += url.length
        continue
      }
    }
    if (startsCandidate(text, i)) {
      const id = text.slice(i, i + 5)
      out += text.slice(plainFrom, i) + noteLink(wall, id)
      i += 5
      plainFrom = i
      continue
    }
    i++
  }
  return out + text.slice(plainFrom)
}

/**
 * Every free-standing upper-case note id in `markdown` becomes `[ID](<wall>/?note=ID)`.
 * Idempotent: an id already inside a link is left alone, so linkify(linkify(x)) === linkify(x).
 */
export function linkify(markdown: string, wall: string): string {
  if (!hasCandidate(markdown)) return markdown
  return splitFences(markdown)
    .map(seg => (seg.isCode ? seg.text : linkifyProse(seg.text, wall)))
    .join('')
}
````
**Impact:** none; imported by `register.ts`, `open.ts` and the tests.

### Step 4: `/open` logic
**File:** `claude/mods/note-links/hooks/open.ts` (new)
**Change:** The opener chain and answer text, with `$.process.run` injected as `run` so the tests fake it.
**Code:**
```ts
/**
 * `/open <id>`: the answer text and the browser launch, with the host command injected.
 *
 * Pure apart from `run`, which the hooks module binds to `$.process.run` and the tests fake.
 * From WSL the Windows default browser is reached through Windows binaries (`wslview` and
 * `xdg-open` are not installed here). `explorer.exe <url>` opens it and exits 1 even on
 * success, so its exit code is never read (the same rule as `src/http/reveal.ts`); only a
 * failure to start moves on to the next opener.
 */
import { normalizeId, noteUrl } from './linkify'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunInit = { cwd?: string; timeoutMs?: number }
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

export type Opener = {
  /** What the failure message calls it. */
  name: string
  argv: (url: string) => string[]
  cwd?: string
  /** Whether this exit code means the browser was asked to open the URL. */
  isOpened: (exitCode: number) => boolean
}

/** Where explorer.exe lives when /mnt/c/WINDOWS is not on PATH. */
export const EXPLORER_FALLBACK = '/mnt/c/WINDOWS/explorer.exe'

export const OPEN_TIMEOUT_MS = 10_000

/** Tried in order; the first that starts (and, past explorer, exits 0) wins. */
export const OPENERS: readonly Opener[] = [
  { name: 'explorer.exe', argv: url => ['explorer.exe', url], isOpened: () => true },
  { name: EXPLORER_FALLBACK, argv: url => [EXPLORER_FALLBACK, url], isOpened: () => true },
  {
    name: 'powershell.exe',
    argv: url => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`],
    isOpened: code => code === 0,
  },
  // cmd.exe refuses a UNC working directory (\\wsl$\...), so it starts from C:\.
  { name: 'cmd.exe', argv: url => ['cmd.exe', '/c', 'start', url], cwd: '/mnt/c', isOpened: code => code === 0 },
]

export type OpenOutcome = { isOpened: true; via: string } | { isOpened: false; failures: string[] }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs the openers in order until one opens `url`. Never throws. */
export async function openUrl(run: Run, url: string, openers: readonly Opener[] = OPENERS): Promise<OpenOutcome> {
  const failures: string[] = []
  for (const opener of openers) {
    try {
      const init: RunInit = { timeoutMs: OPEN_TIMEOUT_MS }
      if (opener.cwd !== undefined) init.cwd = opener.cwd
      const result = await run(opener.argv(url), init)
      if (opener.isOpened(result.exitCode)) return { isOpened: true, via: opener.name }
      failures.push(`${opener.name} exited ${result.exitCode}`)
    } catch (err) {
      failures.push(`${opener.name}: ${messageOf(err)}`)
    }
  }
  return { isOpened: false, failures }
}

export const USAGE = 'Usage: /open <note id>, for example /open A-B32 (case and the dash do not matter).'

/** The id-ish word of the arguments: the first word, without a leading `#` or wrapping `` ` ``, `[ ]`. */
export function idArgument(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? ''
  return first.replace(/^[#`[]+/, '').replace(/[`\]]+$/, '')
}

/** The text `/open` answers with; opens the browser when the argument is a note id. */
export async function openCommand(args: string, wall: string, run: Run): Promise<string> {
  const word = idArgument(args)
  if (word === '') return USAGE
  const id = normalizeId(word)
  if (id === null) {
    return `"${word}" is not a note id. Ids look like A-B32: one letter or digit, a dash, three letters or digits (the dash is optional, case does not matter).`
  }
  const url = noteUrl(wall, id)
  const outcome = await openUrl(run, url)
  if (outcome.isOpened) return `Opened ${id} on the wall: ${url}`
  return `Could not open a browser from here (${outcome.failures.join('; ')}). Open ${url} yourself.`
}
```
**Impact:** none.

### Step 5: Hooks module
**File:** `claude/mods/note-links/hooks/register.ts` (new)
**Change:** `session.start` registers `/open` and starts discovery in the background; `command.run{open}` answers its own command (no `next`), discovering first if nothing has landed; `ui.render{AssistantMessage}` rewrites `props.text`. Functions that take `$` are top-level declarations: `validate` refuses a `$` passed to a closure declared inside `register` (`$ is passed to "runDiscovery", which is not a function declared at the top of this file`).
**Code:**
```ts
/**
 * note-links: note ids in Claude's replies become links to the mcp-notes wall, and `/open <id>`
 * opens a note on the wall in the Windows browser from WSL.
 *
 * The redraw changes only what the transcript draws; the stored message, and what the model
 * reads, stay as they were.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { DEFAULT_WALL, hasCandidate, linkify, normalizeWallUrl, wallFromMcpGet } from './linkify'
import { openCommand } from './open'

/** The wall found from `claude mcp get notes` this session; '' while unknown. */
const discovered = atom({ plugin: 'note-links', key: 'wall' } as const, '')

export const DISCOVERY_TIMEOUT_MS = 15_000

/** What the options settle to once, at load. */
type Settings = {
  /** The wall from `wallUrl`, normalised; the default when unset or unusable. */
  configured: string
  /** Whether `claude mcp get notes` may replace the default. */
  discover: boolean
  linkifyReplies: boolean
}

export function settingsOf(options: PluginOptions): Settings {
  const configured = normalizeWallUrl(String(options.wallUrl ?? DEFAULT_WALL)) ?? DEFAULT_WALL
  return {
    configured,
    // A wall set by hand wins; discovery only ever replaces the default.
    discover: options.discoverWallUrl !== false && configured === DEFAULT_WALL,
    linkifyReplies: options.linkifyReplies !== false,
  }
}

/** The wall links point at now. */
async function wallOf($: EngineInterface, settings: Settings): Promise<string> {
  if (!settings.discover) return settings.configured
  const found = await read($, discovered)
  return found === '' ? settings.configured : found
}

/** Reads the notes server's URL off `claude mcp get notes`; keeps the configured wall on any failure. */
async function runDiscovery($: EngineInterface): Promise<void> {
  try {
    const out = await $.process.run(['claude', 'mcp', 'get', 'notes'], { timeoutMs: DISCOVERY_TIMEOUT_MS })
    if (out.exitCode !== 0) return
    const wall = wallFromMcpGet(out.stdout)
    if (wall !== null) await update($, discovered, () => wall)
  } catch {
    // No `claude` on PATH, or it timed out: the configured wall stands.
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'open',
      description: 'Open a note on the mcp-notes wall in the browser',
      argumentHint: '<note id>',
    })
    if (settings.discover) void runDiscovery($)
    return next(e)
  })

  on('command.run', { command: 'open' }, async ($, e) => {
    if (settings.discover && (await read($, discovered)) === '') await runDiscovery($)
    const wall = await wallOf($, settings)
    return { text: await openCommand(e.args, wall, (argv, init) => $.process.run(argv, init)) }
  }).catch(() => ({ text: `note-links: /open failed. Ids look like A-B32; the wall is at ${settings.configured}.` }))

  if (settings.linkifyReplies) {
    on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
      const text = e.props.text
      if (!hasCandidate(text)) return next(e)
      const linked = linkify(text, await wallOf($, settings))
      return linked === text ? next(e) : next({ ...e, props: { ...e.props, text: linked } })
    })
  }
}
```
**Impact:** none outside the mod. While loaded, replies' drawing changes; stored messages do not.

### Step 6: State contract
**File:** `claude/mods/note-links/types/index.d.ts` (new)
**Change:** A contract file exports types only (no `export {}`; `validate` refuses it) and must spell the key literally inside `PluginState` (a named alias for the whole object is refused).
**Code:**
```ts
/** The wall note-links found from `claude mcp get notes` this session; '' while unknown. */
export type NoteLinksWall = string

declare module 'claude-code' {
  interface PluginState {
    'note-links': { wall: NoteLinksWall }
  }
}
```

### Step 7: tsconfig for the mod
**File:** `claude/mods/note-links/tsconfig.json` (new)
**Change:** The config from the header of `types/claude-code.d.ts`, plus `types` in `include`. It types the mod once Claude Code has laid `.claude-plugin/types/` (or after copying `types/claude-code.d.ts` there by hand for a one-off check). The repo's root `tsconfig.json` does not include `claude/`, so `npm run typecheck` is unaffected.
**Code:**
```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [".claude-plugin/types", "hooks", "types", "tests"]
}
```

### Step 8: Linkify tests (table-driven false positives, idempotence)
**File:** `claude/mods/note-links/tests/linkify.test.ts` (new)
**Change:** Made-up ids only (`A-B32`, `K-4M7`, `Q-9ZZ`, `X-123`, `7-123`). Never use a real note id; never read notes O-5KD or V-UM6.
**Code:**
````ts
import { describe, expect, test } from 'claude-code/testing'

import { linkify, normalizeId, normalizeWallUrl, splitFences, wallFromMcpGet } from '../hooks/linkify'

// Made-up ids only. No real note's id or body belongs in this file.
const WALL = 'http://localhost:7317'
const L = (id: string) => `[${id}](${WALL}/?note=${id})`

type Row = readonly [name: string, input: string, expected: string]

const LINKED: readonly Row[] = [
  ['a lone id', 'See A-B32 for that.', `See ${L('A-B32')} for that.`],
  ['digits only', 'Saved as 7-123.', `Saved as ${L('7-123')}.`],
  ['at the start and end', 'A-B32', L('A-B32')],
  ['two ids, comma list', 'Q-9ZZ, K-4M7', `${L('Q-9ZZ')}, ${L('K-4M7')}`],
  ['in bold', 'Saved **A-B32**.', `Saved **${L('A-B32')}**.`],
  ['in parentheses', 'the note (A-B32) says', `the note (${L('A-B32')}) says`],
  ['in a list item', '- A-B32: groceries\n- K-4M7: rent', `- ${L('A-B32')}: groceries\n- ${L('K-4M7')}: rent`],
  ['in a table cell', '| A-B32 | groceries |', `| ${L('A-B32')} | groceries |`],
  ['before a sentence colon', 'A-B32: done', `${L('A-B32')}: done`],
  ['possessive', "A-B32's body", `${L('A-B32')}'s body`],
  ['after a fence closes', '```\nX-123\n```\nthen A-B32', `\`\`\`\nX-123\n\`\`\`\nthen ${L('A-B32')}`],
  ['beside a code span', '`X-123` and A-B32', `\`X-123\` and ${L('A-B32')}`],
  ['in link-less brackets', '[A-B32]', `[${L('A-B32')}]`],
]

const UNCHANGED: readonly (readonly [name: string, input: string])[] = [
  ['fenced code block', '```\nA-B32\n```'],
  ['fenced code with info string', '```ts\nconst id = "A-B32"\n```'],
  ['tilde fence', '~~~\nA-B32\n~~~'],
  ['unclosed fence runs to the end', '```\nA-B32\nK-4M7'],
  ['inline code span', 'run `get A-B32` now'],
  ['double-backtick code span', 'run ``a ` A-B32`` now'],
  ['existing link text', '[A-B32](http://localhost:7317/?note=A-B32)'],
  ['existing link URL', '[the note](http://localhost:7317/?note=A-B32)'],
  ['image alt', '![A-B32](pic.png)'],
  ['reference link', '[A-B32][1]'],
  ['reference definition', '[1]: http://localhost:7317/?note=A-B32'],
  ['autolink', '<http://localhost:7317/?note=A-B32>'],
  ['bare URL', 'open http://localhost:7317/?note=A-B32 now'],
  ['bare URL path', 'see https://example.com/A-B32/x'],
  ['www URL', 'www.example.com/A-B32'],
  ['relative path', './X-123.ts'],
  ['path segment', 'src/X-123/foo'],
  ['path, lower case', 'a-b32/foo'],
  ['file name', 'X-123.ts'],
  ['host:port or file:line', 'X-123:10'],
  ['windows path', 'C:\\X-123\\a'],
  ['lower-case hash segments', '3f2a-9b1c'],
  ['upper-case hash segments', '3F2A-9B1C'],
  ['upper-case UUID', '123E4567-E89B-12D3-A456-426614174000'],
  ['lower-case UUID', '123e4567-e89b-12d3-a456-426614174000'],
  ['longer: two before', 'AB-CDEF'],
  ['longer: four after', 'A-B32X'],
  ['longer: prefix letter', 'XA-B32'],
  ['longer: dashed chain', 'A-B32-C'],
  ['longer: dash before', 'X-A-B32'],
  ['issue key', 'UATP-2960'],
  ['lower-case word e-mail', 'send an e-mail'],
  ['lower-case word t-shirt', 'a t-shirt'],
  ['lower-case id', 'a-b32'],
  ['mixed case', 'A-b32'],
  ['no dash', 'AB32'],
  ['hashtag', '#A-B32'],
  ['email-ish', 'me@A-B32.example'],
  ['escaped', '\\A-B32'],
  ['underscore identifier', 'foo_A-B32'],
  ['query value', 'note=A-B32'],
  ['call', 'A-B32(1)'],
  ['index', 'A-B32[0]'],
  ['plain prose', 'Nothing to see here.'],
]

describe('linkify', () => {
  for (const [name, input, expected] of LINKED) {
    test(`links: ${name}`, () => {
      expect(linkify(input, WALL)).toBe(expected)
    })
  }

  for (const [name, input] of UNCHANGED) {
    test(`leaves alone: ${name}`, () => {
      expect(linkify(input, WALL)).toBe(input)
    })
  }

  test('is idempotent over every row', () => {
    for (const [, input] of [...LINKED, ...UNCHANGED.map(([n, i]) => [n, i, i] as const)]) {
      const once = linkify(input, WALL)
      expect(linkify(once, WALL)).toBe(once)
    }
  })

  test('known limitation: an upper-case word shaped like an id is linked', () => {
    // R-123 style tags and words like X-RAY share the shape; documented in the README.
    expect(linkify('X-RAY', WALL)).toBe(L('X-RAY'))
  })

  test('uses the wall it is given', () => {
    expect(linkify('A-B32', 'http://127.0.0.1:9000')).toBe('[A-B32](http://127.0.0.1:9000/?note=A-B32)')
  })
})

describe('splitFences', () => {
  test('separates prose and fenced code', () => {
    expect(splitFences('a\n```\nb\n```\nc')).toEqual([
      { isCode: false, text: 'a\n' },
      { isCode: true, text: '```\nb\n```\n' },
      { isCode: false, text: 'c' },
    ])
  })

  test('a shorter or other fence does not close', () => {
    expect(splitFences('````\n```\n~~~\n````\n')).toEqual([{ isCode: true, text: '````\n```\n~~~\n````\n' }])
  })
})

describe('normalizeId', () => {
  const rows: readonly (readonly [string, string | null])[] = [
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    ['  k-4m7 ', 'K-4M7'],
    ['', null],
    ['A-B3', null],
    ['A-B321', null],
    ['AB-C32', null],
    ['A_B32', null],
    ['e-mail', null],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(normalizeId(input)).toBe(expected)
    })
  }
})

describe('normalizeWallUrl', () => {
  const rows: readonly (readonly [string, string | null])[] = [
    ['http://localhost:7317', 'http://localhost:7317'],
    ['http://localhost:7317/', 'http://localhost:7317'],
    ['http://localhost:7317/mcp', 'http://localhost:7317'],
    [' http://localhost:8080/mcp/ ', 'http://localhost:8080'],
    ['https://notes.example/wall', 'https://notes.example/wall'],
    ['localhost:7317', null],
    ['ftp://localhost', null],
    ['http://localhost:7317/?x=1', null],
    ['http://localhost:7317/(x)', null],
    ["http://localhost:7317/'", null],
    ['', null],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(normalizeWallUrl(input)).toBe(expected)
    })
  }
})

describe('wallFromMcpGet', () => {
  test('reads the URL line and drops /mcp', () => {
    const out = 'notes:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: http://localhost:7400/mcp\n'
    expect(wallFromMcpGet(out)).toBe('http://localhost:7400')
  })

  test('null without a URL line, or for a stdio server', () => {
    expect(wallFromMcpGet('No MCP server found with name: notes')).toBe(null)
    expect(wallFromMcpGet('notes:\n  Type: stdio\n  Command: node server.js\n')).toBe(null)
  })
})
````

### Step 9: `/open` tests
**File:** `claude/mods/note-links/tests/open.test.ts` (new)
**Code:**
```ts
import { describe, expect, test } from 'claude-code/testing'

import { EXPLORER_FALLBACK, idArgument, openCommand, openUrl, USAGE } from '../hooks/open'
import type { Run, RunInit } from '../hooks/open'

const WALL = 'http://localhost:7317'

type Call = { argv: readonly string[]; init: RunInit | undefined }

/** A fake `$.process.run`: each executable either exits with a code or cannot start. */
function fakeRun(behaviour: Record<string, number | 'missing'>): { run: Run; calls: Call[] } {
  const calls: Call[] = []
  const run: Run = async (argv, init) => {
    calls.push({ argv, init })
    const b = behaviour[argv[0] ?? '']
    if (b === undefined || b === 'missing') throw new Error(`spawn ${argv[0]} ENOENT`)
    return { exitCode: b, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('openUrl', () => {
  test('explorer.exe exiting 1 counts as opened', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openUrl(run, `${WALL}/?note=A-B32`)).toEqual({ isOpened: true, via: 'explorer.exe' })
    expect(calls.map(c => c.argv)).toEqual([['explorer.exe', `${WALL}/?note=A-B32`]])
  })

  test('falls back to the absolute explorer path, then powershell, then cmd', async () => {
    const { run, calls } = fakeRun({ [EXPLORER_FALLBACK]: 'missing', 'powershell.exe': 1, 'cmd.exe': 0 })
    const out = await openUrl(run, `${WALL}/?note=A-B32`)
    expect(out).toEqual({ isOpened: true, via: 'cmd.exe' })
    expect(calls.map(c => c.argv[0])).toEqual(['explorer.exe', EXPLORER_FALLBACK, 'powershell.exe', 'cmd.exe'])
    expect(calls[2]?.argv).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process '${WALL}/?note=A-B32'`,
    ])
    expect(calls[3]?.argv).toEqual(['cmd.exe', '/c', 'start', `${WALL}/?note=A-B32`])
    expect(calls[3]?.init?.cwd).toBe('/mnt/c')
  })

  test('nothing starts: every failure is reported', async () => {
    const { run } = fakeRun({})
    const out = await openUrl(run, `${WALL}/?note=A-B32`)
    expect(out.isOpened).toBe(false)
    if (!out.isOpened) expect(out.failures.length).toBe(4)
  })
})

describe('idArgument', () => {
  const rows: readonly (readonly [string, string])[] = [
    ['a-b32', 'a-b32'],
    ['  A-B32  extra words', 'A-B32'],
    ['#A-B32', 'A-B32'],
    ['`A-B32`', 'A-B32'],
    ['[A-B32]', 'A-B32'],
    ['', ''],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(idArgument(input)).toBe(expected)
    })
  }
})

describe('openCommand', () => {
  test('normalises the id and opens the canonical URL', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openCommand(' ab32 ', WALL, run)).toBe(`Opened A-B32 on the wall: ${WALL}/?note=A-B32`)
    expect(calls[0]?.argv).toEqual(['explorer.exe', `${WALL}/?note=A-B32`])
  })

  test('no argument: usage, nothing run', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openCommand('   ', WALL, run)).toBe(USAGE)
    expect(calls).toEqual([])
  })

  test('not an id: says what an id looks like, nothing run', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    const text = await openCommand('hello', WALL, run)
    expect(text).toContain('"hello" is not a note id')
    expect(text).toContain('A-B32')
    expect(calls).toEqual([])
  })

  test('no browser: hands the URL back', async () => {
    const { run } = fakeRun({})
    const text = await openCommand('A-B32', WALL, run)
    expect(text).toContain('Could not open a browser from here')
    expect(text).toContain(`Open ${WALL}/?note=A-B32 yourself.`)
  })
})
```

### Step 10: Hooks tests through the engine's kit
**File:** `claude/mods/note-links/tests/register.test.ts` (new)
**Change:** The test's own hooks stand for the engine: `command.register`, `process.run` (`claude` answers a canned `mcp get` output or a deny; `explorer.exe` exits 1; anything else is denied, i.e. cannot start), and a bottom `ui.render` that records the `AssistantMessage` text it received. Options are passed with `test(name, { options }, body)`.
**Code:**
```ts
import { describe, expect, test } from 'claude-code/testing'
import type { On, RenderInput } from 'claude-code'

// Made-up ids only.
const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const MESSAGE = (text: string): RenderInput<'AssistantMessage'> => ({
  component: 'AssistantMessage',
  surface: 'terminal',
  requestId: 'msg-1',
  viewport: { columns: 120, rows: 40 },
  props: { text, isFirstOfReply: true },
})

const OPEN = (args: string) => ({
  command: 'open',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

type World = { commands: string[]; runs: (readonly string[])[]; drawn: string[] }

/** The engine beneath the plugin: commands, host commands and the transcript's own drawing. */
function worldOf(on: On, mcpGet: { exitCode: number; stdout: string } | 'missing'): World {
  const world: World = { commands: [], runs: [], drawn: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', ($, e) => {
    world.runs.push(e.argv)
    if (e.argv[0] === 'claude') {
      if (mcpGet === 'missing') return { deny: 'spawn claude ENOENT' }
      return { value: { ...mcpGet, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'explorer.exe') {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { deny: `spawn ${e.argv[0]} ENOENT` }
  })
  on('ui.render', ($, e) => {
    if (e.component === 'AssistantMessage') world.drawn.push(e.props.text)
    return { type: 'Text', children: [''] }
  })
  return world
}

const MCP_7400 = { exitCode: 0, stdout: 'notes:\n  Type: http\n  URL: http://localhost:7400/mcp\n' }

describe('session start', () => {
  test('registers /open', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['open'])
  })
})

describe('redraw', () => {
  test('links an id in a reply to the discovered wall', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    await $.command.run(OPEN('A-B32')) // waits for discovery when it has not landed yet
    await $.ui.render(MESSAGE('Saved as A-B32.'))
    expect(world.drawn.at(-1)).toBe('Saved as [A-B32](http://localhost:7400/?note=A-B32).')
  })

  test('without discovery the default wall is used', async ($, on) => {
    const world = worldOf(on, 'missing')
    await $.ui.render(MESSAGE('Saved as A-B32.'))
    expect(world.drawn.at(-1)).toBe('Saved as [A-B32](http://localhost:7317/?note=A-B32).')
  })

  test('a text with no id reaches the engine unchanged', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.ui.render(MESSAGE('run `X-123` in ./X-123.ts'))
    expect(world.drawn.at(-1)).toBe('run `X-123` in ./X-123.ts')
  })

  test('a wall set by hand wins and no discovery runs', { options: { wallUrl: 'http://127.0.0.1:9000/' } }, async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    await $.ui.render(MESSAGE('A-B32'))
    expect(world.drawn.at(-1)).toBe('[A-B32](http://127.0.0.1:9000/?note=A-B32)')
    expect(world.runs.filter(argv => argv[0] === 'claude')).toEqual([])
  })

  test('linkifyReplies off leaves replies alone', { options: { linkifyReplies: false } }, async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.ui.render(MESSAGE('A-B32'))
    expect(world.drawn.at(-1)).toBe('A-B32')
  })
})

describe('/open', () => {
  test('opens the normalised id with explorer.exe', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    const out = await $.command.run(OPEN('a-b32'))
    expect(out.text).toBe('Opened A-B32 on the wall: http://localhost:7400/?note=A-B32')
    expect(world.runs.at(-1)).toEqual(['explorer.exe', 'http://localhost:7400/?note=A-B32'])
  })

  test('rejects a word that is not an id', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    const out = await $.command.run(OPEN('e-mail'))
    expect(out.text).toContain('"e-mail" is not a note id')
    expect(world.runs.filter(argv => argv[0] !== 'claude')).toEqual([])
  })
})
```

### Step 11: The mod's README
**File:** `claude/mods/note-links/README.md` (new)
**Code:**
````markdown
# note-links

A Claude Code mod for mcp-notes. It does two things:

- **Note ids in Claude's replies become links to the wall.** A reply that says `Saved as A-B32.`
  is drawn as `Saved as [A-B32](http://localhost:7317/?note=A-B32).`, which the terminal shows
  as a Ctrl-click hyperlink (OSC 8). Only the drawing changes: the stored message and what the
  model reads stay as they were.
- **`/open <id>` opens a note on the wall in the browser.** Case and the dash do not matter
  (`/open ab32`, `/open a-b32`, `/open A-B32`). From WSL it runs `explorer.exe <url>`, falling
  back to `/mnt/c/WINDOWS/explorer.exe`, then `powershell.exe Start-Process`, then
  `cmd.exe /c start`. When none of them starts, it prints the URL to open yourself.

The wall reads `?note=<id>` and scrolls to the note (see "A tour of the wall" in the repo README).
The mod is useful on top of the `/n` skill's own links: it also links ids Claude writes when `/n`
is not loaded, and `/open` works when the terminal or tmux does not pass hyperlinks through.

## What gets linked

A note id is one character, a dash, three characters, all `0-9`/`A-Z` (`A-B32`). In a reply only
the upper-case, dashed form is linked, and only where it stands alone. Left alone:

- fenced code blocks, inline code spans, markdown links (their text and their URL), images,
  reference links and definitions, `<autolinks>`, bare URLs
- paths and file names (`./X-123.ts`, `src/X-123/foo`, `X-123:10`)
- hashes and UUIDs (`3f2a-9b1c`, `123E4567-E89B-...`), longer dashed words (`AB-CDEF`, `A-B32X`,
  `XA-B32`, `UATP-2960`), lower-case words (`e-mail`, `t-shirt`), `#A-B32`, `foo_A-B32`
- an id that is already a link, so redrawing twice changes nothing

Known limitation: an upper-case word that happens to have the shape, such as `X-RAY` or an
`R-123` style tag, is linked too. The mod cannot tell it from an id without asking the server.
Indented code blocks (four spaces) are not recognised as code; Claude uses fences.

Your own prompts are not redrawn: a prompt row is drawn as plain text, not markdown, so a link
there would show its brackets. Use `/open` for an id you typed.

## Settings

Options are rows in `/config` (or `pluginConfigs["note-links"].options` in
`~/.claude/settings.json`):

| Option | Default | What it does |
|---|---|---|
| `wallUrl` | `http://localhost:7317` | Base URL of the wall. Set it when the daemon runs on another port (`NOTESD_PORT`). A value set here always wins. |
| `discoverWallUrl` | `true` | While `wallUrl` is the default, read the notes server's URL from `claude mcp get notes` at session start and use it without `/mcp`. |
| `linkifyReplies` | `true` | Off leaves replies alone; `/open` still works. |

## Turning it on

Turning a mod on is a step only you can take: Claude Code asks before it loads one, and only a
person can answer. From the main checkout (not a worktree):

```bash
claude --plugin-dir ~/mcp-notes/claude/mods/note-links
```

To have it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/<you>/mcp-notes/claude/mods/note-links" } }
```

Or, for one running session, link it into that session's mods folder and answer the prompt:

```bash
ln -s ~/mcp-notes/claude/mods/note-links ~/.claude/dev-mods/<session-id>/note-links
```

Loading it from a folder makes Claude Code write `.claude-plugin/types/` beside the manifest,
with its own `.gitignore`; it is not part of the source.

## Checking it

```bash
claude plugin validate claude/mods/note-links   # ends with "✔ Validation passed"
claude plugin test claude/mods/note-links       # "0 fail", exit 0
```

`npm test` does not run these: the mod runs in Claude Code's own hooks environment, not Node.

## Files

```
.claude-plugin/plugin.json   manifest, options, types contract
hooks/hooks.json             names the hooks module
hooks/register.ts            the hooks: session.start, command.run (/open), ui.render (AssistantMessage)
hooks/linkify.ts             pure: id rules, wall URL rules, linkify
hooks/open.ts                /open text and the opener chain, host command injected
types/index.d.ts             the $.state value the mod keeps (the discovered wall)
tests/*.test.ts              claude plugin test
tsconfig.json                types the mod once Claude Code has laid .claude-plugin/types
```
````

### Step 12: Repository layout line
**File:** `README.md:706` (insert a new line after it, inside the "Repository layout" code block)
**Change:** Today lines 705-707 read:
```
drizzle/        SQL migrations
claude/skills/n the /n skill, symlinked into ~/.claude/skills/n
deploy/         systemd user unit template
```
After:
```
drizzle/        SQL migrations
claude/skills/n the /n skill, symlinked into ~/.claude/skills/n
claude/mods/note-links  the note-links Claude Code mod (links note ids in replies, /open <id>); see its README
deploy/         systemd user unit template
```
**Impact:** Touches only this code block. Phases 1 and 2 add README text in other sections ("A tour of the wall", "Using it from Claude Code"); the line numbers above are as of `main` @ 2a8530e and may shift if they land first — anchor on the `claude/skills/n` line, not the number.

## Verification

**Build:** none for the mod (the engine compiles it at load). The repo's own build is untouched: `npm run typecheck` must still pass (it does not include `claude/`).
**Tests:**
```bash
cd /home/miftah/.worktrees/mcp-notes/note-id-deeplinks
claude plugin validate claude/mods/note-links
claude plugin test claude/mods/note-links
npm test            # unchanged suite, still green (the mod's tests are not in it)
```
`claude plugin validate` must exit 0, list exactly these facts, and end with `✔ Validation passed`:
```
  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: note-links.wall
  ❯ ./register.ts hooks: session.start, command.run{command=open}, ui.render{component=AssistantMessage}
  ❯ ./register.ts answers its own command: command.run{command=open}
  ❯ ./register.ts calls: $.command.register, $.process.run, $.state.get, $.state.set
  ❯ ./register.ts state writes: note-links.wall
  ❯ ./register.ts state reads: note-links.wall
```
Its "plugin directory checks" section will still show `LICENSE_MISSING`, `ICON_MISSING` and a README-install-line note; these are submission checks for the public catalog and do not change the result (the output says so). `answers its own command` (not `gating hook`) confirms `/open` collides with no built-in command.

`claude plugin test` must print `107 pass`, `0 fail`, `Ran 107 tests across 3 files` and exit 0. (Adding rows changes the count; `0 fail` and exit 0 are the criterion.)

**Optional type check** (not required, nothing in the repo runs it): copy the build's declarations in and run tsc, then remove them:
```bash
D=claude/mods/note-links/.claude-plugin/types/claude-code
mkdir -p $D && cp "$(ls -d /tmp/claude-1000/bundled-skills/*/*/plugin-authoring | tail -1)/types/claude-code.d.ts" $D/index.d.ts
node_modules/.bin/tsc -p claude/mods/note-links ; rm -rf claude/mods/note-links/.claude-plugin/types
```
**Manual check (a person, after merge, from `~/mcp-notes`, never from the worktree):**
1. `claude --plugin-dir ~/mcp-notes/claude/mods/note-links` and answer the enable prompt.
2. Ask for something that prints an id, e.g. `/n list my last 3 notes`; the ids are underlined/Ctrl-clickable (needs the tmux `hyperlinks` feature Phase 2 documents; without it the terminal shows the text then the URL dim).
3. `/open <one of those ids in lower case without the dash>` opens the browser on the wall. `/open hello` prints the "is not a note id" message and opens nothing.
**Exit criteria:** both `claude plugin` commands pass as above; `npm test` and `npm run typecheck` are unchanged and green; the only file outside `claude/mods/note-links/` in the diff is the one README line.

## Handoffs

- **Index Decision wording (reconciler):** the "Build the mod" row lists "ids typed by the person" as a value. This phase does not redraw `UserMessage` rows (plain text, see Decisions); that value is served by `/open`. Adjust the wording if needed. No requirement moves.
- **Phase 1 (R1):** the mod links to `<wall>/?note=<ID>` with the canonical id; Phase 1 must accept exactly that (Invariant 4 already says so). Nothing else is expected from Phase 1.
- **Phase 2 (R2):** the mod README points at "the tmux `hyperlinks` setting" for OSC 8; Phase 2 owns documenting it in `docs/INSTALL.md`/README. If the reconciler wants a cross-link from Phase 2's README subsection to `claude/mods/note-links/README.md`, that line is Phase 2's to write.
- **Not done, nobody's phase:** installing the mod (`scripts/install.sh` is out of scope; turning a mod on needs a person), a LICENSE file, an icon. Enabling is the manual step in the mod README.

## Rollback

`git rm -r claude/mods/note-links` and remove the one "Repository layout" line from `README.md` (or `git revert` the phase's commit). If a person had enabled it: drop the `--plugin-dir` flag, remove the path from `CLAUDE_CODE_PLUGIN_DIRS`, or delete the symlink under `~/.claude/dev-mods/<session-id>/note-links`. No data, daemon or database change to undo.
