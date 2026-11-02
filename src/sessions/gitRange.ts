import { execFile } from 'node:child_process';
import { MAX_COMMITS, type SessionCommit } from './types.js';
import type { CommitRange } from './transcript.js';

/** The commits of one `from..to` range, oldest first. Resolves `[]` when git cannot answer. */
export type GitRangeLog = (range: CommitRange) => Promise<SessionCommit[]>;

const GIT_TIMEOUT_MS = 5_000;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * `git log from..to` in the range's cwd. Short shas (`%h`) so a commit also seen as a
 * `[branch sha] subject` line unions with it by sha. A missing cwd (a deleted worktree), a range
 * the repo does not have or any git failure gives `[]`: commits are best effort, never an ingest error.
 */
export function createGitRangeLog(gitBin = 'git'): GitRangeLog {
  return (range) =>
    new Promise((resolve) => {
      if (range.cwd === null || !SHA.test(range.from) || !SHA.test(range.to)) {
        resolve([]);
        return;
      }
      const args = ['-C', range.cwd, 'log', '--reverse', `--max-count=${MAX_COMMITS}`, '--format=%h%x00%cI%x00%s', `${range.from}..${range.to}`];
      execFile(gitBin, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseGitLog(stdout));
      });
    });
}

/** `%h%x00%cI%x00%s` lines → commits, `at` in UTC ISO. Subjects are clipped by the repo merge. */
export function parseGitLog(stdout: string): SessionCommit[] {
  const commits: SessionCommit[] = [];
  for (const line of stdout.split('\n')) {
    const [sha, when, subject] = line.split('\0');
    if (sha === undefined || subject === undefined || !SHA.test(sha)) continue;
    const ms = Date.parse(when ?? '');
    commits.push({ sha, subject: subject.trim(), at: Number.isFinite(ms) ? new Date(ms).toISOString() : null });
  }
  return commits;
}

/** `commits` plus every range's commits, each sha once. Ranges are expanded one at a time. */
export async function withRangeCommits(commits: SessionCommit[], ranges: CommitRange[], log: GitRangeLog): Promise<SessionCommit[]> {
  if (ranges.length === 0) return commits;
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const range of ranges) {
    for (const c of await log(range)) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
  }
  return [...bySha.values()];
}
