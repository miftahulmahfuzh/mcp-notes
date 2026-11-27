import { startAdversary } from './adversary/start.js';
import { startEgressLine } from './db/egressStart.js';
import type { AppDeps } from './deps.js';
import { startStreamJobs } from './directStream/startJobs.js';
import { startEmbeddingWorkers } from './embeddings/start.js';
import { startImagesBackground } from './images/start.js';
import { startMoviesSync } from './movies/start.js';
import { startSessionsBackground } from './sessions/start.js';
import type { Summarizer } from './sessions/summarize.js';

export { REPLY_EMBED_KICK_MS, SUMMARY_DUE_MARGIN_MS } from './sessions/start.js';

export type StopBackground = () => Promise<void>;

export interface BackgroundOptions {
  /**
   * Session summarizer (phase 6). Omitted or null: summaries off, session embeddings still run
   * when an embedder is configured. The daemon passes the Agent SDK Haiku summarizer; tests pass
   * a fake or nothing.
   */
  sessionSummarizer?: Summarizer | null;
}

/**
 * Long-running work beside the HTTP server, each started by a function beside its subsystem, in this order: the inbox
 * (after the legacy images are copied in), the note and image embedding workers, the Claude Code session jobs, the
 * Seer Adversarial reviewer, the movies library's poll loop, the Stream side's jobs, and the hourly egress line.
 * Returns one stop: timers first, then the inbox, then the seek previews and the downloads, then every other closer
 * in parallel (each bounded by its grace, well under main.ts's 10 s exit).
 */
export async function startBackground(deps: AppDeps, options: BackgroundOptions = {}): Promise<StopBackground> {
  const images = await startImagesBackground(deps);
  const embeddings = startEmbeddingWorkers(deps);
  const sessions = startSessionsBackground(deps, options.sessionSummarizer ?? null);
  startAdversary(deps);
  startMoviesSync(deps);
  const stream = startStreamJobs(deps);
  const stopEgress = startEgressLine(deps.db);

  return async () => {
    stopEgress();
    sessions.halt();
    await images.close();
    await stream.closeFirst();
    await Promise.all([...embeddings.closers(), ...sessions.closers(), deps.adversary?.close(), deps.movies?.close(), ...stream.closers()]);
  };
}
