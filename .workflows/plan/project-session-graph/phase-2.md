# Phase 2: swarm.py passes CC_PARENT_SESSION (sibling repo ~/claude-commands)

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R2. A session spawned by `swarm.py` carries its parent's Claude Code session id in its environment, so the Phase 5 SessionStart hook can record an exact (`source = 'env'`) parent link.
**Depends on:** none
**Difficulty:** EASY
**Package:** `~/claude-commands/skills/swarm` (sibling repo `/home/miftah/claude-commands`, NOT mcp-notes)

---

## Goal

`spawn_argv` in `~/claude-commands/skills/swarm/swarm.py` adds one tmux `-e CC_PARENT_SESSION=<id>`
pair, where `<id>` is the caller's `CLAUDE_CODE_SESSION_ID`. It is read from the `environ` param
when one is passed and from `os.environ` otherwise. When the variable is unset or blank, no pair
is added. Because both `cmd_spawn` (`swarm.py:895`) and `cmd_launch` (`swarm.py:1790`) build their
tmux command through `spawn_argv`, children from either path carry the variable. The change is
committed and pushed to `origin/main` of `~/claude-commands` and deployed with `./sync.sh`.

**This phase makes no change to mcp-notes.** The mcp-notes phase branch/worktree for phase 2
stays empty, with no commit. See "Recording completion" under Verification.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:** `swarm.parent_env(environ=None) -> list[str]` (`~/claude-commands/skills/swarm/swarm.py`, new function between `identity_env` (ends `:593`) and `spawn_argv` (`:596`)); env var contract `CC_PARENT_SESSION` = the spawning session's `CLAUDE_CODE_SESSION_ID` (a UUID string), present in the child's process env only when the parent had one.
**Signature changes:** none. `spawn_argv(name, cwd, prompt, permission_mode=None, model=None, keep_open=True, environ=None, slug=None, phase=None, coordinator=None)` is unchanged. Its return list gains `["-e", "CC_PARENT_SESSION=<id>"]` after the `SWARM_*` pairs and before `-P`.
**Requires (from earlier phases):** none
**Provides (to later phases):** Phase 5 (`claude/hooks/notes-session.mjs`) may read `process.env.CC_PARENT_SESSION` and treat a non-blank value as the exact parent session id (`parent_link_source = 'env'`). Phase 5's Bash PreToolUse hook should still skip `swarm.py` invocations, because those children already carry the env link.
**Leaves alone (owned by others):** everything in `mcp-notes` (Phases 1, 3-n); `claude/hooks/*` (Phase 5); `~/claude-commands/skills/swarm/SKILL.md` (it does not document spawn env, see Step 3); `mods/swarm-deck/*` in claude-commands (it reads only `SWARM_*`).

## Files

| File | Action | What changes |
|---|---|---|
| `~/claude-commands/skills/swarm/swarm.py:594` (after `identity_env`) | modify | add `PARENT_SESSION_VAR` constant and `parent_env()` |
| `~/claude-commands/skills/swarm/swarm.py:609-612` (`spawn_argv` return) | modify | append `+ parent_env(environ)` |
| `~/claude-commands/skills/swarm/swarm.py:2016` (selftest, after the `identity_env` assertions) | modify | add CC_PARENT_SESSION assertions |
| `~/claude-commands/skills/swarm/SKILL.md` | no change | verified it does not document the spawn env (`grep -n "OMP_\|SWARM_SLUG\|environment" SKILL.md` has no relevant hits) |

Nothing in `/home/miftah/.worktrees/mcp-notes/project-session-graph` changes.

## Implementation Steps

### Step 0: Prepare a clean place to work in ~/claude-commands

State measured 2026-11-02: `/home/miftah/claude-commands` is on `main` at `02125ae`, equal to
`origin/main`, with a clean `git status`. There are three old `task/*` branches, which are not
relevant. `~/.claude/skills/swarm` is **not** a symlink. It is a real directory that `./sync.sh`
copies into, and today it is byte-identical to the repo copy. The claude-commands `CLAUDE.md`
says never to edit `~/.claude/` directly: edit the repo and run `./sync.sh`.

To avoid sweeping in anything a parallel session may have left dirty in the main checkout, do
the work in a dedicated worktree cut from `origin/main`:

