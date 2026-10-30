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
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/**` only: real Claude and real GLM calls through the Agent SDK, on the
 *   same Docker Postgres. Opt-in, slow and billed; never part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const live = process.env.CHAT_LIVE_TEST === '1'
const integration = live || process.env.VITEST_INTEGRATION === '1'

function includeFor(): string[] {
  if (live) return ['tests/live/**/*.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: integration ? ['tests/integration/globalSetup.ts'] : [],
    fileParallelism: !integration,
    testTimeout: live ? 300_000 : integration ? 30_000 : 5_000,
    hookTimeout: live ? 60_000 : integration ? 60_000 : 10_000,
  },
})
