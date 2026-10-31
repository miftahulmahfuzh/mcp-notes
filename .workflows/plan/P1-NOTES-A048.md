> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-image-to-note/.workflows/orchestration/chat-image-to-note/PLAN.md` phase 4. Source: `.workflows/orchestration/chat-image-to-note/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: End-to-end tests, live verify script, docs, CHANGELOG

**Plan set:** `CHAT_IMAGE_TO_NOTE_PLAN.md`
**Analysis:** `docs/analyzer/20261031-122441-Q7MX_code_analyzer.md`
**Satisfies:** R2, R4, R5, R6 — proof that `/n make that image a new note` works end to end (hook -> daemon -> `chat_images` -> `create_image({image_id})`), that it stays idempotent with the Stop capture and never blocks, plus the user-facing docs and CHANGELOG
**Depends on:** Phase 1, 2, 3
**Difficulty:** NORMAL
**Package:** `tests/integration`, `scripts`, docs (`README.md`, `docs/INSTALL.md`, `CHANGELOG.md`)

---

## Goal

After this phase one integration test drives the real `notes-prompt.mjs` hook (phase 3) against the real harness daemon (phase 1) and proves the C1/C2/C3 contracts together: the hook stores every pasted image of a session in `chat_images`, names them with the latest marked, does nothing on non-`/n` prompts, survives a dead daemon, does not re-upload, agrees with the Stop capture on ids and threads, and the ids it names are accepted by `create_image` / `attach_image` (`image_id`). An opt-in `npm run verify:prompt-hook` checks the one thing no test can (does Claude Code run the hook and does the model see the id), and README, INSTALL and CHANGELOG describe three hooks, `image_id`, the `/n`-only scope, the state files and the privacy/disk trade-off.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `tests/integration/prompt.hook.int.test.ts` (new test file, no exports)
- `scripts/verify-prompt-hook.mjs` (opt-in live check, no exports)
- npm script `verify:prompt-hook` (`package.json`)
**Signature changes:** none
**Requires (from earlier phases):**
- Phase 1 (C1): MCP `create_image({ path?, image_id?, body?, origin? })` returning `{ note, created }`; `attach_image({ id, path?, image_id?, origin? })` returning `{ note, attached }`; `image_id` case/dash tolerant; refusals as `isError` text `create_image refused (unknown_chat_image): no pasted image ...` and `create_image refused (bad_arguments): give exactly one of path or image_id` (same with `attach_image`). A note image id passed as `image_id` is refused as `unknown_chat_image` (invariant 3).
- Phase 3 (C3): `claude/hooks/notes-prompt.mjs` exports `runPrompt({ input, env, fetchImpl, readText, sleep, now })` resolving to `{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: string } } | null`, and `claude/hooks/notes-prompt.d.mts` declares it so `npm run typecheck` accepts the import. `fetchImpl` has the `FetchLike` shape `(url: string, init: RequestInit) => Promise<Response>` used by the other hooks; `readText` is `(file: string) => Promise<string>`; `sleep` is `(ms: number) => Promise<unknown>`; `now` is `() => number`.
- Phase 3 (C2): line 1 is `CONTEXT_HEADER` (`Pasted images in this Claude Code session, oldest first: `) then ids oldest first as `[Image #N] = <ID>` separated by `; `, with ` (latest)` right after the latest id, ending in `.`; line 3 is `TOOLS_HINT`, which names `create_image` and `image_id`. Uploads go to `POST /api/chat/images` (URL ends with `/api/chat/images`). The per-session memo lives under the hook state dir (`<XDG_STATE_HOME>/notes-capture/`, dir `prompt-images/`) and makes a replay upload nothing. Failed uploads are not memoised. (Verified against phase 3's `buildContext` during reconciliation.)
- Phase 3 (C2, Decisions D2): the transcript is "settled" when its last human prompt carries every `[Image #N]` typed in the `/n` prompt; trivially settled when none is typed. Every `/n` prompt in this test's transcripts is the last human entry and carries its own typed numbers, so each `submit` settles on the first read.
- Phase 3 (C2, Decisions D1): when no image at all could be stored (daemon unreachable) `runPrompt` returns `null` and appends a line to `<XDG_STATE_HOME>/notes-capture/prompt.log`; the "latest pasted image could not be stored" context is emitted only when at least one older image was stored (pinned by phase 3's unit tests, not repeated here).
- Phase 3: a non-`/n` prompt (per `isNotesPromptText`: `/n` followed by whitespace or the end, after optional leading whitespace, or the slash-command XML; so `/new ...` and `please /n later` are not `/n`) returns `null` without calling `fetchImpl` or `readText` (invariant 6).
- Phase 3: `scripts/install.sh` registers three groups (Stop, PreToolUse, UserPromptSubmit), `uninstall.sh` removes all three; the docs text below describes that.
**Leaves alone (owned by others):** everything under `src/` (phases 1, 2), everything under `claude/` including `claude/skills/n/SKILL.md` and the hooks (phase 3), `scripts/claude-hooks.mjs`, `scripts/install.sh`, `scripts/uninstall.sh` (phase 3), all unit tests (phases 1-3), `tests/integration/images.mcp.int.test.ts` and `tests/integration/images.attach.int.test.ts` (phase 1), `tests/unit/hooks/fixtures.ts` (read only; this phase builds extra images with `makeImage` instead of adding fixtures).

## Files

| File | Action | What changes |
|---|---|---|
| `tests/integration/prompt.hook.int.test.ts` | create | hook -> real daemon -> `chat_images`; Stop capture agreement; memo; non-`/n`; daemon down; `create_image`/`attach_image` with `image_id` |
| `scripts/verify-prompt-hook.mjs` | create | opt-in live `claude -p` check of the UserPromptSubmit hook |
| `package.json` | modify (`:70`) | add `verify:prompt-hook` script |
| `README.md` | modify (`:193-196`, `:295-305`, `:572-579`, `:626`, `:688-689`, `:790`, `:817-818`, `:865`) | three hooks, notes-prompt, `image_id`, state files, privacy/disk, verify command, layout line |
| `docs/INSTALL.md` | modify (`:45-47`, `:389-391`, `:398-399`) | hook registration step, uninstall removes hooks, troubleshooting line |
| `CHANGELOG.md` | modify (`:10-11`, `:24`) | `[Unreleased]` Added x2, new Changed section |

## Implementation Steps

### Step 1: End-to-end integration test
**File:** `tests/integration/prompt.hook.int.test.ts` (new)
**Change:** New integration test, modelled on `tests/integration/capture.hook.int.test.ts` (harness, `closedPort`, `count`) and `tests/integration/images.mcp.int.test.ts` (MCP client over `/mcp`). A virtual clock is passed as `sleep`/`now` so any transcript poll or time budget inside the hook costs no wall time. Extra valid images are made with `makeImage` (the fixture `BLUE_DATA` is not a real image and would be refused by the daemon).
**Code:**
```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCapture } from '../../claude/hooks/notes-capture.mjs';
import { runPrompt } from '../../claude/hooks/notes-prompt.mjs';
import { sha256Hex } from '../../src/images/probe.js';
import { CWD, RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl } from '../unit/hooks/fixtures.js';
import { insertTextNote, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';

type Entry = Record<string, unknown>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type PromptOutput = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type NoteJson = { id: string; images: Array<{ id: string }> };

const N_PROMPT = '/n make that image a new note [Image #2]';

let h: Harness;
let livePort: string;
let client: Client;
let tmp: string;
let bluePng = '';
let greenPng = '';

beforeAll(async () => {
  h = await startHarness();
  const base = await h.listen();
  livePort = new URL(base).port;
  client = new Client({ name: 'prompt-hook-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  bluePng = (await makeImage('png', 16, 16, { r: 0, g: 0, b: 255 })).toString('base64');
  greenPng = (await makeImage('png', 16, 16, { r: 0, g: 200, b: 0 })).toString('base64');
});

beforeEach(async () => {
  await h.reset();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-prompt-int-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await client.close();
  await h.close();
});

function closedPort(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 1;
      server.close(() => resolve(String(port)));
    });
  });
}

async function count(table: string): Promise<number> {
  const result = await h.deps.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((result.rows[0] as { n: number }).n);
}

/** The chat image id the daemon gave these bytes (sha256 is unique in chat_images). */
async function chatIdOf(base64: string): Promise<string> {
  const sha = sha256Hex(Buffer.from(base64, 'base64'));
  const result = await h.deps.db.execute(sql`select id from chat_images where sha256 = ${sha}`);
  const row = result.rows[0] as { id: string } | undefined;
  if (row === undefined) throw new Error(`no chat image with sha256 ${sha}`);
  return row.id;
}

/** Sleep advances a fake clock instead of waiting, so polls and budgets in the hook cost nothing. */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = Date.parse('2026-10-31T05:00:00.000Z');
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function countingFetch(): { fetchImpl: FetchLike; calls: () => number; uploads: () => number } {
  const urls: string[] = [];
  return {
    fetchImpl: (url, init) => {
      urls.push(url);
      return fetch(url, init);
    },
    calls: () => urls.length,
    uploads: () => urls.filter((u) => u.endsWith('/api/chat/images')).length,
  };
}

function countingRead(): { readText: (file: string) => Promise<string>; reads: () => number } {
  let n = 0;
  return {
    readText: (file) => {
      n += 1;
      return readFile(file, 'utf8');
    },
    reads: () => n,
  };
}

function hookEnv(port: string = livePort): Record<string, string> {
  return { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: port };
}

async function writeTranscript(entries: Entry[]): Promise<string> {
  const file = path.join(tmp, 's.jsonl');
  await writeFile(file, jsonl(entries));
  return file;
}

async function submit(
  transcript: string,
  prompt: string,
  opts: { port?: string; fetchImpl?: FetchLike; readText?: (file: string) => Promise<string> } = {},
): Promise<PromptOutput | null> {
  const clock = virtualClock();
  const out = await runPrompt({
    input: { session_id: SESSION, transcript_path: transcript, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt },
    env: hookEnv(opts.port),
    fetchImpl: opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init)),
    readText: opts.readText ?? ((file: string) => readFile(file, 'utf8')),
    sleep: clock.sleep,
    now: clock.now,
  });
  return out as PromptOutput | null;
}

function contextOf(out: PromptOutput | null): string {
  expect(out).not.toBeNull();
  expect(out!.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return out!.hookSpecificOutput.additionalContext;
}

/** A non-/n turn pasting a blue image, an answer, then a /n turn pasting a red one. */
function twoTurnSession(): Entry[] {
  return [
    imagePromptEntry('what is in this picture? [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
    assistantText('A blue square.'),
    imagePromptEntry(N_PROMPT, [{ media_type: 'image/png', data: RED_PNG_16 }], [2]),
  ];
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(r: ToolResult): string {
  return r.content.flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n');
}

describe('notes-prompt hook against the real daemon', () => {
  it('a /n prompt stores every pasted image of the session and names the latest', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    const ctx = contextOf(await submit(transcript, N_PROMPT));

    expect(await count('chat_images')).toBe(2);
    const blueId = await chatIdOf(bluePng);
    const redId = await chatIdOf(RED_PNG_16);
    expect(ctx).toContain(`[Image #1] = ${blueId}`);
    expect(ctx).toContain(`[Image #2] = ${redId} (latest)`);
    expect(ctx).not.toContain(`${blueId} (latest)`);
    expect(ctx.indexOf(blueId)).toBeLessThan(ctx.indexOf(redId));
    expect(ctx).toContain('create_image');
    expect(ctx).toContain('image_id');

    const sources = await h.deps.db.execute(sql`select distinct source from chat_images`);
    expect(sources.rows.map((r) => (r as { source: string }).source)).toEqual(['claude_code']);
    // The hook only stores pictures: no thread, no message, no note (invariant 4).
    expect(await count('chat_threads')).toBe(0);
    expect(await count('chat_messages')).toBe(0);
    expect(await count('notes')).toBe(0);
  });

  it('an image pasted in an earlier turn is "that image" when the /n prompt carries none', async () => {
    const transcript = await writeTranscript([
      imagePromptEntry('look at this [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
      assistantText('A blue square.'),
      commandEntry('please make that image as a new note then'),
    ]);
    const ctx = contextOf(await submit(transcript, '/n please make that image as a new note then'));
    expect(await count('chat_images')).toBe(1);
    expect(ctx).toContain(`${await chatIdOf(bluePng)} (latest)`);
  });

  it('the Stop capture of the same /n turn reuses the ids: no new chat image, one thread', async () => {
    const entries = twoTurnSession();
    const nTurn = entries[2]!;
    const transcript = await writeTranscript(entries);
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);

    await writeFile(transcript, jsonl([...entries, assistantText('Saved it as a note.')]));
    const io = { sleep: async (): Promise<void> => undefined };
    const captured = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Saved it as a note.' },
      env: hookEnv(),
      ...io,
    });
    expect(captured.outcome).toBe('delivered');
    expect(await count('chat_images')).toBe(2);
    expect(await count('chat_threads')).toBe(1);

    const keys = await h.deps.db.execute(sql`select external_key from chat_threads`);
    expect(keys.rows.map((r) => (r as { external_key: string }).external_key)).toEqual([`${SESSION}:${String(nTurn.uuid)}`]);
    const refs = await h.deps.db.execute(
      sql`select ref_id from chat_message_attachments where kind = 'chat_image' order by position`,
    );
    expect(refs.rows.map((r) => (r as { ref_id: string }).ref_id)).toEqual([redId]);

    const replay = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Saved it as a note.' },
      env: hookEnv(),
      ...io,
    });
    expect(replay.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_images')).toBe(2);
  });

  it('a replay uploads nothing; a newly pasted image is the only upload and becomes the latest', async () => {
    const entries = twoTurnSession();
    const transcript = await writeTranscript(entries);
    const first = countingFetch();
    const ctx1 = contextOf(await submit(transcript, N_PROMPT, { fetchImpl: first.fetchImpl }));
    expect(first.uploads()).toBe(2);

    const second = countingFetch();
    const ctx2 = contextOf(await submit(transcript, N_PROMPT, { fetchImpl: second.fetchImpl }));
    expect(second.uploads()).toBe(0);
    expect(ctx2).toBe(ctx1);
    expect(await count('chat_images')).toBe(2);

    const later = '/n and this one too [Image #3]';
    await writeFile(
      transcript,
      jsonl([
        ...entries,
        assistantText('Done.'),
        imagePromptEntry(later, [{ media_type: 'image/png', data: greenPng }], [3]),
      ]),
    );
    const third = countingFetch();
    const ctx3 = contextOf(await submit(transcript, later, { fetchImpl: third.fetchImpl }));
    expect(third.uploads()).toBe(1);
    expect(await count('chat_images')).toBe(3);
    const greenId = await chatIdOf(greenPng);
    const redId = await chatIdOf(RED_PNG_16);
    expect(ctx3).toContain(`[Image #3] = ${greenId} (latest)`);
    expect(ctx3).not.toContain(`${redId} (latest)`);
  });

  it('a prompt that is not /n does no I/O and prints nothing', async () => {
    const transcript = await writeTranscript([
      imagePromptEntry('what about this one? [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
    ]);
    for (const prompt of ['what about this one? [Image #1]', '/new idea [Image #1]', '  please /n later']) {
      const net = countingFetch();
      const disk = countingRead();
      const out = await submit(transcript, prompt, { fetchImpl: net.fetchImpl, readText: disk.readText });
      expect(out, prompt).toBeNull();
      expect(net.calls(), prompt).toBe(0);
      expect(disk.reads(), prompt).toBe(0);
    }
    expect(await count('chat_images')).toBe(0);
  });

  it('daemon down: null, a log line, nothing remembered; the next /n prompt stores the images', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    const down = await submit(transcript, N_PROMPT, { port: await closedPort() });
    expect(down).toBeNull();
    expect(await count('chat_images')).toBe(0);
    const log = await readFile(path.join(tmp, 'state', 'notes-capture', 'prompt.log'), 'utf8');
    expect(log.trim()).not.toBe('');

    const up = contextOf(await submit(transcript, N_PROMPT));
    expect(await count('chat_images')).toBe(2);
    expect(up).toContain(`${await chatIdOf(RED_PNG_16)} (latest)`);
  });

  it('create_image and attach_image accept the ids the hook named', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);
    const blueId = await chatIdOf(bluePng);

    const first = await call('create_image', { image_id: redId.toLowerCase().replace('-', ''), body: 'pasted in claude code' });
    expect(first.isError, textOf(first)).toBeFalsy();
    const made = JSON.parse(textOf(first)) as { note: NoteJson; created: boolean };
    expect(made.created).toBe(true);
    const stored = await readFile(await originalPathOf(h, made.note.id));
    expect(Buffer.compare(stored, Buffer.from(RED_PNG_16, 'base64'))).toBe(0);
    // The chat image stays where it was; the note holds a copy.
    expect(await count('chat_images')).toBe(2);

    const again = await call('create_image', { image_id: redId });
    expect(again.isError, textOf(again)).toBeFalsy();
    const same = JSON.parse(textOf(again)) as { note: NoteJson; created: boolean };
    expect({ id: same.note.id, created: same.created }).toEqual({ id: made.note.id, created: false });
    expect(await count('notes')).toBe(1);

    const attached = await call('attach_image', { id: made.note.id, image_id: blueId });
    expect(attached.isError, textOf(attached)).toBeFalsy();
    const withTwo = JSON.parse(textOf(attached)) as { note: NoteJson; attached: boolean };
    expect(withTwo.attached).toBe(true);
    expect(withTwo.note.images).toHaveLength(2);

    const reattach = await call('attach_image', { id: made.note.id, image_id: blueId });
    expect(reattach.isError, textOf(reattach)).toBeFalsy();
    expect((JSON.parse(textOf(reattach)) as { attached: boolean }).attached).toBe(false);
    expect(await count('note_images')).toBe(2);
  });

  it('image_id refusals: unknown chat id, a note image id, both or neither inputs', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);
    const blueId = await chatIdOf(bluePng);

    const unknown = await call('create_image', { image_id: 'Z-ZZZ' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('create_image refused (unknown_chat_image)');
    expect(textOf(unknown)).toContain('no pasted image');

    const made = JSON.parse(textOf(await call('create_image', { image_id: redId }))) as { note: NoteJson };
    const noteImageId = made.note.images[0]!.id;
    if (noteImageId !== redId && noteImageId !== blueId) {
      // A note image id is never looked up in the chat image space (invariant 3).
      const wrongSpace = await call('create_image', { image_id: noteImageId });
      expect(wrongSpace.isError).toBe(true);
      expect(textOf(wrongSpace)).toContain('unknown_chat_image');
    }

    const both = await call('create_image', { path: path.join(tmp, 'x.png'), image_id: redId });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('create_image refused (bad_arguments): give exactly one of path or image_id');

    await insertTextNote(h, 'T-XT9', 'a text note');
    const neither = await call('attach_image', { id: 'T-XT9' });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain('attach_image refused (bad_arguments): give exactly one of path or image_id');
  });
});
```
**Impact:** test only. Needs phases 1 and 3 merged (imports `notes-prompt.mjs`; calls `image_id`). Runs only under `npm run test:int` (the vitest config includes `tests/integration/**/*.int.test.ts` only when `VITEST_INTEGRATION=1`), but `npm run typecheck` checks it always (tsconfig includes `tests/**/*.ts`), so it needs phase 3's `notes-prompt.d.mts`.

Notes for the implementer:
- If phase 3's `.d.mts` types the `input` parameter more narrowly than an object literal with these keys, keep the literal and adjust nothing else; `hook_event_name` and `cwd` are what Claude Code sends.
- Phase 3's context text was checked against these assertions during reconciliation (`[Image #N] = <ID>`, `; `, ` (latest)`, `TOOLS_HINT`); they match. Do not loosen them to substrings that would pass with the wrong id marked latest.

### Step 2: Opt-in live check script
**File:** `scripts/verify-prompt-hook.mjs` (new)
**Change:** Modelled on `scripts/verify-paste-hook.mjs`. Registers only `notes-prompt.mjs` as a `UserPromptSubmit` hook in a throwaway `--settings` file, with its own temp `XDG_STATE_HOME` (fresh memo, readable log) and a marker file the hook command touches (proves Claude Code ran the hook). No MCP servers (`--strict-mcp-config` with an empty config), so the model can only answer from its context. Exit 0 when the model names an id the daemon knows (`GET /api/chat/images/:id` -> 200), 1 when the hook ran but no known id reached the model (the transcript lacked the current prompt), 2 when the check could not run.
**Code:**
```js
#!/usr/bin/env node
/**
 * Opt-in live check, never part of npm test / test:int: does Claude Code run the notes-prompt
 * UserPromptSubmit hook for a `/n` prompt that carries a pasted image, and does the model then see
 * that image's chat image id in its context?
 *
 *   npm run verify:prompt-hook -- [--port 7400] [--model sonnet] [--claude claude]
 *
 * Needs a running notesd built from this checkout on --port (default NOTESD_PORT, else 7317; a
 * demo daemon is fine: NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo npm start), and the claude
 * CLI logged in. Runs one short headless session (`claude -p --input-format stream-json`) with a
 * throwaway --settings file that registers only this repo's prompt hook, with a temp state dir
 * (no memo from earlier runs, and a prompt.log this script can show), and --strict-mcp-config with
 * no MCP servers, so the model can only answer from its context. Bills one small model call and
 * leaves one transcript under ~/.claude/projects (cwd is a temp dir). The pasted image lands in
 * chat_images (source claude_code). If the installed hooks are also in ~/.claude/settings.json,
 * Claude Code runs those too; this check only reads its own hook's marker and log.
 *
 * Exit 0: the model named a pasted-image id the daemon knows (GET /api/chat/images/<id>).
 * 1: the hook ran but no id reached the model: within the hook's 2.5 s wait the transcript's last
 *    human prompt never carried the current prompt's [Image #1] (the hook's prompt.log is printed,
 *    with its "[Image #1] not in the transcript" line). Images pasted in earlier turns
 *    still resolve; the follow-up for same-turn pastes is a PreToolUse rewrite of create_image.
 * 2: could not run (daemon down, claude missing or timed out, or Claude Code never ran the hook).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'claude', 'hooks', 'notes-prompt.mjs');
const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 180_000;
const HOOK_TIMEOUT_S = 20;
const CHAT_ID = /\b[0-9A-Z]-[0-9A-Z]{3}\b/g;

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function knownChatImage(port, id) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/images/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      claude: { type: 'string', default: 'claude' },
    },
  });
  const port = values.port ?? process.env.NOTESD_PORT ?? '7317';
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`notesd is not answering on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-prompt-hook-'));
  try {
    const settingsFile = path.join(tmp, 'settings.json');
    const mcpFile = path.join(tmp, 'mcp.json');
    const stateHome = path.join(tmp, 'state');
    const marker = path.join(tmp, 'hook-ran');
    const logFile = path.join(stateHome, 'notes-capture', 'prompt.log');
    const command =
      `touch ${quote(marker)}; ` +
      `NOTESD_PORT=${quote(port)} XDG_STATE_HOME=${quote(stateHome)} ${quote(process.execPath)} ${quote(HOOK)}`;
    await writeFile(
      settingsFile,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] } }),
    );
    await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }));

    const prompt =
      '/n [Image #1] Do not call any tool. If your context lists pasted image ids, reply with only the id ' +
      'it marks as the latest pasted image (ids look like G-0NC). Otherwise reply with only NONE.';
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG_16 } },
        ],
      },
    };
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings', settingsFile,
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--model', values.model,
    ];
    console.log(`running: ${values.claude} ${args.join(' ')}  (port ${port})`);
    let lines;
    try {
      lines = await new Promise((resolve, reject) => {
        const child = spawn(values.claude, args, { cwd: tmp, stdio: ['pipe', 'pipe', 'inherit'] });
        let out = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`claude did not finish within ${TIMEOUT_MS / 1000}s`));
        }, TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(out.split('\n').filter((line) => line.trim() !== ''));
        });
        child.stdin.end(`${JSON.stringify(message)}\n`);
      });
    } catch (err) {
      console.error(`could not run claude: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }

    let answer = '';
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type === 'result' && typeof event.result === 'string') answer = event.result;
      else if (event?.type === 'assistant' && answer === '') answer = textOf(event?.message?.content);
    }
    console.log(`model answered: ${answer.slice(0, 200)}`);

    for (const id of answer.match(CHAT_ID) ?? []) {
      if (await knownChatImage(port, id)) {
        console.log(`PASS: the /n prompt's context named pasted image ${id}`);
        return 0;
      }
    }
    if (!(await exists(marker))) {
      console.error('Claude Code never ran the UserPromptSubmit hook; inconclusive');
      return 2;
    }
    console.log("FAIL: the hook ran but no pasted-image id reached the model (the transcript did not hold the current prompt's [Image #1] in time?)");
    try {
      const log = await readFile(logFile, 'utf8');
      console.log(`prompt.log:\n${log.split('\n').slice(-20).join('\n')}`);
    } catch {
      console.log('prompt.log: (empty)');
    }
    return 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