```sh
cd /home/miftah/claude-commands
git fetch origin
git worktree add -b feat/swarm-cc-parent-session \
  /home/miftah/.worktrees/claude-commands/swarm-cc-parent-session origin/main
cd /home/miftah/.worktrees/claude-commands/swarm-cc-parent-session
```

Steps 1-2 below edit `skills/swarm/swarm.py` **inside that worktree**. Line numbers are
measured at `02125ae`. If `origin/main` has moved, anchor on the quoted code instead.

### Step 1: Add `parent_env`
**File:** `skills/swarm/swarm.py:594`. Insert after the end of `identity_env` (its last line
`return out` is at `:593`), keeping two blank lines before `def spawn_argv` (`:596`).
**Change:** New constant and function, matching the style of `thread_cap_env` and `identity_env`.
**Code:**
```python
PARENT_SESSION_VAR = "CC_PARENT_SESSION"


def parent_env(environ=None):
    """`-e CC_PARENT_SESSION=<id>`: the spawning session's own Claude Code session id.

    mcp-notes draws a graph of which session started which. A child cannot work out its
    parent afterwards: names are reused (see `init`), and a transcript only says that
    *something* ran `swarm.py spawn --name X`. So the parent's id goes into the child's
    environment at launch, where the child's SessionStart hook reads it and records an
    exact link instead of a guessed one.

    It comes from this process's environment (`CLAUDE_CODE_SESSION_ID`, which Claude Code
    sets for every Bash call). tmux gives a new window the SERVER's environment, not this
    process's, so without the `-e` the id would never reach the child. When it is unset or
    blank (swarm.py run by hand outside Claude Code) nothing is emitted. A blank value would
    send the child a parent link to nobody.
    """
    env = os.environ if environ is None else environ
    sid = (env.get("CLAUDE_CODE_SESSION_ID") or "").strip()
    if not sid:
        return []
    return ["-e", f"{PARENT_SESSION_VAR}={sid}"]
```
**Impact:** Additive. There are no callers yet.

### Step 2: Emit it from `spawn_argv`
**File:** `skills/swarm/swarm.py:609-612` (the `return` of `spawn_argv`).
**Change:** Append the parent pair after the identity pairs. The command string stays last
(the selftest asserts `argv[-1]` is the claude command). Full function after the change:
**Code:**
```python
def spawn_argv(name, cwd, prompt, permission_mode=None, model=None, keep_open=True,
               environ=None, slug=None, phase=None, coordinator=None):
    inner = ["claude", "-n", name]
    if permission_mode:
        inner += ["--permission-mode", permission_mode]
    if model:
        inner += ["--model", model]
    inner.append(prompt)
    command = " ".join(shlex.quote(a) for a in inner)
    if keep_open:
        # Without this the window closes the instant claude exits and the scrollback
        # -- which is the only record of a phase that failed -- goes with it.
        command += "; exec ${SHELL:-/bin/sh}"
    return (["tmux", "new-window", "-d", "-n", name, "-c", cwd]
            + thread_cap_env(environ)
            + identity_env(slug, phase, coordinator)
            + parent_env(environ)
            + ["-P", "-F", "#{window_id} #{pane_id}", command])
```
**Impact:** `cmd_spawn` (`:895`) and `cmd_launch` (`:1790`) pass no `environ`, so both read
`os.environ`. Any `swarm.py spawn|launch` run from inside a Claude Code session now gives its
child `CC_PARENT_SESSION`. Neither call site changes. The `--dry-run` JSON `argv` of both
commands shows the pair. tmux `-e` needs tmux >= 3.0, which is already required by the existing
thread-cap pairs.

