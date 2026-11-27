import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY = readFileSync(path.join(REPO, '.claude/skills/verify-notesd/scripts/verify.sh'), 'utf8');

/** The `local -a env=( ... )` every throwaway daemon starts with, whatever `up`'s flags are. */
function baseEnv(): string[] {
  const block = /\n\s*local -a env=\(\n([\s\S]*?)\n\s*\)\n/.exec(VERIFY)?.[1];
  if (block === undefined) throw new Error("verify.sh has no 'local -a env=(' block");
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe("verify.sh pins a throwaway daemon's outward-facing switches", () => {
  it('never starts Seer\'s GitHub nightly (NOTESD_SEER_DISPATCH=off for every run, --adversary too)', () => {
    expect(baseEnv()).toContain('NOTESD_SEER_DISPATCH=off');
    // Nothing later in the script turns it back on.
    expect(VERIFY.match(/NOTESD_SEER_DISPATCH=(?!off)/g) ?? []).toEqual([]);
  });
});
