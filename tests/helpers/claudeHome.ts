import { cp, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The committed, redacted fixture Claude home (shapes measured from real 2.1.311 transcripts). */
export const FIXTURE_CLAUDE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claude-home');

/** Fixture session ids and paths. Cwds live under the fake home `/home/u`, which never exists on disk. */
export const FIXTURE = {
  homeDir: '/home/u',
  worktreesDir: '/home/u/.worktrees',
  main: '5e55a001-0000-4000-8000-000000000001',
  worktreeChild: '5e55a001-0000-4000-8000-000000000002',
  sdkCli: '5e55a001-0000-4000-8000-000000000003',
  sdkTs: '5e55a001-0000-4000-8000-000000000004',
  manyPrompts: '5e55a001-0000-4000-8000-000000000005',
  mainFile: 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001.jsonl',
  worktreeFile: 'projects/-home-u--worktrees-mcp-notes-wall-editing/5e55a001-0000-4000-8000-000000000002.jsonl',
  manyPromptsFile: 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000005.jsonl',
} as const;

/** A private copy of the fixture Claude home in a temp dir (tests append to it). Never the real ~/.claude. */
export async function copyFixtureClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-claude-home-'));
  await cp(FIXTURE_CLAUDE_HOME, dir, { recursive: true });
  return dir;
}

/** The many-prompts fixture (written by tests/fixtures/make-many-prompts-fixture.mjs; keep in step). */
export const MANY_PROMPTS = {
  count: 106,
  /** Prompt number of the multi-line prompt over 2000 chars. */
  long: 50,
  /** Prompt number of the prompt holding `fakeKey`. */
  keyed: 60,
  fakeKey: 'sk-ant-api03-FAKE-not-a-real-key-0000000000',
} as const;

/** Prompt `n` of the many-prompts fixture exactly as typed, read from the committed file. */
export async function manyPromptsText(n: number): Promise<string> {
  const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.manyPromptsFile), 'utf8');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    const content = record.message?.content;
    if (record.type === 'user' && typeof content === 'string' && content.startsWith(`fixture prompt ${n}:`)) return content;
  }
  throw new Error(`no prompt ${n} in the many-prompts fixture`);
}
