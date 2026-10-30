> Adopted from `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` phase 1. Source: `.workflows/plan/notes-spine-images-ui/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Scaffold, config, schema, ids, tags, test harness

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R1 (the spine's foundation: Neon schema via Drizzle, `A-B32` ids, `#hashtag` tags, `note_revisions`, vitest unit + integration harness against a real Postgres)
**Depends on:** none
**Difficulty:** NORMAL
**Package:** repo root, `src/db`, `src/notes`

---

## Goal

After this phase the empty repo is a Node 22 + TypeScript ESM package with every dependency the
whole 8-phase set needs (exact versions, one `package-lock.json`), a config loader, a Drizzle
schema with its single migration (every table and index the set needs), the id and tag helpers,
and a working test harness: `npm test` for unit tests and `npm run test:int` for integration tests
against a dedicated Docker `postgres:16`. The migration is applied to the project's Neon
database, which then has `notes`, `note_revisions` and all indexes.

## Prototype status (read this first)

Everything in this plan was built and run in a scratch copy on 2026-10-30 before the plan was
written: `npm install` of the exact `package.json` below (260 packages, no peer conflicts),
`npm run typecheck` clean, `npm run build` emits `dist/{config,db,notes}`, `npm test` 60/60 (62 with the two URL-choice tests the reconciler added to `config.test.ts`; `drizzle.config.ts` and `loadConfig`'s URL choice were rewritten by the reconciler to pick by host and are not prototype output),
`npm run test:int` 9/9 (fresh container, reused container, stopped container), a jsdom `.tsx`
test ran under this `vitest.config.ts` without `@vitejs/plugin-react`, and `createDb` opened a
transaction on the real Neon host through both URLs (read-only `select 1`). All code blocks below
are the files that passed. The prototype's test container was removed afterwards.

Two facts found while prototyping change what the implementer does:

1. **`.env.local` has the two Neon key names swapped** (coordinator-verified): `DATABASE_URL`
   holds the direct host and `DATABASE_URL_UNPOOLED` holds the `-pooler` host. `.env.local` is the
   owner's secrets file in the main checkout (reached through the worktree symlink) and this phase
   **does not edit it**. Instead the code chooses by host, not by key name:
   `drizzle.config.ts` uses whichever of `DATABASE_URL_UNPOOLED` / `DATABASE_URL` has a host
   without `-pooler` (and errors only when neither does), and `src/config.ts` gives the daemon the
   pooled one of the two when present, else whichever exists. An explicit `DATABASE_URL` in the
   real process environment still overrides the file outright (tests and manual test-port runs
   rely on that). This works with the file as it is today and with a corrected file.
2. **npm 12 blocks install scripts** (`esbuild` postinstall) and prints an `install-scripts`
   warning. It is harmless: esbuild's platform binary comes from `@esbuild/linux-x64` and
   tsx / drizzle-kit / vite all work. sharp 0.35 uses prebuilt `@img/*` packages, no script.

## Interface Contract

**Deletes:** nothing (greenfield).
**Renames:** nothing.
**Creates:**
- `package.json` (all deps for phases 1-8; scripts `dev`, `start`, `build:server`, `build`, `typecheck`, `test`, `test:watch`, `test:int`, `db:generate`, `db:migrate`, `db:check`), `package-lock.json`
- `tsconfig.json` (typecheck: `src/**`, `tests/**`, the two config files; NodeNext ESM, `noEmit`), `tsconfig.server.json` (emit `src/` → `dist/`)
- `vitest.config.ts`, `drizzle.config.ts`, `.gitignore` (extended)
- `src/config.ts`: `REPO_ROOT`, `DEFAULT_PORT` (7317), `LOOPBACK_HOST` (`'127.0.0.1'`), `DEFAULT_DATA_DIR`, `interface Config { databaseUrl; port; host: '127.0.0.1'; dataDir }`, `interface LoadConfigOptions { env?; envFile? }`, `class ConfigError`, `isPooledUrl(url): boolean`, `function loadConfig(options?: LoadConfigOptions): Config`
- `src/db/schema.ts`: tables `notes`, `noteRevisions`; types `ImageMeta`, `NoteOrigin`, `NoteRow`, `NewNoteRow`, `NoteRevisionRow`, `NewNoteRevisionRow`
- `src/db/client.ts`: `type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }`, `isNeonUrl(url): boolean`, `createDb(url): Db`, `closeDb(db): Promise<void>`, re-export `schema`
- `drizzle/0000_init.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0000_snapshot.json` (generated)
- `src/notes/ids.ts`: `ID_ALPHABET`, `ID_PATTERN`, `ID_SPACE`, `generateId(random?)`, `isValidId(s)`, `normalizeId(s): string | null`, `class InvalidIdError`, `parseId(s): string`
- `src/notes/tags.ts`: `interface TagSpan`, `tagSpans(body)`, `parseTags(body): string[]`, `normalizeTag(s): string | null` (pure, no Node imports: the web app may import it)
- `scripts/test-int.sh`
- `tests/unit/{ids,tags,config,db-client}.test.ts`
- `tests/integration/setup.ts`: `MIGRATIONS_DIR`, `testDatabaseUrl()`, `openTestDb()`, `closeTestDb(db)`, `migrateTestDb()`, `truncateAll(db)`
- `tests/integration/globalSetup.ts` (migrates the Docker DB once per run), `tests/integration/schema.int.test.ts`
- Neon: tables `notes`, `note_revisions`, schema `drizzle` with `__drizzle_migrations` (one row)

**Schema names later phases use (exact):**
- table `notes`: `id text pk`, `body text not null`, `tags text[] not null default '{}'`, `image_path text`, `image_meta jsonb`, `origin jsonb`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `deleted_at timestamptz`
- table `note_revisions`: `id bigserial pk` (the revision number for `revisions`/`revert`), `note_id text not null → notes.id on delete cascade`, `body text not null` (the body BEFORE the change), `saved_at timestamptz not null default now()`
- indexes: `notes_tags_gin` (GIN tags), `notes_body_fts_gin` (GIN `to_tsvector('simple', body)`), `notes_created_at_idx`, `notes_updated_at_idx`, `notes_image_sha256_live_uniq` (UNIQUE on `(image_meta ->> 'sha256')` WHERE `image_meta is not null and deleted_at is null`), `notes_image_taken_at_idx` (btree on `(image_meta ->> 'taken_at')`), `note_revisions_note_saved_idx` (`note_id, saved_at desc`)
- Drizzle property names: `notes.{id, body, tags, imagePath, imageMeta, origin, createdAt, updatedAt, deletedAt}`, `noteRevisions.{id, noteId, body, savedAt}`

**Signature changes:** none.
**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `src/notes/{types,repo,service,events}.ts`, `src/mcp/**`, `src/http/**`, `src/background.ts`, `src/main.ts` (Phase 2); `claude/`, `deploy/`, `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/windows/`, `docs/INSTALL.md` (Phase 3); `src/images/**` (Phase 4); `src/http/images.ts`, `src/mcp/imageTools.ts` (Phase 5); `src/http/api.ts`, `src/http/static.ts`, `src/chat/**` (Phase 6); `web/**`, `tsconfig.web.json`, `package.json` `scripts` after this phase (Phase 7); web image components (Phase 8).

## Files

| File | Action | What changes |
|---|---|---|
| `.gitignore:1` | modify | add `node_modules/`, `dist/`, `web/dist/`, `coverage/`, `*.tsbuildinfo` |
| `package.json` | create | ESM package, exact-pinned deps for all 8 phases, scripts |
| `package-lock.json` | create | generated by `npm install` |
| `tsconfig.json` | create | strict NodeNext, `noEmit`, typecheck scope |
| `tsconfig.server.json` | create | emits `src/**` to `dist/` |
| `vitest.config.ts` | create | unit vs integration switch on `VITEST_INTEGRATION=1` |
| `drizzle.config.ts` | create | expense-tracking style, refuses a pooled host |
| `src/config.ts` | create | `loadConfig()` |
| `src/db/schema.ts` | create | `notes`, `note_revisions`, all indexes |
| `src/db/client.ts` | create | `createDb(url)` driver switch |
| `drizzle/0000_init.sql` + `drizzle/meta/*` | create (generated) | the single migration |
| `src/notes/ids.ts` | create | id generate / normalise / validate |
| `src/notes/tags.ts` | create | hashtag parsing |
| `scripts/test-int.sh` | create | Docker `mcp-notes-pg-test` on 55433, then vitest |
| `tests/unit/ids.test.ts` | create | |
| `tests/unit/tags.test.ts` | create | |
| `tests/unit/config.test.ts` | create | |
| `tests/unit/db-client.test.ts` | create | |
| `tests/integration/setup.ts` | create | helpers |
| `tests/integration/globalSetup.ts` | create | migrate once |
| `tests/integration/schema.int.test.ts` | create | schema smoke |

All paths are relative to the worktree root `/home/miftah/.worktrees/mcp-notes/notes-spine-images-ui`
unless absolute. Every created file is new, so its "line reference" is line 1.

## Implementation Steps

Run every command with Node 22 first on PATH:

```bash
export PATH="$HOME/tools/node-v22.23.1-linux-x64/bin:$PATH"
cd /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui
node -v   # v22.23.1
```

### Step 1: Check (do not edit) `.env.local`
**File:** `.env.local` (symlink → `/home/miftah/mcp-notes/.env.local`), read only
**Change:** none. This is the owner's secrets file; no phase edits it. Confirm the symlink
resolves and both keys exist, printing hostnames only, never values:
```bash
node -e "const e=require('fs').readFileSync('.env.local','utf8');for(const k of ['DATABASE_URL','DATABASE_URL_UNPOOLED']){const m=e.match(new RegExp('^'+k+'=(.*)$','m'));console.log(k,m?new URL(m[1].trim().replace(/^[\"']|[\"']$/g,'')).hostname:'(missing)')}"
```
Today this prints the direct host under `DATABASE_URL` and the `-pooler` host under
`DATABASE_URL_UNPOOLED` (the names are swapped). That is expected: Steps 6 and 7 choose by host.
**Impact:** none.

### Step 2: Extend `.gitignore`
**File:** `.gitignore:1` (today the whole file is the single line `.env.local`)
**Change:** replace the file.
**Code:**
```gitignore
.env.local
node_modules/
dist/
web/dist/
coverage/
*.tsbuildinfo
```
**Impact:** none on code.

### Step 3: `package.json` and install
**File:** `package.json` (new)
**Change:** every runtime and dev dependency of the whole plan set, exact versions. Versions
were checked with `npm view` on 2026-10-30. Where expense-tracking uses a package, its version is
kept (drizzle-orm 0.45.2, drizzle-kit 0.31.10, @neondatabase/serverless 1.1.0, vitest 4.1.2,
typescript 5.9.3 — not the 7.x Go port, tsx 4.23.12, sharp 0.35.3, zod 4.4.3, dotenv 17.4.2,
react / react-dom 19.2.8, @types/react 19.2.18, @types/react-dom 19.2.4). `@types/node` follows
the runtime (22.x). Web-only packages (vite, react, fonts, Phosphor, testing-library) are
devDependencies because they are bundled into `web/dist` at build time; the daemon never
imports them. `engines.node >=22.22.0` because jsdom 30 needs `^22.22.2` and chokidar 6 needs
`>=22.22`; the installed 22.23.1 satisfies both.

Font packages: `@fontsource-variable/host-grotesk` (family `Host Grotesk Variable`) and
`@fontsource/geist-mono` (family `Geist Mono`, static weights 100-900), the two names the
analysis chose. Both exist at 5.3.0.

Scripts `dev` and `start` point at `src/main.ts` / `dist/main.js`, which Phase 2 creates; they
are not run in this phase. `build` is `build:server` until Phase 7 rewrites it.
**Code:**
```json
{
  "name": "mcp-notes",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.22.0"
  },
  "dependencies": {
    "@hono/node-server": "2.1.5",
    "@modelcontextprotocol/sdk": "1.32.2",
    "@neondatabase/serverless": "1.1.0",
    "chokidar": "6.0.0",
    "dotenv": "17.4.2",
    "drizzle-orm": "0.45.2",
    "exifr": "7.1.3",
    "file-type": "22.3.0",
    "heic-convert": "2.1.0",
    "hono": "4.13.14",
    "pg": "8.23.1",
    "sharp": "0.35.3",
    "ws": "8.22.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@fontsource-variable/host-grotesk": "5.3.0",
    "@fontsource/geist-mono": "5.3.0",
    "@phosphor-icons/react": "2.1.10",
    "@testing-library/dom": "10.4.2",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.8",
    "@types/heic-convert": "2.1.1",
    "@types/node": "22.20.5",
    "@types/pg": "8.23.1",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@types/ws": "8.18.2",
    "@vitejs/plugin-react": "6.1.2",
    "drizzle-kit": "0.31.10",
    "jsdom": "30.1.3",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "tsx": "4.23.12",
    "typescript": "5.9.3",
    "vite": "8.3.5",
    "vitest": "4.1.2"
  },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "build:server": "tsc -p tsconfig.server.json",
    "build": "npm run build:server",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:int": "bash scripts/test-int.sh",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:check": "drizzle-kit check"
  }
}
```
Then install and commit the lock file:
```bash
npm install --no-audit --no-fund
npm ls --depth=0        # must print no "invalid", "missing" or "UNMET"
```
**Impact:** creates `node_modules/` (ignored) and `package-lock.json` (committed). Later phases
run `npm ci` and must not add dependencies (Invariant 8).

### Step 4: TypeScript configs
**File:** `tsconfig.json` (new)
**Change:** strict NodeNext ESM. Relative imports in `src/` and `tests/` use the `.js` extension
(`import { notes } from './schema.js'`). `lib` has no DOM: server code must not lean on browser
globals. Phase 7 adds a separate `tsconfig.web.json` for `web/` (DOM, `jsx`), and `web` is
excluded here so the two never overlap.
**Code:**
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "drizzle.config.ts"],
  "exclude": ["node_modules", "dist", "web", "drizzle"]
}
```

**File:** `tsconfig.server.json` (new)
**Change:** the build config; `rootDir: src` makes `src/main.ts` emit to `dist/main.js`.
**Code:**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "web", "drizzle", "src/**/*.test.ts"]
}
```
**Impact:** `npm run typecheck` = `tsc -p tsconfig.json`; `npm run build:server` = `tsc -p tsconfig.server.json`.

