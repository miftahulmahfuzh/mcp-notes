import { access, appendFile, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The committed fork fixture home (written by tests/fixtures/make-fork-fixtures.mjs; keep in step). */
export const FORK_FIXTURE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claude-home-forks');
export const FORK_PROJECT_DIR = 'projects/-home-u-mcp-notes';

export const FORKS = {
  parent: 'f0a0a001-0000-4000-8000-000000000001',
  /** Background-job fork of the parent (has jobs/f0b0b001/state.json). */
  job: 'f0b0b001-0000-4000-8000-000000000002',
  /** `claude --resume <parent> --fork-session` in a terminal: no job record. */
  terminal: 'f0c0c001-0000-4000-8000-000000000003',
  /** Terminal fork of the terminal fork. */
  forkOfFork: 'f0d0d001-0000-4000-8000-000000000004',
  /** Background-job fork that holds only the copy (its own records are in appends/). */
  pending: 'f0f0f001-0000-4000-8000-000000000005',
  /** An ordinary session with an unreadable job record. */
  unrelated: 'f0e0e001-0000-4000-8000-000000000006',
} as const;

/** The job record's forkBoundaryAt, and the timestamp of the parent's last copied record. */
export const FORK_BOUNDARY = new Date('2026-11-01T01:05:05.000Z');
/** The parent's first uuid, which every fork's transcript starts with too. */
export const PARENT_HEAD_UUID = 'a1000000-0000-4000-8000-000000000001';
/** The first record each fork wrote itself: its cut. */
export const OWN_UUID = {
  job: 'b2000000-0000-4000-8000-000000000001',
  terminal: 'c3000000-0000-4000-8000-000000000001',
  forkOfFork: 'd4000000-0000-4000-8000-000000000001',
  pending: 'e5000000-0000-4000-8000-000000000001',
} as const;

/** A temp Claude home with an empty project dir. Never the real ~/.claude. */
export async function emptyClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-fork-home-'));
  await mkdir(path.join(dir, FORK_PROJECT_DIR), { recursive: true });
  return dir;
}

export function forkTranscript(home: string, sessionId: string): string {
  return path.join(home, FORK_PROJECT_DIR, `${sessionId}.jsonl`);
}

/** The fixture transcript of `sessionId`, as committed. */
export function fixtureTranscript(sessionId: string): string {
  return path.join(FORK_FIXTURE_HOME, FORK_PROJECT_DIR, `${sessionId}.jsonl`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copies each session's job dir (all of them first), then its transcript, into `home`. */
export async function stageForks(home: string, ...sessionIds: string[]): Promise<void> {
  for (const sid of sessionIds) {
    const jobDir = path.join(FORK_FIXTURE_HOME, 'jobs', sid.slice(0, 8));
    if (await exists(jobDir)) await cp(jobDir, path.join(home, 'jobs', sid.slice(0, 8)), { recursive: true });
  }
  for (const sid of sessionIds) await cp(fixtureTranscript(sid), forkTranscript(home, sid));
}

/** Appends the pending fork's own records (its first prompt and reply) to its transcript in `home`. */
export async function appendPendingOwn(home: string): Promise<void> {
  const own = await readFile(path.join(FORK_FIXTURE_HOME, 'appends', `${FORKS.pending}.own.jsonl`), 'utf8');
  await appendFile(forkTranscript(home, FORKS.pending), own);
}

/** Byte offset of the line of `file` whose record has `uuid`. */
export async function offsetOfUuid(file: string, uuid: string): Promise<number> {
  const text = await readFile(file, 'utf8');
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.includes(`"uuid":"${uuid}"`)) return offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  throw new Error(`no record ${uuid} in ${file}`);
}
