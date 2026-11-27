import { hostname } from 'node:os';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { AppDeps } from '../deps.js';
import { createAdversaryService, type AdversaryService, type CreateAdversaryServiceOptions } from './service.js';

export interface BuildAdversaryIo {
  create?: (opts: CreateAdversaryServiceOptions) => AdversaryService | null;
  host?: () => string;
  log?: (line: string) => void;
}

/**
 * Seer Adversarial (src/adversary/): built here, started and closed by startBackground. Null with NOTESD_ADVERSARY=off,
 * or when no claude binary is found (said once in the log).
 */
export function buildAdversary(config: Pick<Config, 'adversary' | 'chat' | 'dataDir'>, db: Db, io: BuildAdversaryIo = {}): AdversaryService | null {
  if (!config.adversary.enabled) return null;
  const create = io.create ?? createAdversaryService;
  const adversary = create({
    config: config.adversary,
    db,
    claudeBin: config.chat.claudeBin,
    dataDir: config.dataDir,
    host: (io.host ?? hostname)(),
  });
  if (adversary === null) {
    (io.log ?? ((line: string) => console.log(line)))(`[notesd] adversary off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
  }
  return adversary;
}

/** Seer Adversarial's poll loop: started here, closed with the background. Without a reviewer, one line says why. */
export function startAdversary(deps: Pick<AppDeps, 'adversary' | 'config'>, log: (line: string) => void = (line) => console.log(line)): void {
  if (deps.adversary === null) {
    log(deps.config.adversary.enabled ? '[notesd] adversary off: no reviewer could be built' : '[notesd] adversary off: NOTESD_ADVERSARY=off');
    return;
  }
  deps.adversary.start();
  const a = deps.config.adversary;
  log(
    `[notesd] adversary reviewer on as ${deps.adversary.host}: a pass every ${Math.round(a.pollMs / 1000)} s, up to ${a.dailyCap} deep reviews a day, ${a.gatherModel} gathers, ${a.verdictModel} decides`,
  );
}