### Step 3: Extend the inline selftest
**File:** `skills/swarm/swarm.py:2016`. Insert after the assertion block that ends with
`["SWARM_SLUG=s", "SWARM_PHASE=1"])` (`:2015`) and before the blank line and the
`# The plan a child is handed must exist` comment.
**Change:** Deterministic assertions. Every one passes `environ` explicitly, so the result does
not depend on whether the selftest itself runs inside Claude Code. (The pre-existing first
`spawn_argv` call at `:1976` uses `os.environ` and may now carry the pair, but none of its
assertions is affected: they check `-d`, `-n`, `argv[-1]` and quoting.)
**Code:**
```python

    # The parent's session id travels to the child so mcp-notes can draw an exact
    # parent link instead of guessing one from names -- see parent_env.
    sid = "d5c27d87-c38b-4fb8-83b5-1b1afaa5991f"
    parented = spawn_argv("n", "/tmp", "p", environ={"CLAUDE_CODE_SESSION_ID": sid})
    eq("a child is told who spawned it",
       f"{PARENT_SESSION_VAR}={sid}" in parented, True)
    eq("the parent id is a tmux -e pair",
       parented[parented.index(f"{PARENT_SESSION_VAR}={sid}") - 1], "-e")
    eq("the command still stays last", parented[-1].startswith("claude -n n"), True)
    eq("no session id, no parent pair",
       [a for a in spawn_argv("n", "/tmp", "p", environ={}) if "CC_PARENT" in a], [])
    eq("a blank session id is no session id",
       parent_env({"CLAUDE_CODE_SESSION_ID": "   "}), [])
    eq("surrounding whitespace is not part of the id",
       parent_env({"CLAUDE_CODE_SESSION_ID": f" {sid}\n"}),
       ["-e", f"{PARENT_SESSION_VAR}={sid}"])
    eq("a swarm phase gets both its identity and its parent",
       [a for a in spawn_argv("n", "/tmp", "p", slug="s", phase=1,
                              environ={"CLAUDE_CODE_SESSION_ID": sid})
        if a.startswith(("SWARM_", "CC_PARENT"))],
       ["SWARM_SLUG=s", "SWARM_PHASE=1", f"{PARENT_SESSION_VAR}={sid}"])
```
**Impact:** The selftest gains 7 assertions. It prints `all assertions passed` only when they hold.

### Step 4: SKILL.md: no change
`skills/swarm/SKILL.md` does not document the env a spawn hands its child. It mentions neither
the thread caps nor `SWARM_*`; `SWARM_*` is documented in `mods/swarm-deck/README.md` and
`docs/swarm-deck-mod-design.md`, which are not in this phase's scope. Per the phase scope
("update SKILL.md only if it documents the spawn env"), leave it alone. Do not hand-edit
`CHANGELOG.md` either; that repo's convention is that `/up-version` writes it.

### Step 5: Commit only the one path, push to origin/main, deploy
In the worktree from Step 0:

```sh
cd /home/miftah/.worktrees/claude-commands/swarm-cc-parent-session
python3 skills/swarm/swarm.py selftest          # must print "all assertions passed"
git status --short                              # expect exactly: M skills/swarm/swarm.py
git diff --stat                                 # expect 1 file changed
git commit -m "feat(swarm): spawned sessions carry CC_PARENT_SESSION

spawn_argv adds -e CC_PARENT_SESSION=<caller's CLAUDE_CODE_SESSION_ID> to the
tmux new-window it builds, so children of both 'spawn' and 'launch' know the
exact session that started them. mcp-notes' SessionStart hook reads it to
record a parent link with source 'env' instead of guessing one from reused
session names. Omitted when the caller has no session id (run by hand).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- skills/swarm/swarm.py
git push origin HEAD:main
```

If the push is rejected as non-fast-forward because someone pushed to claude-commands main in
the meantime: `git fetch origin && git rebase origin/main`, re-run the selftest, then push
again. Never force-push main.

Then bring the main checkout forward and deploy. `sync.sh` copies the whole repo into `~/.claude`,
so check the main checkout is clean first:

```sh
cd /home/miftah/claude-commands
git status --short                  # if not empty: do NOT pull/sync over someone's work; stop
                                    # here and report "pushed, not deployed" in the ledger note
git pull --ff-only origin main
./sync.sh
cmp skills/swarm/swarm.py ~/.claude/skills/swarm/swarm.py && echo deployed
git worktree remove /home/miftah/.worktrees/claude-commands/swarm-cc-parent-session
git branch -d feat/swarm-cc-parent-session
```

`git branch -d` (not `-D`) refuses unless the branch is merged into the current HEAD, which is
`origin/main` after the pull. It is the safety check.

## Verification

