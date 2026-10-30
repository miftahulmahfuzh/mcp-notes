import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
};

/** The owner's three repos (~/expense-tracking, ~/run-insights, ~/seer or their overrides), resolved per call. */
export function defaultConnectors(): Connectors {
  return {
    expenses: createExpensesConnector(),
    runs: createRunsConnector(),
    seer: createSeerConnector(),
  };
}

/** Registers <id>_schema and <id>_sql for every system, then each system's curated tools. */
export function registerConnectorTools(server: McpServer, connectors: Connectors): void {
  for (const id of CONNECTOR_SYSTEMS) {
    registerSchemaTool(server, connectors[id], ABOUT[id]);
    registerSqlTool(server, connectors[id], ABOUT[id]);
  }
  registerExpensesCurated(server, connectors.expenses);
  registerRunsCurated(server, connectors.runs);
  registerSeerCurated(server, connectors.seer);
}
