import type { AppDeps } from '../deps.js';

/** The Stream side's stop: `closeFirst` before every other closer (sequential), then `closers` in parallel. */
export interface StreamJobs {
  closeFirst: () => Promise<void>;
  closers: () => (Promise<unknown> | void | undefined)[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The Stream side's background work, built by the daemon and started here in the order it always was: the daily
 * canary, the trending list, the tracker lists' refresh, the stream cache's unfinished downloads, the seek previews'
 * sweep, the torrents' tick (old downloads cleared; nothing joins a swarm), the downloads the owner asked for (after the
 * torrents' own start, whose prune leaves kept downloads alone) and the Cache page's deletions a restart cut short.
 * A part that is absent starts nothing; each failure is one log line.
 */
export function startStreamJobs(deps: AppDeps, log: (line: string) => void = (line) => console.log(line), error: (line: string) => void = (line) => console.error(line)): StreamJobs {
  const canary = deps.streamCanary ?? null;
  if (canary !== null) {
    log(canary.startLine());
    canary.start();
  }
  const trending = deps.trending ?? null;
  if (trending !== null) {
    log(trending.startLine());
    trending.start();
  }
  // Refreshed a minute after start and once a day; a disabled one only logs why.
  const trackerLists = deps.trackerLists ?? null;
  if (trackerLists !== null) {
    log(trackerLists.startLine());
    trackerLists.start();
  }
  const streamCache = deps.streamCache ?? null;
  if (streamCache !== null) {
    void streamCache.start().then(
      (n) => {
        if (n > 0) log(`[notesd] stream cache: carrying on ${n} unfinished download(s) on ${streamCache.host}`);
      },
      (err: unknown) => error(`[notesd] stream cache: could not carry on downloads: ${messageOf(err)}`),
    );
  }
  // A sweep of the films on disk 30 s after start and every half hour; nothing joins a swarm or fetches.
  const streamPreviews = deps.streamPreviews ?? null;
  streamPreviews?.start();
  const torrents = deps.torrents ?? null;
  const torrentsStarted: Promise<unknown> =
    torrents === null
      ? Promise.resolve()
      : torrents.start().then(
          (cleared) =>
            log(
              `[notesd] torrents on as ${torrents.host}: downloads in ${torrents.root}, upload capped at ${torrents.uploadKbps} kB/s` +
                (cleared > 0 ? `, ${cleared} download(s) not played for ${torrents.keepDays} days cleared` : ''),
            ),
          (err: unknown) => error(`[notesd] torrents: could not start: ${messageOf(err)}`),
        );
  const streamDownloads = deps.streamDownloads ?? null;
  if (streamDownloads !== null) {
    void torrentsStarted
      .then(() => streamDownloads.start())
      .then(
        (n) => {
          if (n > 0) log(`[notesd] downloads: carrying on ${n} download(s) on ${streamDownloads.host}`);
        },
        (err: unknown) => error(`[notesd] downloads: could not carry on downloads: ${messageOf(err)}`),
      );
  }
  const cacheShelf = deps.cacheShelf ?? null;
  if (cacheShelf !== null) {
    void cacheShelf.start().then(
      (n) => {
        if (n > 0) log(`[notesd] cache page: carried out ${n} deletion(s) left pending by the restart`);
      },
      (err: unknown) => error(`[notesd] cache page: could not carry out pending deletions: ${messageOf(err)}`),
    );
  }
  return {
    closeFirst: async () => {
      // The previews' ffmpeg reads the caches' and the torrents' files: it stops, keeping no part of its sheet, before
      // anything it reads closes. Bounded: the running ffmpeg is killed at once.
      await streamPreviews?.close();
      // Before the torrents and the cache: the torrent a download holds is let go (its row stays running for the next start).
      await streamDownloads?.close();
    },
    closers: () => [
      canary?.close(),
      trending?.close(),
      trackerLists?.close(),
      // Before the torrents: ffmpeg stops reading the file route first.
      deps.torrentRemux?.close(),
      streamCache?.close(),
      deps.torrentWhisper?.close(),
      deps.cloudWhisper?.close(),
      deps.audioDetector?.stop(),
      deps.torrentSync?.close(),
      deps.subtitleCheck?.close(),
      torrents?.close(),
      cacheShelf?.close(),
    ],
  };
}
