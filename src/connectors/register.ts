import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDwordConnector, DWORD_ABOUT } from './dword/index.js';
import { registerExpensesCurated } from './expenses/curated.js';
import { createExpensesConnector, EXPENSES_ABOUT } from './expenses/index.js';
import { CONNECTOR_SYSTEMS, type SystemId } from './names.js';
import { registerRunsCurated } from './runs/curated.js';
import { createRunsConnector, RUNS_ABOUT } from './runs/index.js';
import { registerSchemaTool } from './schema.js';
import { registerSeerCurated } from './seer/curated.js';
import { createSeerConnector, SEER_ABOUT } from './seer/index.js';
import { registerSqlTool } from './sql.js';
import type { Connectors, SystemAbout } from './types.js';

const ABOUT: Record<SystemId, SystemAbout> = {
  expenses: EXPENSES_ABOUT,
  runs: RUNS_ABOUT,
  seer: SEER_ABOUT,
  dword: DWORD_ABOUT,
};

/** The owner's four repos (~/expense-tracking, ~/run-insights, ~/seer, ~/daily-words or their overrides), resolved per call. */
export function defaultConnectors(): Connectors {
  return {
    expenses: createExpensesConnector(),
    runs: createRunsConnector(),
    seer: createSeerConnector(),
    dword: createDwordConnector(),
  };
}

/**
 * Registers <id>_schema and <id>_sql for every system, then each system's curated tools. dword
 * has no curated tools yet: its curated call (registerDwordCurated, covering both the vocab and
 * journal tools) is added once phases 3 and 4 have both landed (see DWORD_CONNECTOR_PLAN.md's
 * Decisions table) — phase 1 wires in only the generic pair every system gets below.
 */
export function registerConnectorTools(server: McpServer, connectors: Connectors): void {
  for (const id of CONNECTOR_SYSTEMS) {
    registerSchemaTool(server, connectors[id], ABOUT[id]);
    registerSqlTool(server, connectors[id], ABOUT[id]);
  }
  registerExpensesCurated(server, connectors.expenses);
  registerRunsCurated(server, connectors.runs);
  registerSeerCurated(server, connectors.seer);
}
