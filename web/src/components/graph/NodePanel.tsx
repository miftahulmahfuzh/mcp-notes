import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsOut, ChartBarHorizontal, Check, CloudSlash, Copy, Graph, LinkSimple, MagicWand, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
import { ChatInline, NoteLinkContext, type NoteLinks } from '../ChatText';
import { ConfirmDialog } from '../ConfirmDialog';
import { useCopied } from '../../hooks/useCopied';
import { useNow } from '../../hooks/useNow';
import { chatTime, chatTimeTitle } from '../../lib/chatTime';
import { hostsLabel } from '../../lib/remote';
import { formatCost, formatCount } from '../../lib/sessionFormat';
import { subtreeRows, type SubtreeNode, type SubtreeRow } from '../../lib/subtree';
import { ApiError } from '../../api';
import {
  fetchSessionDetail,
  requestSummary,
  resumeErrorNotice,
  resumeNotice,
  resumeSession,
  summarizeErrorNotice,
  type SessionDetail,
  type SummaryRequest,
} from '../../sessionDetailApi';
import { SubtreeTimeline } from './SubtreeTimeline';
import { SubtreeTree } from './SubtreeTree';
import { UnfinishedPill } from './UnfinishedBadge';
import { PromptsModal } from './PromptsModal';
import './NodePanel.css';

export type SubtreeView = 'tree' | 'timeline';

/** Prompts listed before "+N more". */
const PROMPTS_SHOWN = 20;

