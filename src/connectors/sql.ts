import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { run } from '../mcp/tools.js';
import { queryFailed } from './errors.js';
import { guardSelect, SqlRefused } from './guard.js';
import { schemaToolName, sqlToolName } from './names.js';
import { CONNECTOR_DEFAULT_ROWS, CONNECTOR_MAX_ROWS, ConnectorError, type Connector, type SystemAbout } from './types.js';

interface SqlArgs {
  sql: string;
  max_rows?: number | undefined;
  source?: 'db' | 'lab' | undefined;
}

const maxRowsField = z
  .number()
  .int()
  .min(1)
  .max(CONNECTOR_MAX_ROWS)
  .optional()
  .describe(`Row cap, 1-${CONNECTOR_MAX_ROWS}. Default ${CONNECTOR_DEFAULT_ROWS}. truncated: true in the result means more rows existed.`);

function sqlHandler(connector: Connector): (args: SqlArgs) => Promise<CallToolResult> {
  return async ({ sql, max_rows, source }) =>
    run(
      async () => {
        const useLab = source === 'lab';
        const target = useLab ? connector.lab : connector;
        if (target === undefined) throw new ConnectorError(`${connector.label} has no lab database`);
        let checked: string;
        try {
          checked = guardSelect(sql, useLab ? 'sqlite' : 'postgres');
        } catch (err) {
          if (err instanceof SqlRefused) throw queryFailed(connector.label, `refused before reaching the database: ${err.message}`);
          throw err;
        }
        return target.query(checked, [], { maxRows: max_rows ?? CONNECTOR_DEFAULT_ROWS });
      },
      { compact: true },
    );
}

export function registerSqlTool(server: McpServer, connector: Connector, about: SystemAbout): void {
  const name = sqlToolName(connector.id);
  const label = connector.label;
  const base =
    `One read-only SELECT (or WITH ... SELECT) against ${label}: ${about.summary}. ` +
    `Use it only when the curated ${connector.id}_ tools do not answer; read ${schemaToolName(connector.id)} first. ` +
    'Writes, DDL and several statements are refused, and the connection itself is read-only. ' +
    'Returns {columns, rows (arrays aligned with columns), row_count, truncated}. Dates come back as text in Asia/Jakarta.';
  const sqlField = z.string().min(1).describe('A single SELECT or WITH ... SELECT. No semicolon-separated statements.');

  if (connector.lab === undefined) {
    server.registerTool(
      name,
      {
        title: `${label} SQL (read-only)`,
        description: `${base} Postgres dialect.`,
        inputSchema: { sql: sqlField, max_rows: maxRowsField },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      sqlHandler(connector),
    );
    return;
  }

  server.registerTool(
    name,
    {
      title: `${label} SQL (read-only)`,
      description: `${base} source "db" (default, Postgres dialect) or "lab" (lab.sqlite, SQLite dialect).`,
      inputSchema: {
        sql: sqlField,
        max_rows: maxRowsField,
        source: z.enum(['db', 'lab']).optional().describe('"db" (default): the Seer Postgres database. "lab": lab.sqlite, the Sera method lab.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    sqlHandler(connector),
  );
}
