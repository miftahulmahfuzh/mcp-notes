import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1, TEST_DATABASE_URL and
 *   TEST_CONNECTORS_URL, which switches the run to `tests/integration/**` only, against the
 *   Docker Postgres `mcp-notes-pg-test` (notes, pgvector image) and `mcp-notes-pg-connectors`
 *   (the three connector schemas, rebuilt from the sibling repos' migrations by
 *   tests/integration/connectors/globalSetup.ts). Integration files run one at a time because
 *   they share databases and truncate them. Embeddings there come from the deterministic fake
 *   embedder; no network.
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/chat.live.test.ts` only: real Claude and real GLM calls through the Agent
 *   SDK, on the notes Docker Postgres. Opt-in, slow and billed.
 * - `npm run test:live:connectors` sets CONNECTORS_LIVE_TEST=1 (no Docker), which runs only
 *   `tests/live/connectors.live.test.ts`: each <system>_schema tool against the real databases,
 *   read-only. Opt-in.
 * - `npm run test:live:embeddings` sets EMBEDDINGS_LIVE_TEST=1 (no Docker, no database), which
 *   runs only `tests/live/embeddings.live.test.ts`: one real, billed OpenRouter embeddings call
 *   (OPENROUTER_API_KEY from .env.local) over the labelled search set. Opt-in.
 * None of the live files is ever part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const chatLive = process.env.CHAT_LIVE_TEST === '1'
const connectorsLive = process.env.CONNECTORS_LIVE_TEST === '1'
const embeddingsLive = process.env.EMBEDDINGS_LIVE_TEST === '1'
const integration =
  !connectorsLive && !embeddingsLive && (chatLive || process.env.VITEST_INTEGRATION === '1')

function includeFor(): string[] {
  if (embeddingsLive) return ['tests/live/embeddings.live.test.ts']
  if (connectorsLive) return ['tests/live/connectors.live.test.ts']
  if (chatLive) return ['tests/live/chat.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

function globalSetupFor(): string[] {
  if (embeddingsLive || connectorsLive) return []
  if (chatLive) return ['tests/integration/globalSetup.ts']
  if (integration) return ['tests/integration/globalSetup.ts', 'tests/integration/connectors/globalSetup.ts']
  return []
}

function testTimeoutFor(): number {
  if (chatLive) return 300_000
  if (connectorsLive || embeddingsLive) return 60_000
  if (integration) return 30_000
  return 5_000
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: globalSetupFor(),
    fileParallelism: !integration,
    testTimeout: testTimeoutFor(),
    hookTimeout: chatLive || connectorsLive || embeddingsLive || integration ? 60_000 : 10_000,
  },
})
