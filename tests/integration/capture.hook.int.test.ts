import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCapture } from '../../claude/hooks/notes-capture.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry, skillBodyEntry } from '../unit/hooks/fixtures.js';
import { startHarness, type Harness } from './imageHarness.js';

let h: Harness;
let livePort: string;
let tmp: string;

beforeAll(async () => {
  h = await startHarness();
  livePort = new URL(await h.listen()).port;
});

beforeEach(async () => {
  await h.reset();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-capture-int-'));
});

afterAll(async () => {
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

const fast = { sleep: async (): Promise<void> => undefined };

describe('notes-capture hook against the real endpoint', () => {
  it('a string-form /n turn and an array-form /n turn with an image each become one claude_code thread', async () => {
    const transcript = path.join(tmp, 's.jsonl');
    const env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: livePort };
    await writeFile(transcript, jsonl([commandEntry('list #agentic'), skillBodyEntry(), assistantText('Two notes.')]));
    const first = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Two notes.' }, env, ...fast });
    expect(first.outcome).toBe('delivered');

    await writeFile(
      transcript,
      jsonl([
        commandEntry('list #agentic'),
        assistantText('Two notes.'),
        imagePromptEntry('/n photos like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]),
        assistantText('Three look alike.'),
      ]),
    );
    const second = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Three look alike.' }, env, ...fast });
    expect(second.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(2);
    expect(await count('chat_images')).toBe(1);

    const replay = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Three look alike.' }, env, ...fast });
    expect(replay.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(2);
    await rm(tmp, { recursive: true, force: true });
  });

  it('daemon down spools to the outbox; a later run (any turn) delivers it', async () => {
    const transcript = path.join(tmp, 's.jsonl');
    const stateHome = path.join(tmp, 'state');
    const prompt = commandEntry('save me later');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const down = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'ok' },
      env: { HOME: tmp, XDG_STATE_HOME: stateHome, NOTESD_PORT: await closedPort() },
      ...fast,
    });
    expect(down.outcome).toBe('spooled');
    expect(await readdir(path.join(stateHome, 'notes-capture', 'outbox'))).toEqual([`${String(prompt.uuid)}.json`]);
    expect(await count('chat_threads')).toBe(0);

    await writeFile(transcript, jsonl([prompt, assistantText('ok'), plainPromptEntry('something else'), assistantText('fine')]));
    const up = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'fine' },
      env: { HOME: tmp, XDG_STATE_HOME: stateHome, NOTESD_PORT: livePort },
      ...fast,
    });
    expect(up.drained.delivered).toBe(1);
    expect(await readdir(path.join(stateHome, 'notes-capture', 'outbox'))).toEqual([]);
    expect(await count('chat_threads')).toBe(1);
    await rm(tmp, { recursive: true, force: true });
  });
});