### Step 5: `vitest.config.ts`
**File:** `vitest.config.ts` (new)
**Change:** one config, two modes. Unit mode includes `tests/unit/**/*.test.ts` and
`web/src/**/*.test.tsx` (jsdom per file via the `// @vitest-environment jsdom` pragma; JSX is
transformed by Vite 8 without `@vitejs/plugin-react`, verified). Integration mode
(`VITEST_INTEGRATION=1`, set by `scripts/test-int.sh`) includes only
`tests/integration/**/*.int.test.ts`, runs `globalSetup` (migrate) and runs files one at a time
because they share and truncate one database. Integration test files MUST be named
`*.int.test.ts`.
**Code:**
```ts
import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1 and
 *   TEST_DATABASE_URL, which switches the run to `tests/integration/**` only, against
 *   the Docker Postgres `mcp-notes-pg-test`. Integration files run one at a time
 *   because they share one database and truncate it.
 *
 * Do not add a second config file.
 */
const integration = process.env.VITEST_INTEGRATION === '1'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: integration
      ? ['tests/integration/**/*.int.test.ts']
      : ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: integration ? ['tests/integration/globalSetup.ts'] : [],
    fileParallelism: !integration,
    testTimeout: integration ? 30_000 : 5_000,
    hookTimeout: integration ? 60_000 : 10_000,
  },
})
```
**Impact:** `npm test` never needs a database.

### Step 6: `drizzle.config.ts`
**File:** `drizzle.config.ts` (new)
**Change:** expense-tracking's config with this repo's schema path, except that the migration
URL is chosen **by host, not by key name**: of `DATABASE_URL_UNPOOLED` and `DATABASE_URL` (that
order), the first whose host does not contain `-pooler`. It throws at load time only when
neither is set to a direct host, so even `db:generate` needs `.env.local` (present through the
worktree symlink). This works with the owner's file as it is (names swapped) and after a fix.
Self-contained on purpose: drizzle-kit loads this file with its own loader, so it does not
import `src/config.ts`.
**Code:**
```ts
import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs outside the daemon, so it loads .env.local itself (the same file
// src/config.ts reads). Migrations go to the DIRECT (unpooled) Neon host only.
loadEnv({ path: '.env.local', quiet: true })

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// Choose by host, not by key name: the owner's .env.local has the two names swapped
// (DATABASE_URL holds the direct host). Whichever of the two is direct wins.
const candidates = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL]
  .map((v) => v?.trim())
  .filter((v): v is string => !!v)
