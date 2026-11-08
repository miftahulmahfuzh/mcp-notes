/** True while the tab is in front. In jsdom (tests) `visibilityState` is 'visible'. */
export function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** Calls `fn` each time the tab becomes visible. Returns the unsubscribe. */
export function onBecameVisible(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = (): void => {
    if (document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

export interface AdaptivePoll {
  /** Cancel the timer and the visibility listener. */
  stop(): void;
  /** Reset the delay to `baseMs` and run `run` now (if visible). */
  poke(): void;
}

/**
 * Runs `run` repeatedly while the tab is visible. `run` resolves true when it saw a change (the
 * delay resets to `baseMs`) and false when nothing changed (the delay doubles up to `maxMs`).
 * Nothing is scheduled while hidden; becoming visible runs once when `staleMs` has passed since
 * the last run, then resumes.
 */
export function startAdaptivePoll(opts: {
  baseMs: number;
  maxMs?: number;
  staleMs?: number;
  run: () => Promise<boolean>;
}): AdaptivePoll {
  const maxMs = opts.maxMs ?? opts.baseMs;
  const staleMs = opts.staleMs ?? opts.baseMs;
  let delay = opts.baseMs;
  let timer: number | undefined;
  let stopped = false;
  let lastRun = 0;
  let running = false;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (stopped || !isPageVisible()) return;
    timer = window.setTimeout(() => void tick(), delay);
  };
  const tick = async (): Promise<void> => {
    if (stopped || running || !isPageVisible()) return;
    running = true;
    try {
      const changed = await opts.run();
      delay = changed ? opts.baseMs : Math.min(maxMs, delay * 2);
    } catch {
      delay = Math.min(maxMs, delay * 2);
    } finally {
      running = false;
      lastRun = Date.now();
      schedule();
    }
  };
  const off = onBecameVisible(() => {
    if (Date.now() - lastRun >= staleMs) {
      delay = opts.baseMs;
      void tick();
    } else {
      schedule();
    }
  });
  lastRun = Date.now(); // the caller loads once itself on mount
  schedule();
  return {
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      off();
    },
    poke() {
      delay = opts.baseMs;
      void tick();
    },
  };
}
