import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { closeDb, createDb, type Db } from '../db/client.js';
import { errorMessage } from '../embeddings/backfill.js';
import { dbImageEmbeddingStore, runImageBackfill } from '../embeddings/imageBackfill.js';
import {
  IMAGE_EMBEDDING_MODEL,
  IMAGE_PRICE_USD_PER_M_TOKENS,
  estimateImageCostUsd,
  estimateImageTokens,
} from '../embeddings/imageConstants.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import { imageEmbeddingStats, listPendingImages } from '../embeddings/imageRepo.js';
import { createOpenRouterImageEmbedder } from '../embeddings/openrouterImage.js';

const NAME = 'embed:images:backfill';

/** Most pending rows a dry run reads. */
export const DRY_RUN_MAX_ROWS = 100_000;

const USAGE = [
  'usage: npm run embed:images:backfill -- [--dry-run] [--limit N] [--retry-failed]',
  `  Embeds every note image whose vector is missing, stale (model changed) or failed and due, with ${IMAGE_EMBEDDING_MODEL}.`,
  '  Images whose file is on another machine are skipped (that machine embeds them). Safe to stop',
  '  (Ctrl-C) and run again. Never runs by itself; notesd embeds new images in the background.',
  '  --dry-run       count what would be sent and estimate image tokens and cost; no network, no writes',
  '  --limit N       send at most N images this run',
  '  --retry-failed  also retry failed images now, without waiting for their backoff',
].join('\n');

/** Everything the command touches, injectable for tests. */
export interface EmbedImagesBackfillIo {
  loadConfig: () => Config;
  createDb: (url: string) => Db;
  closeDb: (db: Db) => Promise<void>;
  createEmbedder: (apiKey: string) => ImageEmbedder;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Aborted on Ctrl-C by main(). */
  signal?: AbortSignal;
  /** Overrides DEFAULT_MIN_INTERVAL_MS (tests pass 0). */
  minIntervalMs?: number;
}

export function defaultIo(signal: AbortSignal): EmbedImagesBackfillIo {
  return {
    loadConfig: () => loadConfig(),
    createDb,
    closeDb,
    createEmbedder: (apiKey) => createOpenRouterImageEmbedder({ apiKey }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    signal,
  };
}

type Parsed = { ok: true; dryRun: boolean; retryFailed: boolean; limit: number | null } | { ok: false; code: number };

function parseArgs(args: readonly string[], io: EmbedImagesBackfillIo): Parsed {
  let dryRun = false;
  let retryFailed = false;
  let limit: number | null = null;
  const bad = (message: string): Parsed => {
    io.err(`${NAME}: ${message}`);
    io.err(USAGE);
    return { ok: false, code: 2 };
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--retry-failed') {
      retryFailed = true;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg === '--limit' ? args[(i += 1)] : arg.slice('--limit='.length);
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) return bad(`--limit needs a whole number >= 1, got ${raw ?? 'nothing'}`);
      limit = n;
    } else if (arg === '--help' || arg === '-h') {
      io.out(USAGE);
      return { ok: false, code: 0 };
    } else {
      return bad(`unknown argument ${arg}`);
    }
  }
  return { ok: true, dryRun, retryFailed, limit };
}

/** Returns the process exit code. */
export async function embedImagesBackfill(args: readonly string[], io: EmbedImagesBackfillIo): Promise<number> {
  const parsed = parseArgs(args, io);
  if (!parsed.ok) return parsed.code;
  const { dryRun, retryFailed, limit } = parsed;

  let config: Config;
  try {
    config = io.loadConfig();
  } catch (err) {
    io.err(`${NAME}: ${errorMessage(err)}`);
    return 1;
  }
  const apiKey = config.embeddings.apiKey;
  if (!dryRun && !apiKey) {
    io.err(`${NAME}: OPENROUTER_API_KEY is not set. Put it in .env.local (or export it) and run again.`);
    return 1;
  }

  // Before createDb, as in embed:backfill: a bad key throws with no pool to leak. A dry run never builds one.
  const embedder = dryRun || !apiKey ? null : io.createEmbedder(apiKey);
  const model = embedder?.model ?? IMAGE_EMBEDDING_MODEL;
  const db = io.createDb(config.databaseUrl);
  try {
    const store = dbImageEmbeddingStore(db, config.dataDir);
    const before = await imageEmbeddingStats(db, model);
    io.out(
      `${NAME}: ${model}; ${before.images} images, ${before.current} current, ` +
        `${before.pending} pending (${before.failing} failing)`,
    );

    if (embedder === null) {
      const pending = await listPendingImages(db, { model, limit: DRY_RUN_MAX_ROWS, ignoreBackoff: retryFailed });
      let here = 0;
      let elsewhere = 0;
      let wouldSend = 0;
      let tokens = 0;
      for (const image of pending) {
        if (await store.isAvailable(image)) {
          here += 1;
          if (limit === null || wouldSend < limit) {
            wouldSend += 1;
            tokens += estimateImageTokens(image.width, image.height);
          }
        } else {
          elsewhere += 1;
        }
      }
      io.out(`dry run: ${pending.length} due now, ${here} on this machine, ${elsewhere} on another machine (skipped here)`);
      io.out(
        `would send ${wouldSend} image(s): about ${tokens} image tokens, about $${estimateImageCostUsd(tokens).toFixed(4)} ` +
          `at $${IMAGE_PRICE_USD_PER_M_TOKENS} per million image tokens (estimate)`,
      );
      io.out('dry run: nothing was sent and nothing was written');
      return 0;
    }

    const total = before.pending;
    const seen = { embedded: 0, failed: 0 };
    const result = await runImageBackfill({
      store,
      embedder,
      ignoreBackoff: retryFailed,
      signal: io.signal,
      ...(limit !== null ? { maxImages: limit } : {}),
      ...(io.minIntervalMs !== undefined ? { minIntervalMs: io.minIntervalMs } : {}),
      onImage: (r) => {
        if (r.outcome === 'failed') {
          seen.failed += 1;
          io.err(`failed ${r.imageId}: ${r.error ?? ''}`);
        } else if (r.outcome === 'embedded') {
          seen.embedded += 1;
        } else {
          return;
        }
        io.out(`embedded ${seen.embedded}/${Math.max(total, seen.embedded + seen.failed)}, failed ${seen.failed}`);
      },
    });
    const after = await imageEmbeddingStats(db, model);
    if (result.aborted) {
      io.out(
        `stopped: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} still pending, run again to resume`,
      );
      return 130;
    }
    if (result.calls === 0 && result.failed === 0) io.out('nothing to embed on this machine');
    io.out(
      `done: embedded ${result.embedded}, failed ${result.failed}, ${result.unavailable} not on this machine; ${after.pending} pending`,
    );
    if (result.limited) io.out(`stopped at --limit ${limit}; run again for the rest`);
    if (!retryFailed && after.failing > 0) {
      io.out(`${after.failing} failed image(s) wait for their retry backoff; run with -- --retry-failed to try them now`);
    }
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    io.err(`${NAME}: ${errorMessage(err)}`);
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
    console.error(`${NAME}: stopping after the current image (Ctrl-C again to quit now)`);
    controller.abort();
  });
  process.exitCode = await embedImagesBackfill(process.argv.slice(2), defaultIo(controller.signal));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(`${NAME}: failed`, err);
    process.exitCode = 1;
  });
}
