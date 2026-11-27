import { hostname } from 'node:os';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
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
