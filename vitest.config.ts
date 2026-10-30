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
