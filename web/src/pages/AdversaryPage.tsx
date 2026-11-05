import { useState, type ReactNode } from 'react';
import { ArrowsClockwise, CornersIn, CornersOut, Power } from '@phosphor-icons/react';
import { AdversaryDaily } from '../components/adversary/AdversaryDaily';
import { AdversaryMethod } from '../components/adversary/AdversaryMethod';
import { AdversaryOverview } from '../components/adversary/AdversaryOverview';
import { AdversaryPill } from '../components/adversary/AdversaryPill';
import { useFocusShortcut } from '../hooks/useFocusShortcut';
import { useNotice } from '../hooks/useNotice';
import type { AdversaryStore } from '../hooks/useAdversary';
import { ApiError } from '../api';
import { adversaryHeading, errorText, focusLine } from '../lib/adversary';

export interface AdversaryPageProps {
  store: AdversaryStore;
  /** `/adversary/<id>`: the method shown; null = the overview. */
  strategy: string | null;
  /** Focus mode (`?focus=1`): App hides the rail, sidebar and header; the page shows a small heading. */
  focus: boolean;
  onToggleFocus: () => void;
  /** Esc leaves focus mode only while nothing else wants Esc (App: the answer panel is closed). */
  escapeLeavesFocus: boolean;
  onPickStrategy: (strategyId: string | null) => void;
  onAsk: (text: string, imageIds: string[]) => void;
}

export const POWER_ON_TIP = 'Auto-runs on (click to pause)';
export const POWER_OFF_TIP = 'Auto-runs off (click to turn on)';

/**
 * Seer Adversarial's main area:
 *   .adv-bar   toolbar, icon-only: auto-runs Power toggle, Review now, Focus (Alt+Z)
 *   focus head (focus mode only: App's header is hidden)
 *   content    overview / method / daily three-way, picked by the API data (three_way present = daily)
 *   pill       "Ask about Seer Adversarial"
 */
export function AdversaryPage({ store, strategy, focus, onToggleFocus, escapeLeavesFocus, onPickStrategy, onAsk }: AdversaryPageProps) {
  useFocusShortcut(onToggleFocus, { focus, escapeLeaves: escapeLeavesFocus });
  const { notice, show } = useNotice(6000);
  const [busy, setBusy] = useState(false);
  const auto = store.toggle?.on ?? null;

  const flip = async () => {
    if (auto === null) return;
    setBusy(true);
    const ok = await store.setAuto(!auto);
    setBusy(false);
    if (!ok) show('could not change auto-runs');
  };

  // Awaits only phase 5's immediate 202 `{started, reason}`; the pass runs on in the daemon and its
  // verdicts reach the page through SSE `adversary` events and the store's refresh.
  const review = async () => {
    setBusy(true);
    try {
      const r = await store.reviewNow(strategy);
      show(r.started ? 'review started' : (r.reason ?? 'nothing to review'));
    } catch (e) {
      show(`review refused: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const powerTip = auto === false ? POWER_OFF_TIP : POWER_ON_TIP;
  const reviewLabel = strategy === null ? 'Review now' : 'Review this method now';
  const reviewTip = auto === false ? `${reviewLabel} (runs once, even while auto-runs are off)` : reviewLabel;
  const focusTip = focus ? 'Exit focus (Alt+Z)' : 'Focus (Alt+Z)';

  let content: ReactNode;
  if (strategy === null) {
    if (store.overviewError !== null) content = <p className="adv-empty">{errorText(store.overviewError)}</p>;
    else if (store.overview === null) content = <p className="adv-empty">loading Seer Adversarial</p>;
    else content = <AdversaryOverview overview={store.overview} onPick={(id) => onPickStrategy(id)} />;
  } else if (store.methodError !== null) {
    content = <p className="adv-empty">{errorText(store.methodError, strategy)}</p>;
  } else if (store.method === null || store.method.method.strategy_id !== strategy) {
    content = <p className="adv-empty">loading {strategy}</p>;
  } else if (store.method.three_way !== null) {
    content = <AdversaryDaily detail={store.method} tw={store.method.three_way} />;
  } else {
    content = <AdversaryMethod detail={store.method} />;
  }

  return (
    <section className="adv" aria-label="Seer Adversarial">
      <div className="adv-bar">
        {notice && (
          <span className="adv-note" role="status">
            {notice}
          </span>
        )}
        <button
          type="button"
          className={auto === null ? 'ibtn' : auto ? 'ibtn on' : 'ibtn adv-off'}
          data-tip={powerTip}
          data-tip-side="below"
          aria-label={powerTip}
          aria-pressed={auto !== false}
          disabled={auto === null || busy}
          onClick={() => void flip()}
        >
          <Power weight="duotone" />
        </button>
        <button type="button" className="ibtn hov" data-tip={reviewTip} data-tip-side="below" aria-label={reviewLabel} disabled={busy} onClick={() => void review()}>
          <ArrowsClockwise weight="duotone" />
        </button>
        <button type="button" className={focus ? 'ibtn on' : 'ibtn hov'} data-tip={focusTip} data-tip-side="below" aria-label={focusTip} aria-pressed={focus} onClick={onToggleFocus}>
          {focus ? <CornersIn weight="duotone" /> : <CornersOut weight="duotone" />}
        </button>
      </div>
      {focus && (
        <>
          <div className="adv-focus-head">
            <span className="adv-focus-h">{adversaryHeading(store, strategy)}</span>
            <span className="adv-meta">{focusLine(store.toggle, store.overview)}</span>
          </div>
          <div className="rule" />
        </>
      )}
      {content}
      <AdversaryPill onAsk={onAsk} />
    </section>
  );
}
