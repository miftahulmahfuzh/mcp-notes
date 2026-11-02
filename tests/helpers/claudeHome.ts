import { cp, mkdtemp } from 'node:fs/promises';
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
  mainFile: 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001.jsonl',
  worktreeFile: 'projects/-home-u--worktrees-mcp-notes-wall-editing/5e55a001-0000-4000-8000-000000000002.jsonl',
} as const;

/** A private copy of the fixture Claude home in a temp dir (tests append to it). Never the real ~/.claude. */
export async function copyFixtureClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-claude-home-'));
  await cp(FIXTURE_CLAUDE_HOME, dir, { recursive: true });
  return dir;
}
