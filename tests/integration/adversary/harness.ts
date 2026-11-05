import { readFileSync } from 'node:fs';
import { describe } from 'vitest';
import { migrationFiles, siblingRepo } from '../connectors/siblings.js';

/**
 * The reviewer's integration tests need Seer migration 027. Until phase 7 lands Seer, run them with
 * SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial (plan invariant 8); against a Seer
 * checkout without the migration they skip with that reason, so the suite stays green.
 */
export function seerHasAdversarySchema(): boolean {
  const repo = siblingRepo('seer');
  if (repo === null) return false;
  return migrationFiles('seer', repo).some((file) => /CREATE TABLE\s+(IF NOT EXISTS\s+)?adversary_verdicts\b/i.test(readFileSync(file, 'utf8')));
}

export function describeWithAdversarySchema(name: string, fn: () => void): void {
  if (seerHasAdversarySchema()) {
    describe(name, fn);
    return;
  }
  describe.skip(`${name} [skipped: the Seer repository at SEER_DIR has no adversary_verdicts migration; set SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial]`, fn);
}
