import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { isPooledUrl, REPO_ROOT } from '../config.js';
import { reasonOf, unreachable } from './errors.js';
import { SYSTEM_META, type SystemId } from './names.js';
import { CONNECTOR_DEFAULT_TIMEOUT_MS } from './types.js';

/** mcp-notes' own .env.local: connector settings may live there, like every other notesd setting. */
export const CONNECTOR_SETTINGS_FILE = path.join(REPO_ROOT, '.env.local');

const SETTING_KEYS = ['EXPENSE_TRACKING_DIR', 'RUN_INSIGHTS_DIR', 'SEER_DIR', 'CONNECTOR_TIMEOUT_MS'] as const;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

export interface SettingsSource {
  /** Default process.env. Never mutated. */
  env?: NodeJS.ProcessEnv;
  /** Default CONNECTOR_SETTINGS_FILE; false skips it. A missing file is not an error. */
  envFile?: string | false;
}

/** The connector keys only, real env over the notes .env.local. Read on every call. */
export function connectorSettings(source: SettingsSource = {}): Record<string, string | undefined> {
  const env = source.env ?? process.env;
  const file = source.envFile ?? CONNECTOR_SETTINGS_FILE;
  let fromFile: Record<string, string> = {};
  if (file !== false && existsSync(file)) {
    try {
      fromFile = parseDotenv(readFileSync(file));
    } catch {
      fromFile = {};
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const key of SETTING_KEYS) {
    const value = env[key]?.trim() || fromFile[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** For messages: home directory shown as ~. Paths are not secrets. */
export function displayPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function resolveRepoDir(id: SystemId, settings: Record<string, string | undefined>): string {
  const meta = SYSTEM_META[id];
  return path.resolve(expandHome(settings[meta.repoDirEnv] ?? meta.defaultRepoDir));
}

export function connectorTimeoutMs(settings: Record<string, string | undefined>): number {
  const raw = settings.CONNECTOR_TIMEOUT_MS;
  if (raw === undefined) return CONNECTOR_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) return CONNECTOR_DEFAULT_TIMEOUT_MS;
  return n;
}

/**
 * The direct (non-pooler) URL among DATABASE_URL / DATABASE_URL_UNPOOLED, chosen by host:
 * Neon poolers reject the startup options that make the session read-only. Falls back to
 * whichever exists.
 */
export function pickDirectUrl(vars: Record<string, string | undefined>): string | undefined {
  const candidates = [vars.DATABASE_URL, vars.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v);
  return candidates.find((c) => !isPooledUrl(c)) ?? candidates[0];
}

/**
 * Drops an `options` query parameter (a parsed connection string overrides the client's own
 * `options`, which carry default_transaction_read_only) and spells sslmode=require/prefer as
 * verify-full, which is what pg already does with them, without its deprecation warning.
 */
export function prepareUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.searchParams.delete('options');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode === 'require' || sslmode === 'prefer') url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/** Strings that must never appear in an error: the URL, user, password, host. */
export function secretsOf(raw: string): string[] {
  const out = [raw];
  try {
    const url = new URL(raw);
    out.push(url.toString(), url.username, url.password, url.hostname, url.host);
    try {
      out.push(decodeURIComponent(url.username), decodeURIComponent(url.password));
    } catch {
      // undecodable: the encoded forms above are enough
    }
  } catch {
    // not a URL: the raw string is the secret
  }
  return out.filter((s) => s.length > 0);
}

export interface DatabaseTarget {
  url: string;
  secrets: string[];
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Reads <repoDir>/.env.local now (never cached) and picks the direct URL. Throws "not reachable". */
export function loadDatabaseTarget(id: SystemId, repoDir: string): DatabaseTarget {
  const { label } = SYSTEM_META[id];
  if (!isDirectory(repoDir)) throw unreachable(label, `no repository at ${displayPath(repoDir)}`);
  const file = path.join(repoDir, '.env.local');
  if (!existsSync(file)) throw unreachable(label, `no .env.local in ${displayPath(repoDir)}`);
  let vars: Record<string, string>;
  try {
    vars = parseDotenv(readFileSync(file));
  } catch (err) {
    throw unreachable(label, `cannot read ${displayPath(file)}: ${reasonOf(err)}`);
  }
  const raw = pickDirectUrl(vars);
  if (!raw) throw unreachable(label, `${displayPath(file)} has no DATABASE_URL or DATABASE_URL_UNPOOLED`);
  const url = prepareUrl(raw);
  return { url, secrets: [...secretsOf(raw), ...secretsOf(url)] };
}