const url = candidates.find((u) => {
  const host = hostOf(u)
  return host !== null && !host.includes('-pooler')
})
if (!url) {
  throw new Error(
    'No direct (unpooled) Postgres URL in DATABASE_URL_UNPOOLED or DATABASE_URL. drizzle-kit must ' +
      'use the DIRECT Neon connection string (the host without "-pooler"); running migrations ' +
      'through the pooler is unsupported. Add it to .env.local.',
  )
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
```
**Impact:** drizzle-kit picks the `pg` driver (installed) for `migrate` / `check`.

### Step 7: `src/config.ts`
**File:** `src/config.ts` (new)
**Change:** `.env.local` is located from the module's own path (`src/config.ts` and
`dist/config.js` are both one level below the repo root), parsed with `dotenv.parse` and merged
UNDER the real environment (real env wins), without mutating `process.env`. Unknown keys are
ignored. The runtime URL is chosen by host (see `pickDatabaseUrl`): a real-env `DATABASE_URL`
wins; otherwise the pooled one of `DATABASE_URL` / `DATABASE_URL_UNPOOLED`, else whichever
exists. Host is pinned to `127.0.0.1`: `NOTESD_HOST` set to anything else throws (Invariant 3).
`NOTESD_PORT=0` is accepted (tests bind a free port; Invariant 10). `NOTES_DATA_DIR` expands
`~` and resolves to an absolute path. The data dir is NOT created here (Phase 2 / Phase 4 create
it at startup).
**Code:**
```ts
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'

/**
 * Repo root, resolved from this module's own location so the daemon finds
 * `.env.local` no matter which cwd systemd or a test runner starts it from.
 * `src/config.ts` (tsx, vitest) and `dist/config.js` (built) both sit one
 * level below the root.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_PORT = 7317
export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_DATA_DIR = '~/mcp-notes-data'

export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
}

export interface LoadConfigOptions {
  /** Environment to read. Defaults to `process.env`. Never mutated. */
  env?: NodeJS.ProcessEnv
  /**
   * Dotenv file merged under `env` (real env wins). Defaults to
   * `<REPO_ROOT>/.env.local`; `false` skips it. A missing file is not an error.
   */
  envFile?: string | false
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function readEnvFile(file: string | false): Record<string, string> {
  if (file === false || !existsSync(file)) return {}
  return parseDotenv(readFileSync(file))
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  const port = Number(trimmed)
  if (port > 65535) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  return port
}

/** True when `url` parses and its host is a Neon pooler host (`...-pooler...`). */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).host.includes('-pooler')
  } catch {
    return false
  }
}

/**
 * The runtime database URL.
 * 1. `DATABASE_URL` in the real environment (`options.env` / `process.env`) wins outright:
 *    tests and test-port runs point the daemon at the Docker Postgres this way.
 * 2. Otherwise, of `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (file merged under env), the
 *    pooled one if either is pooled, else whichever exists. The owner's `.env.local` has the two
 *    key names swapped, so the choice goes by host, never by name.
 */
function pickDatabaseUrl(
  realEnv: Record<string, string | undefined>,
  merged: Record<string, string | undefined>,
): string | undefined {
  const explicit = realEnv.DATABASE_URL?.trim()
  if (explicit) return explicit
  const candidates = [merged.DATABASE_URL, merged.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
  return candidates.find(isPooledUrl) ?? candidates[0]
}

function parseHost(raw: string | undefined): typeof LOOPBACK_HOST {
  if (raw === undefined || raw.trim() === '' || raw.trim() === LOOPBACK_HOST) return LOOPBACK_HOST
  throw new ConfigError(
    `NOTESD_HOST is "${raw}". notesd has no auth and binds ${LOOPBACK_HOST} only; ` +
      'unset NOTESD_HOST or set it to 127.0.0.1.',
  )
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Unknown keys (LLM_*, OPENROUTER_API_KEY) are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port or on a non-loopback host.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
  }
}
```
**Impact:** Phase 2's `main.ts` calls `loadConfig()` with no arguments; tests pass `env` and
`envFile: false`.

### Step 8: `src/notes/ids.ts`
**File:** `src/notes/ids.ts` (new)
**Change:** id format `[0-9A-Z]-[0-9A-Z]{3}`; `crypto.randomInt` source (injectable);
`normalizeId` is case-insensitive and tolerates a missing dash (`ab32` → `A-B32`). Note that any
4 alphanumerics normalise to an id (`nope` → `N-OPE`): callers decide whether that id exists.
Collision retry is Phase 2's (insert, catch the primary-key violation, regenerate).
**Code:**
```ts
import { randomInt } from 'node:crypto'

/** Note ids are one char, a dash, three chars, all from [0-9A-Z]: `A-B32`. */
export const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Canonical form only. Use `normalizeId` for user input. */
export const ID_PATTERN = /^[0-9A-Z]-[0-9A-Z]{3}$/

