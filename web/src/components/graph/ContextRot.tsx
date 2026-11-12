import type { HandoffEstimate, SessionContext } from '../../sessionDetailApi';
import { useHandoffEstimate, useSessionContext } from '../../hooks/useSessionContext';
import { formatCount } from '../../lib/sessionFormat';
import './ContextRot.css';

/** Fill width in percent of the track: 0..100 whatever the server's percent. */
export function fillPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Whole percent for the label, rounded down so it never reads as the next band (39.9 % shows "39%", green). */
export function percentLabel(percent: number): string {
  return `${Math.floor(Number.isFinite(percent) ? Math.max(0, percent) : 0)}%`;
}

/**
 * True when a fresh spawn would start at or above the session's current context: a session barely
 * past its own start-up cost gains nothing from a handoff, since the new session pays that cost
 * again plus the handoff. The bar keeps the true estimate; the caption says resume instead.
 */
export function freshSavesNothing(context: SessionContext | null, estimate: HandoffEstimate): boolean {
  return context !== null && estimate.baseline + estimate.tokens >= context.tokens;
}

export interface ContextRotProps {
  nodeId: string;
  live: boolean;
  available: boolean;
  /** The session detail's `context`. */
  initial: SessionContext | null;
}

/** The node panel's Context Rot view: mounted only while the view is open. */
export function ContextRot({ nodeId, live, available, initial }: ContextRotProps) {
  const context = useSessionContext({ nodeId, live, available, initial });
  const estimate = useHandoffEstimate(nodeId, context === null ? '' : `${context.tokens}|${context.at ?? ''}`);
  return <ContextBars context={context} estimate={estimate} />;
}

export interface ContextBarsProps {
  context: SessionContext | null;
  estimate: HandoffEstimate | null;
}

export function ContextBars({ context, estimate }: ContextBarsProps) {
  return (
    <div className="cr">
      {context === null ? (
        <div className="cr-row">
          <div className="cr-track cr-unknown" aria-hidden="true" />
          <p className="cr-text">
            <span className="cr-main">Unknown</span>
            <span className="cr-note">no reply with token usage yet</span>
          </p>
        </div>
      ) : (
        <div className="cr-row">
          <div
            className="cr-track"
            role="meter"
            aria-label="Current context"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fillPercent(context.percent))}
            aria-valuetext={`${percentLabel(context.percent)} of the context window`}
            data-band={context.band}
          >
            <div className={`cr-fill cr-${context.band}`} style={{ width: `${fillPercent(context.percent)}%` }} />
          </div>
          <p className="cr-text">
            <span className="cr-main">{`${formatCount(context.tokens)} / ${formatCount(context.window)} · ${percentLabel(context.percent)}`}</span>
            {context.model !== null && <span className="cr-note">{context.model}</span>}
            {context.window_source === 'default' && (
              <span className="cr-note" data-tip="Unknown model and no sign of a 1M window: 200k assumed">
                window assumed
              </span>
            )}
          </p>
        </div>
      )}
      {estimate !== null && (
        <div className={freshSavesNothing(context, estimate) ? 'cr-row cr-no-saving' : 'cr-row'}>
          <div
            className="cr-track"
            role="meter"
            aria-label="Fresh session estimate"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fillPercent(estimate.percent))}
          >
            <div className="cr-fill cr-fresh" style={{ width: `${fillPercent(estimate.percent)}%` }} />
          </div>
          <p className="cr-text">
            <span className="cr-main">{`Fresh session would start at ~${Math.round(fillPercent(estimate.percent))}%`}</span>
            {freshSavesNothing(context, estimate) ? (
              <span
                className="cr-note"
                data-tip="A fresh session pays the start-up cost again plus the handoff, so it would not start lighter than this one is now"
              >
                no saving: resume is as cheap
              </span>
            ) : (
              <span className="cr-note">{`carries ${estimate.exchanges_included} of ${estimate.exchanges_total} exchanges`}</span>
            )}
            {estimate.truncated && (
              <span className="cr-note" data-tip="The first prompt and the newest exchanges that fit; the handoff points at the transcript for the rest">
                older ones left out
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
