import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connector } from '../connectors/types.js';
import { registerDwordJournalCurated } from './dwordJournalTools.js';
import { registerDwordVocabCurated } from './dwordVocabTools.js';

/**
 * The dword system's one curated-registration entry point (the plan index's Decisions table:
 * "one registerDwordCurated call"). src/connectors/register.ts calls this once; it fans out to
 * each domain's own curated tools. Phase 3 owns dwordVocabTools.ts; Phase 4 owns this barrel and
 * dwordJournalTools.ts. If this file already exists when the other phase integrates, that
 * phase's implementer adds its own import + call line here rather than creating a second
 * registration function — see the plan index's Reconciliation Log.
 */
export function registerDwordCurated(server: McpServer, connector: Connector): void {
  registerDwordVocabCurated(server, connector);
  registerDwordJournalCurated(server, connector);
}