export interface NodePanelProps {
  /** The selected node from `?node=` (any case, dash optional; the server normalises). */
  nodeId: string;
  /** The project graph's nodes (phase 10's payload through `toSubtreeNodes`), for the subtree views and refresh. */
  nodes: readonly SubtreeNode[];
  /** Select another node (pushes `?node=`). `repo` is set when the node is in another project (a cross-repo parent). */
  onSelectNode: (nodeId: string, repo?: string) => void;
  onClose: () => void;
  /** The chat pop-up's "Show on graph": open this node on its project's graph. Absent on the graph page itself. */
  onShowOnGraph?: (detail: SessionDetail) => void;
  /**
   * Open a note from "Notes made" in the big editor over this page. A plain primary click calls it;
   * a modified or middle click still follows the link to the wall. Absent: every click follows the link.
   */
  onOpenNote?: (noteId: string) => void;
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

/** A plain primary click: no modifier, left button. Anything else is left to the browser (new tab or window). */
function isPlainClick(e: ReactMouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function NodePanel({ nodeId, nodes, onSelectNode, onClose, onShowOnGraph, onOpenNote, now: nowProp }: NodePanelProps) {
  const clock = useNow();
  const now = nowProp ?? clock;
  const { copied, copy } = useCopied();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [view, setView] = useState<SubtreeView>('tree');
  const [busy, setBusy] = useState<'resume' | 'fresh' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  // Note ids in the summary open like "Notes made": the big editor in place when the page gives one.
  const outerLinks = useContext(NoteLinkContext);
  const summaryLinks = useMemo<NoteLinks | null>(
    () => (onOpenNote ? { isKnown: outerLinks?.isKnown ?? (() => false), open: onOpenNote } : outerLinks),
    [onOpenNote, outerLinks],
  );
  const currentKey = useRef(idKey(nodeId));
  currentKey.current = idKey(nodeId);

  const stamp = useMemo(() => {
    const k = idKey(nodeId);
    const n = nodes.find((x) => idKey(x.node_id) === k);
    return n ? `${n.last_active_at ?? ''}|${n.summarized ? 'summarized' : ''}` : '';
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
    setPromptsOpen(false);
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
        summarized: detail.summary !== null,
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

  /** Apply a summary-state change to the loaded detail, if that node is still the one shown. */
  const patchDetail = (key: string, patch: SummaryRequest | Pick<SessionDetail, 'summary_state' | 'summary_requested_at'>): void => {
    setLoad((prev) => (prev.state === 'ready' && idKey(prev.detail.node_id) === key ? { state: 'ready', detail: { ...prev.detail, ...patch } } : prev));
  };

  // Optimistic: the label flips to "Summary requested" (and the button goes) before the POST answers.
  const summarize = async (d: SessionDetail): Promise<void> => {
    const key = idKey(d.node_id);
    const before = { summary_state: d.summary_state, summary_requested_at: d.summary_requested_at };
    setNotice(null);
    patchDetail(key, { summary_state: 'requested', summary_requested_at: new Date().toISOString() });
    try {
      patchDetail(key, await requestSummary(d.node_id));
    } catch (e) {
      const empty = e instanceof ApiError && e.message === 'empty_session';
      patchDetail(key, empty ? { summary_state: 'empty', summary_requested_at: null } : before);
      if (currentKey.current === key) setNotice(summarizeErrorNotice(e, d));
    }
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
          {onShowOnGraph && (
            <button
              type="button"
              className="ibtn hov"
              data-tip="Show on graph"
              data-tip-side="below"
              aria-label="Show on graph"
              disabled={!detail || detail.repo === null}
              onClick={() => detail && onShowOnGraph(detail)}
            >
              <Graph weight="duotone" />
            </button>
          )}
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
            <ParentLine
              parent={detail.parent}
              source={detail.parent_link_source}
              onSelect={() => {
                const p = detail.parent;
                if (!p) return;
                if (p.repo !== null && p.repo !== detail.repo) onSelectNode(p.node_id, p.repo);
                else onSelectNode(p.node_id);
              }}
            />
          )}

          <section className="np-sec" aria-label="Summary">
            <div className="np-sec-head">
              <h3>Summary</h3>
              {detail.summary === null && detail.summary_state !== 'empty' && detail.summary_state !== 'requested' && (
                <button
                  type="button"
                  className="ibtn hov"
                  data-tip="Summarize"
                  aria-label="Summarize"
                  onClick={() => void summarize(detail)}
                >
                  <MagicWand weight="duotone" />
                </button>
              )}
            </div>
            {detail.summary ? (
              <p className="np-summary">
                <NoteLinkContext.Provider value={summaryLinks}>
                  <ChatInline text={detail.summary} />
                </NoteLinkContext.Provider>
              </p>
            ) : <SummaryLine detail={detail} />}
          </section>

          <section className="np-sec" aria-label="Prompts">
            <div className="np-sec-head">
              <h3>Prompts</h3>
              {detail.prompts.length > 0 && (
                <button
                  type="button"
                  className="ibtn hov"
                  data-tip="Expand prompts"
                  aria-label="Expand prompts"
                  aria-haspopup="dialog"
                  onClick={() => setPromptsOpen(true)}
                >
                  <ArrowsOut weight="duotone" />
                </button>
              )}
            </div>
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
                  <li key={c.sha} title={c.subject}>
                    {c.url !== null ? (
                      <a className="np-commit" href={c.url} target="_blank" rel="noreferrer noopener" data-tip="Open commit">
                        <code>{c.sha.slice(0, 7)}</code>
                        <span>{c.subject}</span>
                      </a>
                    ) : (
                      <>
                        <code title={c.sha}>{c.sha.slice(0, 7)}</code>
                        {c.subject}
                      </>
                    )}
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
                    <a
                      href={`/?note=${encodeURIComponent(n.id)}`}
                      data-tip={onOpenNote ? 'Open note' : undefined}
                      onClick={
                        onOpenNote
                          ? (e) => {
                              if (!isPlainClick(e)) return;
                              e.preventDefault();
                              onOpenNote(n.id);
                            }
                          : undefined
                      }
                    >
                      {n.id}
                    </a>
                    {n.kind === 'linked' && (
                      <span className="np-linked" role="img" aria-label="Linked note" data-tip="Linked to this session">
                        <LinkSimple weight="duotone" />
                      </span>
                    )}
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
                  <dt>{detail.cost_estimated ? 'cost (est.)' : 'cost'}</dt>
                  <dd
                    data-tip={detail.cost_estimated ? 'Estimated from tokens and model prices' : 'Recorded by Claude Code, subagents included'}
                  >
                    {detail.cost_estimated ? '~' : ''}
                    {formatCost(detail.cost_usd)}
                  </dd>
                </div>
              )}
              {detail.subagent_count > 0 && formatCost(detail.subagent_cost_usd) !== null && (
                <div>
                  <dt>subagents ({detail.subagent_count})</dt>
                  <dd data-tip="Estimated from the subagents' tokens; part of the cost">~{formatCost(detail.subagent_cost_usd)}</dd>
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
      {promptsOpen && detail && <PromptsModal nodeId={detail.node_id} now={now} onClose={() => setPromptsOpen(false)} />}
    </aside>
  );
}

function ParentLine({
  parent,
  source,
  onSelect,
}: {
  parent: { node_id: string; name: string | null; repo: string | null };
  source: SessionDetail['parent_link_source'];
  onSelect: () => void;
}) {
  return (
    <p className="np-parent">
      from{' '}
      <button type="button" className="np-link" aria-label={`Open parent ${parent.node_id}`} onClick={onSelect}>
        {parent.node_id}
      </button>
      {parent.name ? ` ${parent.name}` : ''}
      {source === 'heuristic' && <span className="np-src" data-tip="Linked by matching names in the parent's transcript"> (guessed)</span>}
    </p>
  );
}

/** The Summary section's line when there is no summary: the reason, from phase 2's `summary_state`. */
function SummaryLine({ detail }: { detail: SessionDetail }) {
  const where = placeLabel(detail.host);
  switch (detail.summary_state) {
    case 'empty':
      return <p className="np-dim">Empty session</p>;
    case 'requested':
      return (
        <p className="np-dim" data-tip={detail.available ? undefined : `${where} summarizes it the next time its daemon runs`}>
          Summary requested
        </p>
      );
    case 'other_host':
      return <p className="np-dim">{`Will be summarized on ${where}`}</p>;
    case 'idle_wait':
      return <p className="np-dim">Summarizes once idle</p>;
    default:
      return <p className="np-dim">No summary yet</p>;
  }
}
