/**
 * Opt-in live check: each <system>_schema tool against the owner's real databases (and Seer's
 * real lab.sqlite), read-only. Run with `npm run test:live:connectors` (CONNECTORS_LIVE_TEST=1,
 * no Docker). Never part of `npm test`, `npm run test:int` or `npm run test:live`.
 * Calls only the _schema tools. Prints table counts only. Asserts no password reaches a result.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorSettings, resolveRepoDir } from '../../src/connectors/env.js';
import { CONNECTOR_SYSTEMS, schemaToolName, SYSTEM_META, type SystemId } from '../../src/connectors/names.js';
import { defaultConnectors, registerConnectorTools } from '../../src/connectors/register.js';

const server = new McpServer({ name: 'connectors-live', version: '0.0.0' });
const client = new Client({ name: 'connectors-live-client', version: '0.0.0' });

function repoOf(id: SystemId): string {
  return resolveRepoDir(id, connectorSettings());
}

function passwordsOf(id: SystemId): string[] {
  const file = path.join(repoOf(id), '.env.local');
  if (!existsSync(file)) return [];
  const vars = parse(readFileSync(file));
  return [vars.DATABASE_URL, vars.DATABASE_URL_UNPOOLED].flatMap((u) => {
    try {
      const pw = u ? new URL(u).password : '';
      return pw ? [pw, decodeURIComponent(pw)] : [];
    } catch {
      return [];
    }
  });
}

beforeAll(async () => {
  registerConnectorTools(server, defaultConnectors());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('live connector schemas (read-only)', () => {
  for (const id of CONNECTOR_SYSTEMS) {
    const hasEnv = existsSync(path.join(repoOf(id), '.env.local'));
    it.skipIf(!hasEnv)(`${schemaToolName(id)} reads ${SYSTEM_META[id].label}'s live schema`, async () => {
      const result = (await client.callTool({ name: schemaToolName(id), arguments: {} })) as CallToolResult;
      const first = result.content[0];
      const text = first && first.type === 'text' ? first.text : '';
      for (const pw of passwordsOf(id)) expect(text.includes(pw)).toBe(false);
      expect(result.isError, text).toBeFalsy();
      const body = JSON.parse(text) as { tables?: unknown[]; db?: { tables?: unknown[] }; lab?: { tables?: unknown[]; error?: string } };
      if (id === 'seer') {
        expect(body.db?.tables?.length ?? 0).toBeGreaterThan(0);
        if (existsSync(path.join(repoOf(id), 'lab', 'lab.sqlite'))) expect(body.lab?.tables?.length ?? 0).toBeGreaterThan(0);
        console.log(`[live] seer: ${body.db?.tables?.length} db tables, ${body.lab?.tables?.length ?? 0} lab tables`);
      } else {
        expect(body.tables?.length ?? 0).toBeGreaterThan(0);
        console.log(`[live] ${SYSTEM_META[id].label}: ${body.tables?.length} tables`);
      }
    });
  }
});
