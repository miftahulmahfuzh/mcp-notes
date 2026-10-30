import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { closeDb, createDb, type Db } from '../db/client.js';
import { dbEmbeddingStore, errorMessage, runBackfill } from '../embeddings/backfill.js';
import type { Embedder } from '../embeddings/embedder.js';
import { createOpenRouterEmbedder } from '../embeddings/openrouter.js';
import { embeddingStats } from '../embeddings/repo.js';

const USAGE = [
  'usage: npm run embed:backfill [-- --retry-failed]',
  '  Embeds every note whose vector is missing, stale (body or model changed) or failed and due.',
  '  Safe to stop (Ctrl-C) and run again: finished notes are not embedded twice.',
  '  --retry-failed  also retry failed notes now, without waiting for their backoff',
].join('\n');

/** Everything the command touches, injectable for tests. */
export interface EmbedBackfillIo {
  loadConfig: () => Config;
  createDb: (url: string) => Db;
  closeDb: (db: Db) => Promise<void>;
  createEmbedder: (apiKey: string) => Embedder;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Aborted on Ctrl-C by main(). */
  signal?: AbortSignal;
  /** Overrides DEFAULT_MIN_INTERVAL_MS (tests pass 0). */
  minIntervalMs?: number;
}

export function defaultIo(signal: AbortSignal): EmbedBackfillIo {
  return {
    loadConfig: () => loadConfig(),
    createDb,
    closeDb,
    createEmbedder: (apiKey) => createOpenRouterEmbedder({ apiKey }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    signal,
  };
}

/** Returns the process exit code. */
export async function embedBackfill(args: readonly string[], io: EmbedBackfillIo): Promise<number> {
  let retryFailed = false;
  for (const arg of args) {
    if (arg === '--retry-failed') {
      retryFailed = true;
    } else if (arg === '--help' || arg === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`embed:backfill: unknown argument ${arg}`);
      io.err(USAGE);
      return 2;
    }
  }

  let config: Config;
  try {
    config = io.loadConfig();
  } catch (err) {
    io.err(`embed:backfill: ${errorMessage(err)}`);
    return 1;
  }
  const apiKey = config.embeddings.apiKey;
  if (!apiKey) {
    io.err('embed:backfill: OPENROUTER_API_KEY is not set. Put it in .env.local (or export it) and run again.');
    return 1;
  }

  const embedder = io.createEmbedder(apiKey);
  const db = io.createDb(config.databaseUrl);
  try {
    const before = await embeddingStats(db, embedder.model);
    io.out(
      `embed:backfill: ${embedder.model}; ${before.withText} notes with text, ${before.current} current, ` +
        `${before.pending} pending (${before.failing} failing)`,
    );
    const total = before.pending;
    const result = await runBackfill({
      store: dbEmbeddingStore(db),
      embedder,
      ignoreBackoff: retryFailed,
      signal: io.signal,
      ...(io.minIntervalMs !== undefined ? { minIntervalMs: io.minIntervalMs } : {}),
      onBatch: (report) => {
        for (const f of report.failures) io.err(`failed ${f.id}: ${f.error}`);
      },
      onProgress: (p) => {
        // Notes written while the run is going raise the count past the starting total.
        io.out(`embedded ${p.embedded}/${Math.max(total, p.embedded + p.failed)}, failed ${p.failed}`);
      },
    });
    const after = await embeddingStats(db, embedder.model);
    if (result.aborted) {
      io.out(
        `stopped: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} still pending, run again to resume`,
      );
      return 130;
    }
    if (result.calls === 0) io.out('nothing to embed');
    io.out(`done: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} pending`);
    if (!retryFailed && after.failing > 0) {
      io.out(`${after.failing} failed note(s) wait for their retry backoff; run with -- --retry-failed to try them now`);
    }
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    io.err(`embed:backfill: ${errorMessage(err)}`);
    return 1;
  } finally {
    await io.closeDb(db);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error('embed:backfill: stopping after the current batch (Ctrl-C again to quit now)');
    controller.abort();
  });
  process.exitCode = await embedBackfill(process.argv.slice(2), defaultIo(controller.signal));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error('embed:backfill: failed', err);
    process.exitCode = 1;
  });
}
