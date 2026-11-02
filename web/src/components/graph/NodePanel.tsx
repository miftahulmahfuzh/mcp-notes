import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChartBarHorizontal, Check, CloudSlash, Copy, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
import { ConfirmDialog } from '../ConfirmDialog';
import { useCopied } from '../../hooks/useCopied';
import { useNow } from '../../hooks/useNow';
import { chatTime, chatTimeTitle } from '../../lib/chatTime';
import { hostsLabel } from '../../lib/remote';
import { formatCost, formatCount } from '../../lib/sessionFormat';
import { subtreeRows, type SubtreeNode, type SubtreeRow } from '../../lib/subtree';
import { fetchSessionDetail, resumeErrorNotice, resumeNotice, resumeSession, type SessionDetail } from '../../sessionDetailApi';
import { SubtreeTimeline } from './SubtreeTimeline';
import { SubtreeTree } from './SubtreeTree';
import { UnfinishedPill } from './UnfinishedBadge';
import './NodePanel.css';

export type SubtreeView = 'tree' | 'timeline';

/** Prompts listed before "+N more". */
const PROMPTS_SHOWN = 20;

export interface NodePanelProps {
  /** The selected node from `?node=` (any case, dash optional; the server normalises). */
  nodeId: string;
  /** The project graph's nodes (phase 10's payload through `toSubtreeNodes`), for the subtree views and refresh. */
  nodes: readonly SubtreeNode[];
  /** Select another node (pushes `?node=`). */
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  /** Tests pin the clock; the page uses a minute tick. */
  now?: Date;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; detail: SessionDetail }
  | { state: 'missing' }
  | { state: 'error'; message: string };

/** Case- and dash-insensitive id key: `a03g`, `A0-3G` are the same node. */
const idKey = (id: string): string => id.toUpperCase().replace(/-/g, '');

function placeLabel(host: string): string {
  return hostsLabel(host ? [host] : []);
}