/** 36^4 = 1,679,616 distinct ids. The service retries on collision. */
export const ID_SPACE = ID_ALPHABET.length ** 4

const LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/

/**
 * A fresh random id in canonical form. `random(n)` must return an integer in [0, n);
 * it defaults to `crypto.randomInt` and is injectable for tests.
 * Uniqueness is the caller's job (insert, retry on primary-key conflict).
 */
export function generateId(random: (max: number) => number = randomInt): string {
  let raw = ''
  for (let i = 0; i < 4; i++) {
    const ch = ID_ALPHABET[random(ID_ALPHABET.length)]
    if (ch === undefined) throw new RangeError('generateId: random() returned an out-of-range index')
    raw += ch
  }
  return `${raw[0]}-${raw.slice(1)}`
}

/** True only for the canonical form (`A-B32`). */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/**
 * Case-insensitive, dash-tolerant lookup form: `ab32`, `a-b32`, ` A-B32 ` → `A-B32`.
 * Returns null for anything that cannot be an id.
 */
export function normalizeId(input: string): string | null {
  const m = LOOSE_ID.exec(input.trim().toUpperCase())
  if (!m) return null
  return `${m[1]}-${m[2]}`
}

export class InvalidIdError extends Error {
  override name = 'InvalidIdError'
  constructor(readonly input: string) {
    super(`"${input}" is not a note id. Ids look like A-B32 (the dash is optional, case does not matter).`)
  }
}

/** `normalizeId` that throws `InvalidIdError` instead of returning null. */
export function parseId(input: string): string {
  const id = normalizeId(input)
  if (id === null) throw new InvalidIdError(input)
  return id
}
```

### Step 9: `src/notes/tags.ts`
**File:** `src/notes/tags.ts` (new)
**Change:** `#[A-Za-z0-9_-]+` where the `#` is not preceded by `[A-Za-z0-9_]` (the index's
regex, fixed). Lower-cased, deduped, first-appearance order. `tagSpans` gives offsets so the web
app can render tag chips inside text with the same rule; `normalizeTag` turns a filter argument
(`#Seer`) into the stored form. No Node imports.
**Code:**
```ts
/**
 * Tags are `#hashtags` inside the note body, re-parsed on every write.
 * A tag is `#` + one or more of [A-Za-z0-9_-], where the `#` is not preceded by a
 * word character (so `C#` and `a#b` are not tags). Stored lower-cased, deduped,
 * in order of first appearance.
 *
 * This module is pure (no Node imports) so the web app can share it.
 */

const TAG_REGEX_SOURCE = '(?<![A-Za-z0-9_])#([A-Za-z0-9_-]+)'

export interface TagSpan {
  /** Index of the `#`. */
  start: number
  /** Index one past the last tag character. */
  end: number
  /** The tag lower-cased, without `#`. */
  tag: string
}

/** Every tag occurrence in `body`, in order, including repeats. */
export function tagSpans(body: string): TagSpan[] {
  const re = new RegExp(TAG_REGEX_SOURCE, 'g')
  const spans: TagSpan[] = []
  for (const m of body.matchAll(re)) {
    const name = m[1]
    if (name === undefined || m.index === undefined) continue
    spans.push({ start: m.index, end: m.index + m[0].length, tag: name.toLowerCase() })
  }
  return spans
}

/** The `tags` column value for `body`: lower-cased, deduped, first-appearance order. */
export function parseTags(body: string): string[] {
  const seen = new Set<string>()
  for (const span of tagSpans(body)) seen.add(span.tag)
  return [...seen]
}

/**
 * Normalises a tag given as a filter argument (`#Seer`, `seer`, ` SEER `) to the stored
 * form (`seer`). Returns null when nothing tag-like is left.
 */
export function normalizeTag(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, '').toLowerCase()
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null
}
```

### Step 10: `src/db/schema.ts`
**File:** `src/db/schema.ts` (new)
**Change:** both tables and every index the set needs (Invariant 7). `ImageMeta` and
`NoteOrigin` are defined here because they type the jsonb columns; Phase 2's
`src/notes/types.ts` should import or re-export them rather than redefine them.
`ImageMeta.taken_at` is a UTC ISO-8601 string so the text expression index sorts and
range-compares correctly.
**Code:**
```ts
import { sql } from 'drizzle-orm'
import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * The whole schema for iterations 1-3. Phase 1 owns it and its single migration
 * (drizzle/0000_init.sql); no later phase adds a migration.
 */

/** `notes.image_meta`. Written by the image ingest (iteration 2). */
export interface ImageMeta {
  /** Lower-case hex sha256 of the original bytes. Unique among non-deleted notes. */
  sha256: string
  /** Sniffed from magic bytes, e.g. `image/jpeg`, `image/heic`. */
  mime: string
  width: number
  height: number
  /** Size of the original file in bytes. */
  bytes: number
  /** EXIF DateTimeOriginal as a UTC ISO-8601 string (`...Z`), or null. Indexed as text. */
  taken_at: string | null
  original_name: string | null
  /** `os.hostname()` of the machine that holds the file. */
  host: string | null
}

/** `notes.origin`: where a note was saved from. */
export interface NoteOrigin {
  cwd?: string
  repo?: string
  claude_session?: string
  /** Ingestion channel, e.g. `mcp`, `web`, `inbox`, `upload`. */
  source?: string
}

export const notes = pgTable(
  'notes',
  {
    /** `A-B32`, canonical upper-case form (see src/notes/ids.ts). */
    id: text('id').primaryKey(),
    body: text('body').notNull(),
    /** Parsed from `#hashtags` in `body` on every write (see src/notes/tags.ts). */
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Relative to the data dir: `images/YYYY/MM/<id>.<ext>`. */
    imagePath: text('image_path'),
    imageMeta: jsonb('image_meta').$type<ImageMeta>(),
    origin: jsonb('origin').$type<NoteOrigin>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Soft delete. Null means live. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('notes_tags_gin').using('gin', t.tags),
    index('notes_body_fts_gin').using('gin', sql`to_tsvector('simple', ${t.body})`),
    index('notes_created_at_idx').on(t.createdAt),
    index('notes_updated_at_idx').on(t.updatedAt),
    uniqueIndex('notes_image_sha256_live_uniq')
      .on(sql`(${t.imageMeta} ->> 'sha256')`)
      .where(sql`${t.imageMeta} is not null and ${t.deletedAt} is null`),
    index('notes_image_taken_at_idx').on(sql`(${t.imageMeta} ->> 'taken_at')`),
  ],
)

export const noteRevisions = pgTable(
  'note_revisions',
  {
    /** Revision number used by the `revisions` / `revert` tools. */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** The body as it was BEFORE the change that wrote this row. */
    body: text('body').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('note_revisions_note_saved_idx').on(t.noteId, t.savedAt.desc())],
)

export type NoteRow = typeof notes.$inferSelect
export type NewNoteRow = typeof notes.$inferInsert
export type NoteRevisionRow = typeof noteRevisions.$inferSelect
export type NewNoteRevisionRow = typeof noteRevisions.$inferInsert
```

### Step 11: `src/db/client.ts`
**File:** `src/db/client.ts` (new)
**Change:** `createDb(url)` picks `drizzle-orm/neon-serverless` over the `@neondatabase/serverless`
websocket `Pool` (with `ws`) for `*.neon.tech`, and `drizzle-orm/node-postgres` otherwise. One
exported `Db` type (node-postgres flavoured, with `$client: pg.Pool`) so callers never branch on
the driver; the Neon instance is cast through `unknown` because both adapters share `PgDatabase`
and the Neon Pool is pg-compatible (`.rows`, `transaction`, `end`). No I/O at construction.
**Code:**
```ts
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import ws from 'ws'

