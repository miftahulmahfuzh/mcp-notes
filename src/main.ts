import { loadConfig } from './config.js';
import { startDaemon } from './daemon.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // The unit restarts the daemon after any exit it did not ask for (Restart=always), so a clean
  // exit here is a restart.
  const daemon = await startDaemon(config, { onRestartWanted: () => shutdown('restart') });
  console.log(`notesd listening on http://${config.host}:${daemon.port} (data ${config.dataDir})`);

  let stopping = false;
  function shutdown(signal: NodeJS.Signals | 'restart'): void {
    if (stopping) return;
    stopping = true;
    console.log(`notesd: ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('notesd: shutdown failed', err);
        process.exit(1);
      },
    );
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('notesd: failed to start', err);
  process.exit(1);
});
