/**
 * Every connector tool name, written once here. Phase 1 registers the generic `_schema` and
 * `_sql` tools; phases 2-4 register the curated ones; the chat bar (src/chat) imports
 * ALL_CONNECTOR_TOOL_NAMES for its allow list. Adding a fourth system is one more entry in each
 * table below plus one directory under src/connectors.
 */
export const CONNECTOR_SYSTEMS = ['expenses', 'runs', 'seer'] as const;
export type SystemId = (typeof CONNECTOR_SYSTEMS)[number];

export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
} as const satisfies Record<SystemId, readonly string[]>;

export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[SystemId][number];

/** All 15 names, flattened in the order above. */
export const ALL_CONNECTOR_TOOL_NAMES: readonly ConnectorToolName[] = CONNECTOR_SYSTEMS.flatMap(
  (id): ConnectorToolName[] => [...CONNECTOR_TOOL_NAMES[id]],
);

export interface SystemMeta {
  id: SystemId;
  /** Used in every error message: "<label> is not reachable: ...". */
  label: string;
  /** Environment / notes .env.local key that overrides the repo directory. */
  repoDirEnv: string;
  /** Default repo directory, ~-relative. */
  defaultRepoDir: string;
  /** Chat bar status caption for this system's tools. */
  caption: string;
  /** True when the system also has a lab.sqlite (Seer). */
  hasLab: boolean;
}

export const SYSTEM_META: Record<SystemId, SystemMeta> = {
  expenses: {
    id: 'expenses',
    label: 'expense-tracking',
    repoDirEnv: 'EXPENSE_TRACKING_DIR',
    defaultRepoDir: '~/expense-tracking',
    caption: 'reading expenses',
    hasLab: false,
  },
  runs: {
    id: 'runs',
    label: 'run-insights',
    repoDirEnv: 'RUN_INSIGHTS_DIR',
    defaultRepoDir: '~/run-insights',
    caption: 'reading runs',
    hasLab: false,
  },
  seer: {
    id: 'seer',
    label: 'seer',
    repoDirEnv: 'SEER_DIR',
    defaultRepoDir: '~/seer',
    caption: 'reading seer',
    hasLab: true,
  },
};

export function schemaToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][0];
}

export function sqlToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][1];
}