import * as schema from './schema.js'

/**
 * One Drizzle type for both drivers. The Neon websocket Pool is wire-compatible
 * with `pg.Pool` (same query/transaction API, `.rows` results), and both drizzle
 * adapters extend the same `PgDatabase`, so callers program against node-postgres
 * types regardless of which driver `createDb` picked. Both support `db.transaction`.
 */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }

/** Postgres on a Neon host (`*.neon.tech`, pooled or direct). */
export function isNeonUrl(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase()
  return host === 'neon.tech' || host.endsWith('.neon.tech')
}

/**
 * Builds a Drizzle instance for `url`:
 * - `*.neon.tech` → `drizzle-orm/neon-serverless` over `@neondatabase/serverless`'s
 *   websocket Pool (`ws` as the WebSocket implementation). Interactive transactions work,
 *   unlike neon-http.
 * - anything else (the Docker Postgres used by `npm run test:int`) → `drizzle-orm/node-postgres`.
 *
 * No I/O happens here; the pool connects on the first query. Call `closeDb` on shutdown.
 */
export function createDb(url: string): Db {
  if (isNeonUrl(url)) {
    neonConfig.webSocketConstructor = ws
    const pool = new NeonPool({ connectionString: url })
    return drizzleNeon({ client: pool, schema }) as unknown as Db
  }
  const pool = new pg.Pool({ connectionString: url })
  return drizzleNodePg({ client: pool, schema })
}

