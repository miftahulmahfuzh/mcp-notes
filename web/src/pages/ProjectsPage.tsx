import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowsInLineVertical, ArrowsOutLineVertical } from '@phosphor-icons/react';
import { NodePanel } from '../components/graph/NodePanel';
import { SessionGraph } from '../components/graph/SessionGraph';
import { useSessionGraph } from '../hooks/useSessionGraph';
import { ancestorsOf, buildForest, expandAll, layoutGraph } from '../lib/sessionGraph';
import { toSubtreeNodes } from '../lib/subtree';
import type { SessionNode } from '../types';
import './ProjectsPage.css';

export interface ProjectsPageProps {
  /** Repo shown; null while none is chosen. App keys this page by repo, so a switch remounts it. */
  repo: string | null;
  /** The repo is still being resolved (selection GET / project list in flight). */
  resolving?: boolean;
  /** `?node=`: the selected node id, canonical. */
  node: string | null;
  onSelectNode: (nodeId: string | null) => void;
  /** Phase 11 slot: the node detail panel, beside the graph while a node is selected. */
  renderPanel?: (node: SessionNode, close: () => void) => ReactNode;
  /** Phase 13 slot: forwarded to each GraphNode's `badge`. */
  renderBadge?: (node: SessionNode) => ReactNode;
}

/**
 * The projects view's main area. Layout (later phases add to it, nothing here moves):
 *   .proj-bar   toolbar, icon-only (expand all / collapse all); phase 12 adds its graph <-> chat toggle here
 *   .proj-body  .proj-graph (SessionGraph) + .proj-panel (phase 11's renderPanel)
 *   phase 12 mounts `project-pill-query-input` after .proj-body
 */
export function ProjectsPage({ repo, resolving = false, node, onSelectNode, renderPanel, renderBadge }: ProjectsPageProps) {
  const graph = useSessionGraph(repo);
  const forest = useMemo(() => buildForest(graph.nodes), [graph.nodes]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Reveal the URL's node once: expand its collapsed ancestors as soon as the graph has it.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (node === null) {
      revealed.current = null;
      return;
    }
    if (revealed.current === node) return;
    const hit = graph.nodes.find((n) => n.node_id === node);
    if (!hit) return;
    revealed.current = node;
    const up = ancestorsOf(forest, hit.session_id);
    if (up.length === 0) return;
    setExpanded((prev) => {
      if (up.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of up) next.add(id);
      return next;
    });
  }, [node, graph.nodes, forest]);

  // Esc clears the selection (the wall's Esc closes the answer panel, which is hidden here).
  useEffect(() => {
    if (node === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') onSelectNode(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [node, onSelectNode]);

  const layout = useMemo(() => layoutGraph(graph.nodes, expanded, forest), [graph.nodes, expanded, forest]);

  const toggle = useCallback((sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);
  const select = useCallback((id: string) => onSelectNode(id === node ? null : id), [node, onSelectNode]);
  const close = useCallback(() => onSelectNode(null), [onSelectNode]);
  const panelNodes = useMemo(() => toSubtreeNodes(graph.nodes), [graph.nodes]);
  const panel =
    renderPanel ??
    ((n: SessionNode, closePanel: () => void) => (
      <NodePanel nodeId={n.node_id} nodes={panelNodes} onSelectNode={(id) => onSelectNode(id)} onClose={closePanel} />
    ));

  const selectedNode = node === null ? null : (graph.nodes.find((n) => n.node_id === node) ?? null);
  const branchy = forest.children.size > 0;

  let content: ReactNode;
  if (repo === null) content = <p className="proj-empty">{resolving ? 'loading projects' : 'pick a project in the sidebar'}</p>;
  else if (!graph.loaded) content = <p className="proj-empty">loading sessions</p>;
  else if (graph.error !== null && graph.nodes.length === 0) content = <p className="proj-empty">could not load sessions: {graph.error}</p>;
  else if (graph.nodes.length === 0) content = <p className="proj-empty">no sessions recorded for {repo} yet</p>;
  else content = <SessionGraph layout={layout} selected={node} focus={node} onSelect={select} onToggle={toggle} renderBadge={renderBadge} />;

  return (
    <section className="proj" aria-label="Project sessions">
      <div className="proj-bar">
        <div className="proj-tools">
          <button
            type="button"
            className="ibtn hov"
            data-tip="Expand all"
            aria-label="Expand all"
            disabled={!branchy}
            onClick={() => setExpanded(expandAll(forest))}
          >
            <ArrowsOutLineVertical weight="duotone" />
          </button>
          <button
            type="button"
            className="ibtn hov"
            data-tip="Collapse all"
            aria-label="Collapse all"
            disabled={!branchy}
            onClick={() => setExpanded(new Set())}
          >
            <ArrowsInLineVertical weight="duotone" />
          </button>
        </div>
      </div>
      <div className="proj-body">
        <div className="proj-graph">{content}</div>
        {selectedNode !== null && <aside className="proj-panel">{panel(selectedNode, close)}</aside>}
      </div>
    </section>
  );
}