export function NodePanel({ nodeId, nodes, onSelectNode, onClose, now: nowProp }: NodePanelProps) {
  const clock = useNow();
  const now = nowProp ?? clock;
  const { copied, copy } = useCopied();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [view, setView] = useState<SubtreeView>('tree');
  const [busy, setBusy] = useState<'resume' | 'fresh' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);
  const currentKey = useRef(idKey(nodeId));
  currentKey.current = idKey(nodeId);

  const stamp = useMemo(() => {
    const k = idKey(nodeId);
    return nodes.find((n) => idKey(n.node_id) === k)?.last_active_at ?? '';
  }, [nodes, nodeId]);

  useEffect(() => {
    const ac = new AbortController();
    setLoad((prev) => (prev.state === 'ready' && idKey(prev.detail.node_id) === idKey(nodeId) ? prev : { state: 'loading' }));
    fetchSessionDetail(nodeId, ac.signal).then(
      (d) => {
        if (!ac.signal.aborted) setLoad(d ? { state: 'ready', detail: d } : { state: 'missing' });
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ac.abort();
  }, [nodeId, stamp]);

  useEffect(() => {
    setNotice(null);
    setConfirm(null);
  }, [nodeId]);

  const detail = load.state === 'ready' ? load.detail : null;
  const shownId = detail?.node_id ?? nodeId.toUpperCase();

  const rows = useMemo<SubtreeRow[]>(() => {
    const found = subtreeRows(nodes, shownId);
    if (found.length > 0 || !detail) return found;
    return [
      {
        node_id: detail.node_id,
        parent: detail.parent?.node_id ?? null,
        label: detail.name ?? detail.title ?? '',
        started_at: detail.started_at,
        last_active_at: detail.last_active_at,
        live: detail.live,
        available: detail.available,
        host: detail.host || null,
        depth: 0,
      },
    ];
  }, [nodes, shownId, detail]);

  const run = async (d: SessionDetail, fresh: boolean): Promise<void> => {
    setBusy(fresh ? 'fresh' : 'resume');
    setNotice(null);
    let text: string;
    try {
      text = resumeNotice(await resumeSession(d.node_id, { fresh }), fresh);
    } catch (e) {
      text = resumeErrorNotice(e, d);
    }
    setBusy(null);
    if (currentKey.current === idKey(d.node_id)) setNotice(text);
  };

  // No confirm click (settled), except a node whose transcript is on the other machine.
  const ask = (fresh: boolean): void => {
    if (!detail || busy !== null) return;
    if (detail.available) void run(detail, fresh);
    else setConfirm({ fresh });
  };

  const resumeTip = detail?.live ? 'Focus the running session' : 'Resume in tmux';

  return (
    <aside className="np" aria-label={`Session ${shownId}`} data-node={shownId}>
      <header className="np-head">
        <button
          type="button"
          className="np-id"
          data-tip={copied === shownId ? 'Copied' : 'Copy node id'}
          data-tip-side="below"
          aria-label="Copy node id"
          onClick={() => copy(shownId)}
        >
          {shownId}
          {copied === shownId ? <Check weight="duotone" /> : <Copy weight="duotone" />}
        </button>
        <div className="np-actions">
          <button
            type="button"
            className="ibtn hov"
            data-tip={resumeTip}
            data-tip-side="below"
            aria-label={resumeTip}
            disabled={!detail || busy !== null}
            onClick={() => ask(false)}
          >
            <Play weight="duotone" />
          </button>
          <button
            type="button"
            className="ibtn hov"
            data-tip="Spawn fresh with this context"
            data-tip-side="below"
            aria-label="Spawn fresh with this context"
            disabled={!detail || busy !== null}
            onClick={() => ask(true)}
          >
            <Sparkle weight="duotone" />
          </button>
          <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
            <X weight="duotone" />
          </button>
        </div>
      </header>

      <p className="np-notice" role="status">
        {busy !== null ? (busy === 'fresh' ? 'Starting a fresh session…' : 'Resuming…') : notice ?? ''}
      </p>

      {load.state === 'loading' && <p className="np-dim">Loading {shownId}</p>}
      {load.state === 'missing' && <p className="np-dim">No session {shownId}</p>}
      {load.state === 'error' && <p className="np-dim">Could not load {shownId}: {load.message}</p>}

      {detail && (
        <>
          <div className="np-meta">
            <UnfinishedPill unfinished={detail.unfinished} />
            {detail.live && <span className="np-live">running</span>}
            {detail.available ? (
              detail.host && <span>{detail.host}</span>
            ) : (
              <span className="np-away" data-tip="Its transcript is on the other machine">
                <CloudSlash weight="duotone" /> on {placeLabel(detail.host)}
              </span>
            )}
            {detail.repo && (
              <span>
                {detail.repo}
                {detail.branch ? ` · ${detail.branch}` : ''}
              </span>
            )}
            {detail.started_at && (
              <time dateTime={detail.started_at} title={chatTimeTitle(detail.started_at)}>
                {chatTime(detail.started_at, now)}
              </time>
            )}
            {detail.last_active_at && detail.last_active_at !== detail.started_at && (
              <time dateTime={detail.last_active_at} title={chatTimeTitle(detail.last_active_at)}>
                to {chatTime(detail.last_active_at, now)}
              </time>
            )}
          </div>

          <h2 className="np-title">{detail.name ?? detail.title ?? 'Untitled session'}</h2>
          {detail.name && detail.title && detail.title !== detail.name && <p className="np-sub">{detail.title}</p>}
          {detail.parent && (
            <ParentLine parent={detail.parent} source={detail.parent_link_source} onSelect={onSelectNode} />
          )}

          <section className="np-sec" aria-label="Summary">
            <h3>Summary</h3>
            {detail.summary ? <p className="np-summary">{detail.summary}</p> : <p className="np-dim">No summary yet</p>}
          </section>

          <section className="np-sec" aria-label="Prompts">
            <h3>Prompts</h3>
            {detail.prompts.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ol className="np-prompts">
                {detail.prompts.slice(0, PROMPTS_SHOWN).map((p, i) => (
                  <li key={i}>
                    <span className="np-clamp">{p}</span>
                  </li>
                ))}
              </ol>
            )}
            {detail.prompts.length > PROMPTS_SHOWN && <p className="np-dim">+{detail.prompts.length - PROMPTS_SHOWN} more</p>}
          </section>

          <section className="np-sec" aria-label="Commits">
            <h3>Commits</h3>
            {detail.commits.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ul className="np-commits">
                {detail.commits.map((c) => (
                  <li key={c.sha}>
                    <code title={c.sha}>{c.sha.slice(0, 7)}</code>
                    {c.subject}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="np-sec" aria-label="Notes made">
            <h3>Notes made</h3>
            {detail.notes.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ul className="np-notes">
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    <a href={`/?note=${encodeURIComponent(n.id)}`}>{n.id}</a>
                    {n.preview && <span>{n.preview}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="np-sec" aria-label="Tokens">
            <h3>Tokens</h3>
            <dl className="np-tokens">
              <div>
                <dt>input</dt>
                <dd>{formatCount(detail.tokens.input)}</dd>
              </div>
              <div>
                <dt>output</dt>
                <dd>{formatCount(detail.tokens.output)}</dd>
              </div>
              <div>
                <dt>cache read</dt>
                <dd>{formatCount(detail.tokens.cache_read)}</dd>
              </div>
              <div>
                <dt>cache write</dt>
                <dd>{formatCount(detail.tokens.cache_write)}</dd>
              </div>
              {formatCost(detail.cost_usd) !== null && (
                <div>
                  <dt>cost</dt>
                  <dd>{formatCost(detail.cost_usd)}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="np-sec" aria-label="Subtree">
            <div className="np-sec-head">
              <h3>Subtree</h3>
              <div className="np-toggle">
                <button
                  type="button"
                  className={`ibtn hov${view === 'tree' ? ' on' : ''}`}
                  data-tip="Tree"
                  aria-label="Tree"
                  aria-pressed={view === 'tree'}
                  onClick={() => setView('tree')}
                >
                  <TreeStructure weight="duotone" />
                </button>
                <button
                  type="button"
                  className={`ibtn hov${view === 'timeline' ? ' on' : ''}`}
                  data-tip="Timeline"
                  aria-label="Timeline"
                  aria-pressed={view === 'timeline'}
                  onClick={() => setView('timeline')}
                >
                  <ChartBarHorizontal weight="duotone" />
                </button>
              </div>
            </div>
            {view === 'tree' ? (
              <SubtreeTree rows={rows} current={shownId} onSelect={onSelectNode} />
            ) : (
              <SubtreeTimeline rows={rows} current={shownId} now={now} onSelect={onSelectNode} />
            )}
          </section>
        </>
      )}

      {confirm &&
        detail &&
        createPortal(
          <ConfirmDialog
            message={`${detail.node_id} ran on ${placeLabel(detail.host)}, and its transcript is not on this machine. ${confirm.fresh ? 'Spawn a fresh session' : 'Resume'} anyway?`}
            confirmLabel="Try anyway"
            confirmIcon={confirm.fresh ? <Sparkle weight="duotone" /> : <Play weight="duotone" />}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const fresh = confirm.fresh;
              setConfirm(null);
              void run(detail, fresh);
            }}
          />,
          document.body,
        )}
    </aside>
  );
}

function ParentLine({
  parent,
  source,
  onSelect,
}: {
  parent: { node_id: string; name: string | null };
  source: SessionDetail['parent_link_source'];
  onSelect: (nodeId: string) => void;
}) {
  return (
    <p className="np-parent">
      from{' '}
      <button type="button" className="np-link" aria-label={`Open parent ${parent.node_id}`} onClick={() => onSelect(parent.node_id)}>
        {parent.node_id}
      </button>
      {parent.name ? ` ${parent.name}` : ''}
      {source === 'heuristic' && <span className="np-src" data-tip="Linked by matching names in the parent's transcript"> (guessed)</span>}
    </p>
  );
}