/** Ends the underlying pool. Safe to call once per `createDb`. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end()
}

export { schema }
```
**Impact:** Phase 2 does `const db = createDb(config.databaseUrl)` and `closeDb(db)` on shutdown.

### Step 12: Generate the single migration
**File:** `drizzle/0000_init.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0000_snapshot.json` (generated)
**Change:** generate, do not hand-write (the journal's `when` and the snapshot must come from
drizzle-kit, and the migrator keys on them):
```bash
npm run db:generate -- --name init
npm run db:check
```
The generated SQL must be exactly this (prototype output):
```sql
CREATE TABLE "note_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"body" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_path" text,
	"image_meta" jsonb,
	"origin" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_revisions_note_saved_idx" ON "note_revisions" USING btree ("note_id","saved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_tags_gin" ON "notes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "notes_body_fts_gin" ON "notes" USING gin (to_tsvector('simple', "body"));--> statement-breakpoint
CREATE INDEX "notes_created_at_idx" ON "notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notes_updated_at_idx" ON "notes" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_image_sha256_live_uniq" ON "notes" USING btree (("image_meta" ->> 'sha256')) WHERE "notes"."image_meta" is not null and "notes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_image_taken_at_idx" ON "notes" USING btree (("image_meta" ->> 'taken_at'));
```
**Impact:** this is the only migration in the plan set. Do not regenerate it after Step 16 has
applied it to Neon (see Rollback).

### Step 13: Unit tests
**File:** `tests/unit/ids.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import {
  generateId,
  ID_ALPHABET,
  ID_PATTERN,
  ID_SPACE,
  InvalidIdError,
  isValidId,
  normalizeId,
  parseId,
} from '../../src/notes/ids.js'

describe('generateId', () => {
  it('produces the canonical X-XXX form', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateId()).toMatch(ID_PATTERN)
    }
  })

  it('uses the injected random source', () => {
    const picks = [10, 11, 3, 2] // A, B, 3, 2
    let i = 0
    expect(generateId(() => picks[i++]!)).toBe('A-B32')
  })

  it('covers the whole alphabet in every position', () => {
    expect(generateId(() => 0)).toBe('0-000')
    expect(generateId(() => ID_ALPHABET.length - 1)).toBe('Z-ZZZ')
  })

  it('throws on an out-of-range random source', () => {
    expect(() => generateId(() => 36)).toThrow(RangeError)
  })

  it('reports the id space', () => {
    expect(ID_SPACE).toBe(1_679_616)
  })
})

describe('normalizeId', () => {
  it.each([
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    ['  a-B32\n', 'A-B32'],
    ['0-000', '0-000'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeId(input)).toBe(expected)
  })

  it.each(['', 'A-B3', 'A-B321', 'AB-32', 'A--B32', 'A_B32', 'Ä-B32', 'A B32', '#A-B32'])(
    'rejects %j',
    (input) => {
      expect(normalizeId(input)).toBeNull()
    },
  )
})

describe('isValidId', () => {
  it('accepts only the canonical form', () => {
    expect(isValidId('A-B32')).toBe(true)
    expect(isValidId('a-b32')).toBe(false)
    expect(isValidId('AB32')).toBe(false)
  })
})

describe('parseId', () => {
  it('returns the canonical id', () => {
    expect(parseId('ab32')).toBe('A-B32')
  })

  it('throws InvalidIdError with the input attached', () => {
    try {
      parseId('not-an-id')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIdError)
      expect((err as InvalidIdError).input).toBe('not-an-id')
    }
  })
})
```

**File:** `tests/unit/tags.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import { normalizeTag, parseTags, tagSpans } from '../../src/notes/tags.js'

describe('parseTags', () => {
  it('finds the brief examples', () => {
    expect(parseTags('#v250 #from_phone #ai_image #seer')).toEqual(['v250', 'from_phone', 'ai_image', 'seer'])
  })

  it('lower-cases, dedupes, keeps first-appearance order', () => {
    expect(parseTags('#Seer then #v250 and #SEER again, #seer')).toEqual(['seer', 'v250'])
  })

  it('accepts hyphens and digits', () => {
    expect(parseTags('#mcp-notes #2026')).toEqual(['mcp-notes', '2026'])
  })

  it('stops at punctuation', () => {
    expect(parseTags('see #seer. and (#v250), #agentic!')).toEqual(['seer', 'v250', 'agentic'])
  })

  it('ignores a # inside a word', () => {
    expect(parseTags('C# and a#b and x_#y and 9#z')).toEqual([])
  })

  it('accepts a tag at the very start and after newlines or brackets', () => {
    expect(parseTags('#first\n#second\t(#third) [#fourth]')).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('ignores a bare # and markdown headings', () => {
    expect(parseTags('# Heading\n## Sub\n#')).toEqual([])
  })

  it('returns [] for an empty body', () => {
    expect(parseTags('')).toEqual([])
  })
})

describe('tagSpans', () => {
  it('reports every occurrence with offsets', () => {
    const body = 'x #Seer y #seer'
    expect(tagSpans(body)).toEqual([
      { start: 2, end: 7, tag: 'seer' },
      { start: 10, end: 15, tag: 'seer' },
    ])
    expect(body.slice(2, 7)).toBe('#Seer')
  })
})

describe('normalizeTag', () => {
  it.each([
    ['#Seer', 'seer'],
    ['seer', 'seer'],
    ['  V250 ', 'v250'],
    ['from_phone', 'from_phone'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeTag(input)).toBe(expected)
  })

  it.each(['', '#', 'two words', 'a.b'])('rejects %j', (input) => {
    expect(normalizeTag(input)).toBeNull()
  })
})
```

**File:** `tests/unit/config.test.ts` (new)
**Code:**
```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError, DEFAULT_PORT, loadConfig, REPO_ROOT } from '../../src/config.js'

const URL_A = 'postgres://u:p@127.0.0.1:5432/a'

describe('loadConfig', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function envFile(contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-config-'))
    tmpDirs.push(dir)
    const file = path.join(dir, '.env.local')
    writeFileSync(file, contents)
    return file
  }

  it('resolves REPO_ROOT to the directory holding package.json', () => {
    expect(existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true)
  })

  it('applies defaults', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false })
    expect(cfg).toEqual({
      databaseUrl: URL_A,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      dataDir: path.join(homedir(), 'mcp-notes-data'),
    })
  })

  it('reads the env file and lets the real environment win', () => {
    const file = envFile(
      ['LLM_API_KEY=ignored', 'DATABASE_URL=postgres://file/db', 'NOTESD_PORT=7400', 'OPENROUTER_API_KEY=x'].join('\n'),
    )
    expect(loadConfig({ env: {}, envFile: file })).toMatchObject({ databaseUrl: 'postgres://file/db', port: 7400 })
    expect(loadConfig({ env: { NOTESD_PORT: '7401' }, envFile: file }).port).toBe(7401)
  })

  it('prefers the pooled host of the two file URLs, whatever their key names', () => {
    const pooled = 'postgresql://u:p@ep-x-pooler.c-2.aws.neon.tech/db'
    const direct = 'postgresql://u:p@ep-x.c-2.aws.neon.tech/db'
    // the owner's file today: names swapped
    expect(
      loadConfig({ env: {}, envFile: envFile(`DATABASE_URL=${direct}\nDATABASE_URL_UNPOOLED=${pooled}\n`) }).databaseUrl,
    ).toBe(pooled)
    // a corrected file
    expect(
      loadConfig({ env: {}, envFile: envFile(`DATABASE_URL=${pooled}\nDATABASE_URL_UNPOOLED=${direct}\n`) }).databaseUrl,
    ).toBe(pooled)
    // only one key present
    expect(loadConfig({ env: {}, envFile: envFile(`DATABASE_URL_UNPOOLED=${direct}\n`) }).databaseUrl).toBe(direct)
  })

  it('lets a real-env DATABASE_URL override both file URLs', () => {
    const file = envFile('DATABASE_URL=postgresql://u:p@ep-x.neon.tech/db\nDATABASE_URL_UNPOOLED=postgresql://u:p@ep-x-pooler.neon.tech/db\n')
    expect(loadConfig({ env: { DATABASE_URL: URL_A }, envFile: file }).databaseUrl).toBe(URL_A)
  })

  it('treats a missing env file as empty', () => {
    expect(() => loadConfig({ env: {}, envFile: '/nonexistent/.env.local' })).toThrow(ConfigError)
  })

  it('throws when DATABASE_URL is missing or blank', () => {
    expect(() => loadConfig({ env: {}, envFile: false })).toThrow(/DATABASE_URL is not set/)
    expect(() => loadConfig({ env: { DATABASE_URL: '  ' }, envFile: false })).toThrow(ConfigError)
  })

  it('parses NOTESD_PORT, including 0 for tests', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: '0' }, envFile: false }).port).toBe(0)
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: ' 7399 ' }, envFile: false }).port).toBe(7399)
  })

  it.each(['abc', '-1', '65536', '7317.5'])('rejects NOTESD_PORT=%j', (port) => {
    expect(() => loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: port }, envFile: false })).toThrow(ConfigError)
  })

  it('accepts only the loopback host', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_HOST: '127.0.0.1' }, envFile: false }).host).toBe('127.0.0.1')
    for (const host of ['0.0.0.0', 'localhost', '::', '192.168.1.5']) {
      expect(() => loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_HOST: host }, envFile: false })).toThrow(
        /binds 127\.0\.0\.1 only/,
      )
    }
  })

  it('expands ~ and resolves NOTES_DATA_DIR to an absolute path', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: '~/x/y' }, envFile: false }).dataDir).toBe(
      path.join(homedir(), 'x', 'y'),
    )
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: '/tmp/notes-data' }, envFile: false }).dataDir).toBe(
      '/tmp/notes-data',
    )
    expect(path.isAbsolute(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: 'rel' }, envFile: false }).dataDir)).toBe(
      true,
    )
  })

  it('does not mutate the env it was given', () => {
    const env = { DATABASE_URL: URL_A }
    const file = envFile('NOTESD_PORT=7500\n')
    loadConfig({ env, envFile: file })
    expect(env).toEqual({ DATABASE_URL: URL_A })
  })
})
```

**File:** `tests/unit/db-client.test.ts` (new)
**Change:** proves the driver switch without connecting anywhere (both pools are lazy).
**Code:**
```ts
import { Pool as NeonPool } from '@neondatabase/serverless'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { closeDb, createDb, isNeonUrl } from '../../src/db/client.js'

describe('isNeonUrl', () => {
  it.each([
    ['postgresql://u:p@ep-x-123.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require', true],
    ['postgresql://u:p@ep-x-123-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb', true],
    ['postgres://postgres:pw@127.0.0.1:55433/mcp_notes_test', false],
    ['postgres://u:p@localhost/db', false],
    ['postgres://u:p@neon.tech.evil.example/db', false],
  ])('%s -> %s', (url, expected) => {
    expect(isNeonUrl(url)).toBe(expected)
  })
})

describe('createDb', () => {
  it('uses node-postgres for a non-Neon url, without connecting', async () => {
    const db = createDb('postgres://postgres:pw@127.0.0.1:1/none')
    expect(db.$client).toBeInstanceOf(pg.Pool)
    await closeDb(db)
  })

  it('uses the Neon websocket Pool for a Neon url, without connecting', async () => {
    const db = createDb('postgresql://u:p@ep-x-123.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require')
    expect(db.$client).toBeInstanceOf(NeonPool)
    await closeDb(db)
  })
})
```

### Step 14: Integration harness
**File:** `scripts/test-int.sh` (new, `chmod +x`)
**Change:** starts or reuses `mcp-notes-pg-test` (`postgres:16`, published on `127.0.0.1:55433`
only), waits on `pg_isready` over TCP, exports `TEST_DATABASE_URL` and `VITEST_INTEGRATION=1`,
then execs the local vitest binary (not `npx`, which warns under npm 12). Extra args pass through
(`npm run test:int -- tests/integration/notes.service.int.test.ts`). It never touches `seer-pg`
(55432) or Neon.
**Code:**
```bash
#!/usr/bin/env bash
# Integration tests against a real Postgres in Docker.
#
# Starts (or reuses) the container mcp-notes-pg-test (postgres:16, 127.0.0.1:55433),
# waits for it, then runs the integration suite with TEST_DATABASE_URL pointing at it.
# The suite's globalSetup applies drizzle/*.sql. Extra args go to vitest.
#
# Never touches the Neon database or any other container (seer-pg uses 55432).
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=mcp-notes-pg-test
IMAGE=postgres:16
HOST_PORT=55433
PG_PASSWORD=mcpnotes
PG_DB=mcp_notes_test

if ! command -v docker >/dev/null 2>&1; then
  echo "test-int: docker is not on PATH; integration tests need it." >&2
  exit 1
fi

# docker inspect prints a blank line on stdout for an unknown container, so the
# exit status decides "missing", not the output.
if ! state="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)"; then
  state=missing
fi
case "$state" in
  true)
    ;;
  false)
    echo "test-int: starting existing container $CONTAINER"
    docker start "$CONTAINER" >/dev/null
    ;;
  missing)
    echo "test-int: creating container $CONTAINER ($IMAGE on 127.0.0.1:$HOST_PORT)"
    docker run -d \
      --name "$CONTAINER" \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" \
      -e POSTGRES_DB="$PG_DB" \
      -p "127.0.0.1:$HOST_PORT:5432" \
      "$IMAGE" >/dev/null
    ;;
  *)
    echo "test-int: unexpected state '$state' for $CONTAINER" >&2
    exit 1
    ;;
esac

# -h 127.0.0.1 skips the entrypoint's socket-only bootstrap server, so "ready"
# means the real server is accepting TCP connections.
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres -d "$PG_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready:-0}" != 1 ]; then
  echo "test-int: $CONTAINER did not become ready in 60s" >&2
  docker logs --tail 30 "$CONTAINER" >&2 || true
  exit 1
fi

export TEST_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/${PG_DB}"
export VITEST_INTEGRATION=1
exec node_modules/.bin/vitest run "$@"
```

**File:** `tests/integration/setup.ts` (new)
**Change:** the only place integration tests get a DB. Refuses a Neon `TEST_DATABASE_URL`
(Invariant 9). Later phases' integration files import `openTestDb`, `closeTestDb` and
`truncateAll` from here.
**Code:**
```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { closeDb, createDb, isNeonUrl, type Db } from '../../src/db/client.js'

/**
 * Integration-test helpers. Every integration file imports from here; nothing in
 * tests/integration opens its own connection.
 *
 * TEST_DATABASE_URL is set by scripts/test-int.sh to the Docker container
 * mcp-notes-pg-test (127.0.0.1:55433). It must never be the Neon database.
 */

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Run integration tests with `npm run test:int`.')
  }
  if (isNeonUrl(url)) {
    throw new Error('TEST_DATABASE_URL points at Neon. Integration tests truncate tables; use the Docker Postgres.')
  }
  return url
}

