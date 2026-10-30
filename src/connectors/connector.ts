import path from 'node:path';
import { connectorSettings, connectorTimeoutMs, loadDatabaseTarget, resolveRepoDir, type SettingsSource } from './env.js';
import { runLabQuery } from './lab.js';
import { SYSTEM_META, type SystemId } from './names.js';
import { runPgQuery } from './pg.js';
import { clampMaxRows, stripTrailingSemicolons } from './rows.js';
import type { Connector, QueryOptions } from './types.js';

export interface ConnectorOptions {
  /** Fixed repo dir (tests). Default: the settings override or ~/<repo>, resolved on every call. */
  repoDir?: string;
  /** Fixed lab.sqlite path (tests). Default: <repo dir>/lab/lab.sqlite. Seer only. */
  labPath?: string;
  /** Fixed statement timeout (tests). Default: CONNECTOR_TIMEOUT_MS, read on every call. */
  timeoutMs?: number;
  /** Where settings come from. Default: process.env over the notes .env.local. */
  settings?: SettingsSource;
}

/**
 * A connector holds no state: every query re-reads settings and the repo's .env.local, opens
 * one connection (or one lab reader), and closes it. Rotated credentials work without a restart.
 */
export function createConnector(id: SystemId, options: ConnectorOptions = {}): Connector {
  const meta = SYSTEM_META[id];
  const perCall = (): { repoDir: string; timeoutMs: number } => {
    const settings = connectorSettings(options.settings);
    return {
      repoDir: options.repoDir ?? resolveRepoDir(id, settings),
      timeoutMs: options.timeoutMs ?? connectorTimeoutMs(settings),
    };
  };
  const connector: Connector = {
    id,
    label: meta.label,
    async query(sql: string, params: readonly unknown[] = [], queryOptions: QueryOptions = {}) {
      const { repoDir, timeoutMs } = perCall();
      const target = loadDatabaseTarget(id, repoDir);
      return runPgQuery(meta.label, target, stripTrailingSemicolons(sql), params, {
        cap: clampMaxRows(queryOptions.maxRows),
        timeoutMs,
      });
    },
  };
  if (meta.hasLab) {
    connector.lab = {
      async query(sql: string, params: readonly unknown[] = [], queryOptions: QueryOptions = {}) {
        const { repoDir, timeoutMs } = perCall();
        const labPath = options.labPath ?? path.join(repoDir, 'lab', 'lab.sqlite');
        return runLabQuery(meta.label, labPath, stripTrailingSemicolons(sql), params, {
          cap: clampMaxRows(queryOptions.maxRows),
          timeoutMs,
        });
      },
    };
  }
  return connector;
}
