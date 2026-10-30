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