```
**Impact:** none on build or tests (`scripts/*.mjs` are outside tsconfig's include and vitest's include). Run by hand only.

### Step 3: npm script
**File:** `package.json:70`
**Change:** add the script after `verify:paste-hook`.
**Code:**
```json
    "embed:images:backfill": "tsx src/cli/embedImagesBackfill.ts",
    "verify:paste-hook": "node scripts/verify-paste-hook.mjs",
    "verify:prompt-hook": "node scripts/verify-prompt-hook.mjs"
  }
```
(Replaces lines 69-71; only the trailing comma on line 70 and the new line 71 are new.)
**Impact:** none on `npm test`.

### Step 4: README — `create_image` bullet
**File:** `README.md:193-196`
**Change:** say the two tools also take a pasted image's id.
**Code:** replace
```markdown
- **The `create_image` tool.** Claude Code often has a screenshot path at hand: "save this
  screenshot as a note about the login bug".
- **The `attach_image` tool.** It adds a local file to a note that already exists: "attach
  ~/Pictures/Screenshots/login-bug-2.png to note A-B32".
```
with
```markdown
- **The `create_image` tool.** Claude Code often has a screenshot path at hand: "save this
  screenshot as a note about the login bug". It also takes a picture pasted into the wall chat or
  into a Claude Code `/n` prompt, by its pasted-image id (`image_id`, like `G-0NC`): "make that
  image a new note".
- **The `attach_image` tool.** It adds a local file or a pasted image to a note that already
  exists: "attach ~/Pictures/Screenshots/login-bug-2.png to note A-B32".
```

### Step 5: README — hooks section
**File:** `README.md:295-305`
**Change:** three hooks; add the notes-prompt bullet with its `/n`-only scope, caps, log, verify command and the same-turn limitation.
**Code:** replace
```markdown
`install.sh` also registers two Claude Code hooks in `~/.claude/settings.json` (every repo; pass
`--skip-hooks` to leave the file alone):
```
with
```markdown
`install.sh` also registers three Claude Code hooks in `~/.claude/settings.json` (every repo; pass
`--skip-hooks` to leave the file alone):
```
and after the notes-paste bullet (ends `short, billed Claude call).` at line 305) insert:
```markdown
- **notes-prompt** (when you submit a prompt, `/n` prompts only): paste an image, in this turn or
  in any earlier turn of the session, and ask `/n make that image a new note`. Before Claude
  answers, the hook stores the session's pasted images (the newest 8, up to 20 MB each) in the
  chat image store and tells Claude their ids, oldest first, with the latest marked. "That image"
  is the latest one; `[Image #1]` or an id like `G-0NC` picks another. Claude then calls
  `create_image` (or `attach_image`) with `image_id`. Every other prompt passes straight through:
  the hook reads nothing and sends nothing, so a session that never uses `/n` stores no images.
  Each image is uploaded once per session, the uploads stop after 8 s, and a failure never holds
  the prompt; problems go to `~/.local/state/notes-capture/prompt.log`. `npm run
  verify:prompt-hook` checks it against a running daemon (one short, billed Claude call). If it
  reports that the current prompt's image was not yet in the transcript, an image pasted in the
  `/n` prompt itself cannot be named in that turn (earlier turns' images still can); Claude is
  never given an older image as "that image" in its place.
```

### Step 6: README — install step list and undo line
**File:** `README.md:572-579`
**Code:** replace
```markdown
8. merges the notes-capture and notes-paste hooks into `~/.claude/settings.json`, keeping
   everything else (a copy of the original is kept once as `settings.json.bak-notes-hooks`;
   `--skip-hooks` or `NOTES_SKIP_HOOKS=1` skips this),
```
with
```markdown
8. merges the notes-capture, notes-paste and notes-prompt hooks into `~/.claude/settings.json`,
   keeping everything else (a copy of the original is kept once as `settings.json.bak-notes-hooks`;
   `--skip-hooks` or `NOTES_SKIP_HOOKS=1` skips this),
```
and replace
```markdown
Undo with `scripts/uninstall.sh` (it keeps your data and removes only our two hook entries).
```
with
```markdown
Undo with `scripts/uninstall.sh` (it keeps your data and removes only our three hook entries).
```

### Step 7: README — test command list
**File:** `README.md:626`
**Code:** after
```sh
npm run verify:paste-hook      # opt-in: one real claude -p run checks the paste hook rewrite
```
insert
```sh
npm run verify:prompt-hook     # opt-in: one real claude -p run checks /n sees a pasted image's id
```

### Step 8: README — MCP tool table
**File:** `README.md:688-689`
**Code:** replace the two rows with
```markdown
| `create_image` | New photo note, with optional text, from a local file (`path`) or from an image pasted into the wall chat or a Claude Code `/n` prompt (`image_id`, its pasted-image id like `G-0NC`, not a photo id); give exactly one. The same picture again returns the note that already holds it |
| `attach_image` | Add a local file (`path`) or a pasted image (`image_id`) to an existing note `id` as its next photo; give exactly one. Returns `{note, attached}`; `attached: false` when the picture is already in a note, which is returned instead |
```

### Step 9: README — state dir line
**File:** `README.md:790`
**Code:** replace
```
~/.local/state/notes-capture/      the Claude Code hooks: outbox/ (captures waiting for the daemon), capture.log, paste.log
```
with
```
~/.local/state/notes-capture/      the Claude Code hooks: outbox/ (captures waiting for the daemon), capture.log, paste.log,
                                   prompt.log, prompt-images/ (per session, which pasted images are already uploaded)
```

### Step 10: README — privacy and disk limitation
**File:** `README.md:817-818` (after the "Full size costs disk." bullet)
**Code:** insert
```markdown
- **Pasted images are kept.** Pictures pasted into the wall chat, and the pasted pictures of a
  Claude Code session once you use `/n` in it (from every turn of that session, not only the
  `/n` turn), are copied to `~/mcp-notes-data/chat-images/` and never deleted: there is no
  clean-up yet. The same picture is stored once (by sha256), at most 8 of up to 20 MB each go in
  per `/n` prompt, and each is uploaded once per session. A session that never uses `/n` stores
  nothing. They never appear on the wall unless you make one a note.
```

### Step 11: README — layout line
**File:** `README.md:865`
**Code:** replace
```
claude/hooks    the Claude Code hooks (notes-capture: saves /n exchanges; notes-paste: pasted image -> similar_images)
```
with
```
claude/hooks    the Claude Code hooks (notes-capture: saves /n exchanges; notes-paste: pasted image -> similar_images; notes-prompt: /n prompt -> pasted image ids)
```

### Step 12: INSTALL — hook registration step
**File:** `docs/INSTALL.md:45-47`
**Change:** the install list never mentioned the hooks; add the step (it runs after `link_skill`, `scripts/install.sh:343-344`) and renumber the verification step.
**Code:** replace
```markdown
8. Symlinks `~/.claude/skills/n` -> `<this checkout>/claude/skills/n`. An existing symlink is
   replaced; a real directory there stops the script before it changes anything.
9. Prints the verification and exits non-zero unless all four checks pass:
```
with
```markdown
8. Symlinks `~/.claude/skills/n` -> `<this checkout>/claude/skills/n`. An existing symlink is
   replaced; a real directory there stops the script before it changes anything.
9. Merges three hooks into `~/.claude/settings.json` (user scope, every repo), keeping everything
   else; a copy of the original is kept once as `settings.json.bak-notes-hooks`. `--skip-hooks`
   or `NOTES_SKIP_HOOKS=1` skips this.
   - `notes-capture` (Stop): saves each `/n` exchange to the chat history.
   - `notes-paste` (PreToolUse on `similar_images`): searches with a pasted image.
   - `notes-prompt` (UserPromptSubmit, `/n` prompts only): stores the session's pasted images and
     tells Claude their ids, so `/n make that image a new note` works. Other prompts are not read.
10. Prints the verification and exits non-zero unless all four checks pass:
```

### Step 13: INSTALL — uninstall and troubleshooting
**File:** `docs/INSTALL.md:389-391`
**Code:** replace
```markdown
Stops and removes the unit, runs `claude mcp remove --scope user notes`, removes the skill
symlink. It keeps `~/mcp-notes-data` and linger (`sudo loginctl disable-linger $USER` to undo).
```
with
```markdown
Stops and removes the unit, runs `claude mcp remove --scope user notes`, removes the skill
symlink and our three hook entries from `~/.claude/settings.json`. It keeps `~/mcp-notes-data`,
the hooks' state in `~/.local/state/notes-capture` and linger (`sudo loginctl disable-linger $USER`
to undo).
```
**File:** `docs/INSTALL.md:398-399` — after the `/n` not found bullet insert:
```markdown
- `/n make that image a new note` says it has no id for the picture: `tail
  ~/.local/state/notes-capture/prompt.log`, check `jq .hooks.UserPromptSubmit ~/.claude/settings.json`
  names `notes-prompt.mjs` (re-run `scripts/install.sh` if not), and run `npm run verify:prompt-hook`.
```

### Step 14: CHANGELOG
**File:** `CHANGELOG.md:10-11` and `:24`
**Code:** after `### Added` and its blank line (line 11), insert as the first two bullets:
```markdown
- **Pasted image to note**: `create_image` and `attach_image` take `image_id`, the id of an image pasted into the wall chat or a Claude Code `/n` prompt (like `G-0NC`, any case, dash optional), as an alternative to `path` (exactly one of the two). Same copy and sha256 dedupe (`created: false` / `attached: false` for a known picture); an unknown id is refused as "no pasted image". The wall agent and `/n` now use it for "make that image a note" instead of asking for a file path.
- **Claude Code prompt hook** (`notes-prompt`, UserPromptSubmit, `/n` prompts only): stores the session's pasted images (newest 8, 20 MB each, every turn of the session) in the chat image store before Claude answers and tells it their ids, latest marked, so "that image" resolves. Other prompts are untouched. Logs to `~/.local/state/notes-capture/prompt.log`; `npm run verify:prompt-hook` checks it live.
```
and before `### Fixed` (line 24) insert:
```markdown
### Changed

- `scripts/install.sh` registers three Claude Code hooks (notes-capture, notes-paste, notes-prompt) instead of two; `scripts/uninstall.sh` removes all three.

```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit, unchanged by this phase, must stay green) and `npm run test:int -- tests/integration/prompt.hook.int.test.ts`; then the whole `npm run test:int` once (the new file shares the harness DB; `fileParallelism` is off for integration).
**Manual check:** with a demo daemon (`NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo npm start`), `npm run verify:prompt-hook -- --port 7400` and record the exit code in the phase report (0 expected; 1 means the same-turn limitation in README applies and goes to the Handoffs). `node scripts/verify-prompt-hook.mjs --port 1` must exit 2. Read the README hooks section, tool table, state dir and Limitations once rendered.
**Exit criteria:** `prompt.hook.int.test.ts` green on Docker Postgres (8 tests); typecheck and `npm test` green; README says three hooks, `image_id`, the `/n`-only scope, `prompt.log` / `prompt-images/`, the privacy/disk note and `verify:prompt-hook`; INSTALL lists the hook step; CHANGELOG `[Unreleased]` has the two Added bullets and the Changed section.

## Handoffs

- Defects found while running the integration test in `src/` (phase 1) or `claude/` (phase 3) are not fixed here; they are recorded in the plan index Reconciliation Log for the owning phase.
- Confirmed in reconciliation: phase 3 ships `claude/hooks/notes-prompt.d.mts` declaring `runPrompt`, names its log `prompt.log` (`LOG_FILE`) and its memo dir `prompt-images/` (`MEMO_DIR`), does not memoise failed uploads, and returns `null` (not a "could not store" context) when no image could be stored (index Decisions D1). Step 1's assertions and the README text in Steps 5 and 9 stand as written.
- If `verify:prompt-hook` exits 1 on a real run (UserPromptSubmit fires before the transcript holds the current prompt), the PreToolUse rewrite of `create_image` for same-turn pastes is a follow-up task (out of scope per the index), not part of this set.
- `README.md` data layout block (`:784-789`) does not list `chat-images/`; it predates this set and is left as is (R6 needs only the new state files).

## Rollback

`git revert` this phase's commit: it removes the test file and the script, the `verify:prompt-hook` npm script, and restores README/INSTALL/CHANGELOG text. Nothing in `src/` or `claude/` changes, so no runtime behaviour is affected.
