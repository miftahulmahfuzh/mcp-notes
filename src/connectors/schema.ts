import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../mcp/tools.js';
import { schemaToolName, sqlToolName } from './names.js';
import { toObjects } from './rows.js';
import { CONNECTOR_MAX_ROWS, type Connector, type ReadOnlySource, type SystemAbout } from './types.js';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  comment?: string;
  primary_key?: true;
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view' | 'materialized view';
  comment?: string;
  /** Planner estimate; null when the table was never analysed. Postgres only. */
  approx_rows?: number | null;
  columns: ColumnInfo[];
  /** Primary key, unique and foreign key definitions. Postgres only. */
  constraints?: string[];
}

export interface SchemaPart {
  source: 'db' | 'lab';
  about: string;
  tables: TableInfo[];
}

/** One row per table (columns aggregated), so the row cap counts tables, not columns. */
const PG_TABLES_SQL = `
SELECT c.relname AS name,
       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
       obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS approx_rows,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'name', a.attname,
                  'type', format_type(a.atttypid, a.atttypmod),
                  'nullable', NOT a.attnotnull,
                  'default', pg_get_expr(d.adbin, d.adrelid),
                  'comment', col_description(c.oid, a.attnum)
                ) ORDER BY a.attnum)
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       ), '[]'::json) AS columns,
       COALESCE((
         SELECT json_agg(pg_get_constraintdef(k.oid) ORDER BY k.contype, k.conname)
           FROM pg_constraint k
          WHERE k.conrelid = c.oid AND k.contype IN ('p', 'u', 'f')
       ), '[]'::json) AS constraints
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
 ORDER BY c.relname`;

const LAB_TABLES_SQL = `
SELECT m.name AS table_name, m.type AS kind, p.cid AS cid, p.name AS column_name, p.type AS column_type,
       p."notnull" AS not_null, p.dflt_value AS default_value, p.pk AS pk
  FROM sqlite_master AS m
  JOIN pragma_table_info(m.name) AS p
 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
 ORDER BY m.name, p.cid`;

interface RawPgColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

function wantedSet(only?: readonly string[]): Set<string> | null {
  return only && only.length > 0 ? new Set(only.map((t) => t.toLowerCase())) : null;
}

export async function describePgSchema(source: ReadOnlySource, only?: readonly string[]): Promise<TableInfo[]> {
  const wanted = wantedSet(only);
  const result = await source.query(PG_TABLES_SQL, [], { maxRows: CONNECTOR_MAX_ROWS });
  return toObjects(result)
    .filter((r) => wanted === null || wanted.has(String(r.name).toLowerCase()))
    .map((r) => {
      const columns = ((r.columns as RawPgColumn[] | null) ?? []).map((c) => {
        const col: ColumnInfo = { name: c.name, type: c.type, nullable: c.nullable };
        if (c.default !== null) col.default = c.default;
        if (c.comment !== null) col.comment = c.comment;
        return col;
      });
      const table: TableInfo = {
        name: String(r.name),
        kind: r.kind as TableInfo['kind'],
        approx_rows: (r.approx_rows as number | null) ?? null,
        columns,
      };
      if (typeof r.comment === 'string') table.comment = r.comment;
      const constraints = (r.constraints as string[] | null) ?? [];
      if (constraints.length > 0) table.constraints = constraints;
      return table;
    });
}

export async function describeLabSchema(lab: ReadOnlySource, only?: readonly string[]): Promise<TableInfo[]> {
  const wanted = wantedSet(only);
  const result = await lab.query(LAB_TABLES_SQL, [], { maxRows: CONNECTOR_MAX_ROWS });
  const tables = new Map<string, TableInfo>();
  for (const r of toObjects(result)) {
    const name = String(r.table_name);
    if (wanted !== null && !wanted.has(name.toLowerCase())) continue;
    let table = tables.get(name);
    if (!table) {
      table = { name, kind: r.kind === 'view' ? 'view' : 'table', columns: [] };
      tables.set(name, table);
    }
    const col: ColumnInfo = {
      name: String(r.column_name),
      type: r.column_type ? String(r.column_type) : 'ANY',
      nullable: Number(r.not_null) === 0,
    };
    if (r.default_value !== null && r.default_value !== undefined) col.default = String(r.default_value);
    if (Number(r.pk) > 0) col.primary_key = true;
    table.columns.push(col);
  }
  return [...tables.values()];
}

async function dbPart(source: ReadOnlySource, about: SystemAbout, tables?: readonly string[]): Promise<SchemaPart> {
  return { source: 'db', about: about.db, tables: await describePgSchema(source, tables) };
}

async function labPart(lab: ReadOnlySource, about: SystemAbout, tables?: readonly string[]): Promise<SchemaPart> {
  return { source: 'lab', about: about.lab ?? '', tables: await describeLabSchema(lab, tables) };
}

function settledPart(r: PromiseSettledResult<SchemaPart>): SchemaPart | { error: string } {
  if (r.status === 'fulfilled') return r.value;
  return { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

const tablesField = z
  .array(z.string().min(1))
  .max(100)
  .optional()
  .describe('Only these tables (exact names). Omit for every table.');

export function registerSchemaTool(server: McpServer, connector: Connector, about: SystemAbout): void {
  const name = schemaToolName(connector.id);
  const sqlName = sqlToolName(connector.id);
  const label = connector.label;
  const lab = connector.lab;
  const base = `Tables, columns, types and what they mean in ${label}: ${about.summary}. Read-only, built from the live database`;

  if (lab === undefined) {
    server.registerTool(
      name,
      {
        title: `${label} schema`,
        description: `${base}. Call it before writing a ${sqlName} query; pass tables to keep the answer short. Prefer the curated ${connector.id}_ tools for common questions.`,
        inputSchema: { tables: tablesField },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ tables }) => run(async () => ({ system: label, ...(await dbPart(connector, about, tables)) }), { compact: true }),
    );
    return;
  }

  server.registerTool(
    name,
    {
      title: `${label} schema`,
      description: `${base}, and from lab.sqlite (Sera, the method lab). source "db", "lab" or "both" (default). Call it before writing a ${sqlName} query; pass tables to keep the answer short. Prefer the curated ${connector.id}_ tools for common questions.`,
      inputSchema: {
        tables: tablesField,
        source: z
          .enum(['db', 'lab', 'both'])
          .optional()
          .describe('"db" = the Postgres database, "lab" = lab.sqlite, "both" (default).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tables, source }) =>
      run(
        async () => {
          const which = source ?? 'both';
          if (which === 'db') return { system: label, ...(await dbPart(connector, about, tables)) };
          if (which === 'lab') return { system: label, ...(await labPart(lab, about, tables)) };
          const [db, labResult] = await Promise.allSettled([dbPart(connector, about, tables), labPart(lab, about, tables)]);
          if (db.status === 'rejected' && labResult.status === 'rejected') throw db.reason;
          return { system: label, db: settledPart(db), lab: settledPart(labResult) };
        },
        { compact: true },
      ),
  );
}
