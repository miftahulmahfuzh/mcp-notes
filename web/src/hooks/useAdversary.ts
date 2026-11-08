import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { fetchMethod, fetchOverview, fetchToggle, postReviewNow, saveToggle, type AdversaryToggle, type MethodPayload, type OverviewPayload, type ReviewNowResult } from '../adversaryApi';
import { subscribeEvents } from '../lib/events';
import { isPageVisible, onBecameVisible, startAdaptivePoll } from '../lib/pageActive';

/** Every 2 min while the tab is visible: picks up a verdict or toggle written by the daemon on the other laptop. */
export const ADVERSARY_POLL_MS = 120_000;

export interface AdversaryStore {
  overview: OverviewPayload | null;
  overviewError: string | null;
  /** The detail of the strategy asked for (null while loading or on the overview). */
  method: MethodPayload | null;
  methodError: string | null;
  /** null until the first GET answers. */
  toggle: AdversaryToggle | null;
  /** PUT the auto-runs switch. False when the server refused (the old state is kept). */
  setAuto: (on: boolean) => Promise<boolean>;
  /**
   * Starts one review pass, even while auto-runs are off. Resolves as soon as phase 5 answers 202
   * `{started, reason}`; the pass itself is never awaited (its verdicts arrive as SSE `adversary`
   * events, which refresh this store). Throws ApiError on refusal.
   */
  reviewNow: (strategyId: string | null) => Promise<ReviewNowResult>;
  refresh: () => void;
}

function codeOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Seer Adversarial's data. Fetches only while `enabled` (the page is shown): the overview (the
 * sidebar roster and the header need it on every sub-page), the toggle, and the method of `strategy`.
 * Refreshes on the SSE `adversary` event (phase 5) and every 2 min while the tab is visible.
 */
export function useAdversary(enabled: boolean, strategy: string | null): AdversaryStore {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [method, setMethod] = useState<MethodPayload | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [toggle, setToggle] = useState<AdversaryToggle | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** An SSE event arrived while the tab was hidden: refresh once on becoming visible. */
  const staleRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribeEvents('adversary', () => {
      if (isPageVisible()) refresh();
      else staleRef.current = true;
    });
    const offVisible = onBecameVisible(() => {
      if (staleRef.current) {
        staleRef.current = false;
        refresh();
      }
    });
    const poll = startAdaptivePoll({
      baseMs: ADVERSARY_POLL_MS,
      staleMs: 60_000,
      run: async () => {
        refresh();
        return true;
      },
    });
    return () => {
      off();
      offVisible();
      poll.stop();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchOverview(ac.signal).then(
      (o) => {
        if (ac.signal.aborted) return;
        setOverview(o);
        setOverviewError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setOverviewError(codeOf(e));
      },
    );
    fetchToggle(ac.signal).then(
      (t) => {
        if (!ac.signal.aborted) setToggle(t);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) console.error('adversary: toggle GET failed', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick]);

  // A switch to another method drops the old detail at once, so its numbers never show under the new heading.
  useEffect(() => {
    setMethod((m) => (m !== null && m.method.strategy_id === strategy ? m : null));
    setMethodError(null);
  }, [strategy]);

  useEffect(() => {
    if (!enabled || strategy === null) return;
    const ac = new AbortController();
    fetchMethod(strategy, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setMethod(d);
        setMethodError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setMethodError(codeOf(e));
      },
    );
    return () => ac.abort();
  }, [enabled, strategy, tick]);

  const setAuto = useCallback(async (on: boolean): Promise<boolean> => {
    try {
      setToggle(await saveToggle(on));
      return true;
    } catch (e) {
      console.error('adversary: toggle PUT failed', e);
      return false;
    }
  }, []);

  const reviewNow = useCallback((strategyId: string | null) => postReviewNow(strategyId), []);

  return { overview, overviewError, method, methodError, toggle, setAuto, reviewNow, refresh };
}