**Build:** none (Python script; `python3 -m py_compile /home/miftah/claude-commands/skills/swarm/swarm.py`)
**Tests:** `python3 ~/claude-commands/skills/swarm/swarm.py selftest` → exit 0, ends with
`selftest: all assertions passed`. Optionally `cd ~/claude-commands/skills/swarm && python3 -m pytest -q tests` (plan_graph tests, untouched; must still pass).
**Manual check (dry run, no tmux window opened, no ledger needed):**
```sh
CLAUDE_CODE_SESSION_ID=d5c27d87-c38b-4fb8-83b5-1b1afaa5991f \
  python3 ~/claude-commands/skills/swarm/swarm.py launch --name cc-parent-probe \
  --prompt hi --cwd /tmp --no-trust --dry-run | grep -B1 CC_PARENT_SESSION
# expect:  "-e",
#          "CC_PARENT_SESSION=d5c27d87-c38b-4fb8-83b5-1b1afaa5991f",
env -u CLAUDE_CODE_SESSION_ID \
  python3 ~/claude-commands/skills/swarm/swarm.py launch --name cc-parent-probe \
  --prompt hi --cwd /tmp --no-trust --dry-run | grep -c CC_PARENT_SESSION
# expect: 0
```
(`--no-trust` keeps the dry run from writing `~/.claude.json`. `spawn --dry-run` shows the same
pair but needs a ledger; `launch` exercises the same `spawn_argv`.) Run both against the
deployed copy too (`~/.claude/skills/swarm/swarm.py`) after `./sync.sh`.
**Exit criteria:** selftest passes; the dry run shows `-e CC_PARENT_SESSION=<id>` when
`CLAUDE_CODE_SESSION_ID` is set and nothing when it is unset; the commit is on
`origin/main` of claude-commands (`git -C ~/claude-commands branch -r --contains <sha>` lists
`origin/main`); `~/.claude/skills/swarm/swarm.py` matches the repo copy.

**Recording completion (mcp-notes side):** the mcp-notes phase-2 branch/worktree gets **no
commit**: this phase changes nothing there, so don't create an empty commit or a marker file.
The executor records completion in the swarm ledger with the cross-repo commit in the note,
**without** `--commit`, because that field means an mcp-notes commit and `verify`/`land`
read it that way:
```sh
python3 ~/.claude/skills/swarm/swarm.py report --slug project-session-graph --phase 2 \
  --status done --note "landed in ~/claude-commands: <sha> on origin/main (feat(swarm): CC_PARENT_SESSION); deployed via sync.sh; no mcp-notes change"
```
then SendMessage the coordinator as usual. If the main checkout was dirty and deployment was
skipped, report `done` with a note "pushed, NOT deployed: run ./sync.sh in ~/claude-commands".
Phase 5 works without deployment; it then sees no env links, only heuristic/hook ones. If the
executor is `/implement` and expects a todos.md update or a pusher commit in mcp-notes, skip it
for this phase and record the skip as a decision in the ledger note. When the integrator merges
waves, the phase-2 branch has nothing to merge; that is expected.

## Handoffs

- **Phase 5 (R2):** read `CC_PARENT_SESSION` in `claude/hooks/notes-session.mjs`; a non-blank
  value is an exact parent id (`source 'env'`). Trim it before use. Its Bash PreToolUse spawn
  hook should not record a pending spawn for commands that invoke `swarm.py spawn|launch`,
  because those children carry the env link and a pending row would duplicate it.
- **Phase 3/4 (R3, heuristic backfill):** children spawned before this phase landed have no env
  var; they stay on the heuristic path. Nothing for them to change.
- Not done here (out of scope, nobody owns it): documenting `CC_PARENT_SESSION` beside
  `SWARM_*` in `~/claude-commands/mods/swarm-deck/README.md`. Optional follow-up card in
  claude-commands; it is not needed for R2.

## Rollback

`git -C ~/claude-commands revert <sha> && git -C ~/claude-commands push origin main && (cd ~/claude-commands && ./sync.sh)`.
The variable is purely additive: a child that does not receive it falls back to Phase 5's
hook or heuristic links, and nothing in mcp-notes depends on it being present. Rolling back
needs no mcp-notes change.