/** A Drizzle instance on the test database. Close it with `closeTestDb` in `afterAll`. */
export function openTestDb(): Db {
  return createDb(testDatabaseUrl())
}

export async function closeTestDb(db: Db): Promise<void> {
  await closeDb(db)
}

/** Applies drizzle/*.sql (idempotent: already-applied migrations are skipped). */
export async function migrateTestDb(): Promise<void> {
  const db = openTestDb()
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await closeDb(db)
  }
}

/** Empties every app table. Call in `beforeEach` of any file that writes. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table note_revisions, notes restart identity cascade`)
}
```

**File:** `tests/integration/globalSetup.ts` (new)
**Code:**
```ts
import { migrateTestDb } from './setup.js'

/** Vitest globalSetup for the integration run: migrate the Docker test DB once. */
export default async function setup(): Promise<void> {
  await migrateTestDb()
}
```

**File:** `tests/integration/schema.int.test.ts` (new)
**Change:** schema smoke test: every index exists, defaults, jsonb round-trip, revision FK and
ordering, the live-only sha256 uniqueness, `simple` full-text matching, the tag array operators,
and that a transaction rolls a body change and its revision back together (what Invariant 5
needs from the driver). Drizzle wraps pg errors, so `pgErrorCode` walks `.cause`.
**Code:**
```ts
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteRevisions, notes, type ImageMeta } from '../../src/db/schema.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

function imageMeta(sha256: string, takenAt: string | null = null): ImageMeta {
  return {
    sha256,
    mime: 'image/jpeg',
    width: 10,
    height: 10,
    bytes: 100,
    taken_at: takenAt,
    original_name: 'x.jpg',
    host: 'test-host',
  }
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

describe('schema (migration 0000)', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates every index the plan set relies on', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    )
    const names = res.rows.map((r) => r.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        'notes_pkey',
        'notes_tags_gin',
        'notes_body_fts_gin',
        'notes_created_at_idx',
        'notes_updated_at_idx',
        'notes_image_sha256_live_uniq',
        'notes_image_taken_at_idx',
        'note_revisions_pkey',
        'note_revisions_note_saved_idx',
      ]),
    )
  })

  it('applies column defaults', async () => {
    const [row] = await db.insert(notes).values({ id: 'A-B32', body: 'hello' }).returning()
    expect(row).toBeDefined()
    expect(row?.tags).toEqual([])
    expect(row?.imagePath).toBeNull()
    expect(row?.imageMeta).toBeNull()
    expect(row?.origin).toBeNull()
    expect(row?.deletedAt).toBeNull()
    expect(row?.createdAt).toBeInstanceOf(Date)
    expect(row?.updatedAt).toBeInstanceOf(Date)
  })

  it('round-trips tags, origin and image_meta', async () => {
    await db.insert(notes).values({
      id: 'C-D45',
      body: '#seer #from_phone',
      tags: ['seer', 'from_phone'],
      origin: { cwd: '/home/x', repo: 'seer', source: 'mcp' },
      imagePath: 'images/2026/10/C-D45.jpg',
      imageMeta: imageMeta('abc', '2026-10-30T01:02:03.000Z'),
    })
    const [row] = await db.select().from(notes).where(eq(notes.id, 'C-D45'))
    expect(row?.tags).toEqual(['seer', 'from_phone'])
    expect(row?.origin).toEqual({ cwd: '/home/x', repo: 'seer', source: 'mcp' })
    expect(row?.imageMeta?.taken_at).toBe('2026-10-30T01:02:03.000Z')
  })

  it('stores revisions with an increasing id, linked to the note', async () => {
    await db.insert(notes).values({ id: 'E-F67', body: 'v3' })
    await db.insert(noteRevisions).values([
      { noteId: 'E-F67', body: 'v1' },
      { noteId: 'E-F67', body: 'v2' },
    ])
    const revs = await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, 'E-F67'))
    expect(revs.map((r) => r.body)).toEqual(['v1', 'v2'])
    expect(revs[1]!.id).toBeGreaterThan(revs[0]!.id)
  })

  it('rejects a revision for a missing note', async () => {
    const err = await db
      .insert(noteRevisions)
      .values({ noteId: 'Z-ZZZ', body: 'x' })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(err)).toBe('23503')
  })

  it('keeps sha256 unique among live notes only', async () => {
    await db.insert(notes).values({ id: 'G-H89', body: '', imageMeta: imageMeta('same') })
    const dup = await db
      .insert(notes)
      .values({ id: 'J-K01', body: '', imageMeta: imageMeta('same') })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dup)).toBe('23505')

    await db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, 'G-H89'))
    await db.insert(notes).values({ id: 'J-K01', body: '', imageMeta: imageMeta('same') })
    const live = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from notes where image_meta->>'sha256' = 'same' and deleted_at is null`,
    )
    expect(live.rows[0]?.n).toBe(1)
  })

  it('full-text matches code tokens with the simple config', async () => {
    await db.insert(notes).values([
      { id: 'L-M23', body: 'running createDb in src/db/client.ts' },
      { id: 'N-P45', body: 'nothing relevant' },
    ])
    const res = await db.execute<{ id: string }>(
      sql`select id from notes where to_tsvector('simple', body) @@ websearch_to_tsquery('simple', 'running') order by id`,
    )
    expect(res.rows.map((r) => r.id)).toEqual(['L-M23'])
  })

  it('filters tags with the array operators the GIN index serves', async () => {
    await db.insert(notes).values([
      { id: 'Q-R67', body: '', tags: ['seer', 'v250'] },
      { id: 'S-T89', body: '', tags: ['seer'] },
    ])
    const all = await db.select({ id: notes.id }).from(notes).where(sql`${notes.tags} @> array['seer','v250']::text[]`)
    const any = await db.select({ id: notes.id }).from(notes).where(sql`${notes.tags} && array['v250']::text[]`)
    expect(all.map((r) => r.id)).toEqual(['Q-R67'])
    expect(any.map((r) => r.id)).toEqual(['Q-R67'])
  })

  it('wraps a body change and its revision in one transaction', async () => {
    await db.insert(notes).values({ id: 'U-V01', body: 'before' })
    const failed = await db
      .transaction(async (tx) => {
        await tx.insert(noteRevisions).values({ noteId: 'U-V01', body: 'before' })
        await tx.update(notes).set({ body: 'after' }).where(eq(notes.id, 'U-V01'))
        throw new Error('abort')
      })
      .then(() => null, (e: unknown) => e)
    expect(failed).toBeInstanceOf(Error)
    const [row] = await db.select().from(notes).where(eq(notes.id, 'U-V01'))
    expect(row?.body).toBe('before')
    const revs = await db.select().from(noteRevisions)
    expect(revs).toHaveLength(0)
  })
})
```

