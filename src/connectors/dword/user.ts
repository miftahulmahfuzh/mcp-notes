import { SYSTEM_META } from '../names.js';
import type { Connector } from '../types.js';
import { ConnectorError } from '../types.js';

const LABEL = SYSTEM_META.dword.label;

/** DWORD_USER_EMAIL is unset or blank. Shared verbatim by src/dword/writer.ts (phase 2). */
export function dwordUserNotConfiguredMessage(): string {
  return `${LABEL} user not configured: set DWORD_USER_EMAIL in .env.local`;
}

/** The configured email has no matching users row. Shared verbatim by src/dword/writer.ts (phase 2). */
export function dwordUserNotFoundMessage(email: string): string {
  return `${LABEL} user ${email} not found`;
}

/**
 * Resolves DWORD_USER_EMAIL (config.dword.userEmail) to dword's users.id. Called fresh on every
 * tool invocation — never cached in Config, the same rule loadDatabaseTarget follows by re-reading
 * <repo>/.env.local on every call. `connector` is whatever dword Connector the caller already holds
 * (createDwordConnector() in production, connectorFor('dword', ...) in tests); its query() opens a
 * fresh read-only connection. Used by phases 3/4's MCP tool files; NOT used by phase 2's writer,
 * which holds a raw pg.Client instead of a Connector and does its own equivalent lookup against
 * that client, reusing the two message builders above so the refusal text is identical either way.
 *
 * Refusals (ConnectorError, no write ever attempted):
 *  - "daily-words user not configured: ..."     DWORD_USER_EMAIL is unset or blank
 *  - "daily-words user <email> not found"       the email has no matching users row
 */
export async function resolveDwordUserId(connector: Connector, email: string | null): Promise<string> {
  if (!email) {
    throw new ConnectorError(dwordUserNotConfiguredMessage());
  }
  const result = await connector.query('SELECT id FROM users WHERE email = $1', [email]);
  const row = result.rows[0];
  if (!row) {
    throw new ConnectorError(dwordUserNotFoundMessage(email));
  }
  return String(row[0]);
}
