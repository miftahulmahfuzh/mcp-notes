import { displayPath, connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';
import { CONNECTOR_SYSTEMS, SYSTEM_META } from '../../../src/connectors/names.js';
import { buildSystemDb, connectorsAdminUrl, siblingRepo, systemDbName } from './siblings.js';

/**
 * Vitest globalSetup for the integration run: rebuild one database per connector from the
 * sibling repo's migrations (read as files, never imported). A missing repo is skipped with a
 * message; its describeWithRepo blocks skip too. A migration that fails is a hard error.
 */
export default async function setup(): Promise<void> {
  connectorsAdminUrl();
  for (const id of CONNECTOR_SYSTEMS) {
    const meta = SYSTEM_META[id];
    const repo = siblingRepo(id);
    if (repo === null) {
      const expected = displayPath(resolveRepoDir(id, connectorSettings({ envFile: false })));
      console.warn(`[connectors] ${meta.label}: no repository with migrations at ${expected} (set ${meta.repoDirEnv}); its integration tests are skipped.`);
      continue;
    }
    const count = await buildSystemDb(id, repo);
    console.log(`[connectors] ${meta.label}: ${systemDbName(id)} built from ${count} migrations in ${displayPath(repo)}`);
  }
}