### Step 15: Run the gates
```bash
npm run typecheck
npm run build          # emits dist/config.js, dist/db/{client,schema}.js, dist/notes/{ids,tags}.js
npm test               # 4 files, 62 tests
npm run test:int       # creates mcp-notes-pg-test on first run; 1 file, 9 tests
npm run test:int       # second run reuses the container; still green
```
`rm -rf dist` afterwards is fine (ignored either way).

### Step 16: Apply the migration to Neon and record it (exit step)
Only after Step 15 is green and the migration files are final.
```bash
npm run db:migrate
```
Then record what Neon has (prints names only, never the URL):
```bash
node --input-type=module -e "
import { parse } from 'dotenv'; import { readFileSync } from 'node:fs'; import pg from 'pg';
const env = parse(readFileSync('.env.local'));
const url = [env.DATABASE_URL_UNPOOLED, env.DATABASE_URL].find(u => u && !new URL(u).host.includes('-pooler'));
const c = new pg.Client({ connectionString: url }); await c.connect();
const t = await c.query(\"select table_schema||'.'||table_name as t from information_schema.tables where table_schema in ('public','drizzle') order by 1\");
const i = await c.query(\"select indexname from pg_indexes where schemaname='public' order by 1\");
const m = await c.query('select hash, created_at from drizzle.__drizzle_migrations');
console.log('tables:', t.rows.map(r=>r.t).join(', '));
console.log('indexes:', i.rows.map(r=>r.indexname).join(', '));
console.log('migrations:', m.rowCount);
await c.end();" 2>/dev/null
```
Expected:
```
tables: drizzle.__drizzle_migrations, public.note_revisions, public.notes
indexes: note_revisions_note_saved_idx, note_revisions_pkey, notes_body_fts_gin, notes_created_at_idx, notes_image_sha256_live_uniq, notes_image_taken_at_idx, notes_pkey, notes_tags_gin, notes_updated_at_idx
migrations: 1
```
Paste this output into the phase's commit message body (under a `Neon:` heading) and the phase
completion notes. Before migrating, Neon was verified empty (no tables in any user schema).

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` and `npm run test:int`
**Manual check:** `docker ps --filter name=mcp-notes-pg-test` shows the container on `127.0.0.1:55433->5432`; `seer-pg` untouched. The Step 16 output matches.
**Exit criteria:** `npm run typecheck`, `npm run build`, `npm test` (62 tests) and `npm run test:int` (9 tests) green; `npm ls --depth=0` clean; `package-lock.json` committed; Neon has `notes`, `note_revisions`, all nine public indexes and one row in `drizzle.__drizzle_migrations`.

## Handoffs

- **Phase 2:** creates the data dir layout (`images/`, `cache/`, `inbox/`, `inbox/failed/`) at startup; `loadConfig` only resolves the path. Collision-retried ids: insert with `generateId()`, catch Postgres `23505` on `notes_pkey` (walk `.cause`, as `pgErrorCode` in `schema.int.test.ts` does), retry. Lookups go through `normalizeId`; filters through `normalizeTag`; every write sets `tags = parseTags(body)`. `src/notes/types.ts` should reuse `ImageMeta` / `NoteOrigin` from `src/db/schema.ts`. `restore` of a soft-deleted image note can hit `notes_image_sha256_live_uniq` (`23505`) when a live duplicate exists; Phase 2 decides the error to return. Integration tests use `openTestDb` / `truncateAll` from `tests/integration/setup.ts` and are named `*.int.test.ts`.
- **Phase 3:** `scripts/install.sh` must run plain `npm ci` (not `--omit=dev`, and not with `NODE_ENV=production` in its environment): `typescript`, `vite` and the web packages are devDependencies the build needs. The systemd unit runs `node dist/main.js`; config finds `.env.local` from the module path, so no `WorkingDirectory` dependency.
- **Phase 4:** write `image_meta.taken_at` as a UTC ISO string ending in `Z` (or null) and `sha256` as lower-case hex; the dedupe lookup must use the indexed expression `image_meta->>'sha256'` with `deleted_at is null`.
- **Phase 5:** taken-date filters compare `(image_meta->>'taken_at')` as text against UTC ISO strings so `notes_image_taken_at_idx` applies.
- **Phase 7:** owns `tsconfig.web.json`, the `build` / `dev:web` / `typecheck` script changes (the current `typecheck` covers only `tsconfig.json`; add `&& tsc -p tsconfig.web.json`). Web tests go in `web/src/**/*.test.tsx` with the jsdom pragma; no vitest config change is needed. Fonts: `@fontsource-variable/host-grotesk` and `@fontsource/geist-mono`. `src/notes/tags.ts` is importable from the web app for tag chips.
- **Not done here, deliberately:** a `README`, lint/format tooling (not requested), a `dataPaths()` helper (Phase 2/4 own the data layout).

## Risks

- `channel_binding=require` and `sslmode=require` in the Neon URLs: `pg` 8.23 connects (verified, read-only) and prints a deprecation warning about `sslmode` semantics. Harmless.
- Tags like `#123` (issue refs) and `#121211` (hex colours) are tags under the fixed regex. That is the index's decision, not re-decided here.
- If the schema must change after Step 16, Neon must be reset per Rollback before re-applying, or a second migration is needed, which Invariant 7 forbids without a reconciler decision.

## Rollback

- Code: `git revert` the phase commit (or reset the branch); `rm -rf node_modules dist`.
- Test container: `docker rm -f mcp-notes-pg-test`.
- Neon (this project's own empty DB): `DROP TABLE note_revisions, notes; DROP SCHEMA drizzle CASCADE;`.
- `.env.local`: never edited by this phase; nothing to roll back.
