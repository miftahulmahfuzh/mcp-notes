import { loadConfig } from './config.js';
import { startDaemon } from './daemon.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const daemon = await startDaemon(config);
  console.log(`notesd listening on http://${config.host}:${daemon.port} (data ${config.dataDir})`);

  const shutdown = (signal: NodeJS.Signals): void => {
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
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('notesd: failed to start', err);
  process.exit(1);
});
