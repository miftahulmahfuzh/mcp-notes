import type { AppDeps } from './deps.js';

export type StopBackground = () => Promise<void>;

/** Background jobs started after the HTTP server listens. Phase 4 starts the inbox watcher here. */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  void deps;
  return async () => {};
}
