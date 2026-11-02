import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { isConfirmOpen } from '../ConfirmDialog';
import { isLightboxOpen } from '../Lightbox';
import { useSessionGraph } from '../../hooks/useSessionGraph';
import { toSubtreeNodes } from '../../lib/subtree';
import type { SessionDetail } from '../../sessionDetailApi';
import { NodePanel } from './NodePanel';
import './NodeModal.css';

export interface NodeModalProps {
  /** The node id clicked in chat text, canonical. */
  nodeId: string;
  /** Its repo, when known: loads that project's graph for the subtree views. */
  repo: string | null;
  onClose: () => void;
  /** "Show on graph": the projects page on this node. */
  onShowOnGraph: (nodeId: string, repo: string) => void;
}

/**
 * A node id clicked in chat (`BE-XU`): the graph page's node panel as a pop-up over the current
 * page, the way a note id opens the big editor. Parent and subtree clicks move the pop-up to that
 * node; "Show on graph" leaves for the projects page. Esc and a click outside close it.
 */
export function NodeModal({ nodeId, repo, onClose, onShowOnGraph }: NodeModalProps) {
  const [current, setCurrent] = useState(nodeId);
  useEffect(() => setCurrent(nodeId), [nodeId]);
  const graph = useSessionGraph(repo);
  const nodes = useMemo(() => toSubtreeNodes(graph.nodes), [graph.nodes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isLightboxOpen() || isConfirmOpen()) return;
      // Capture phase + preventDefault + stopPropagation (the editor's seam): Esc closes only the pop-up.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const show = (d: SessionDetail) => {
    if (d.repo !== null) onShowOnGraph(d.node_id, d.repo);
  };

  return createPortal(
    <div className="nm" data-modal="node" onClick={onClose}>
      <div className="nm-panel" role="dialog" aria-label={`Session ${current}`} onClick={(e) => e.stopPropagation()}>
        <NodePanel nodeId={current} nodes={nodes} onSelectNode={setCurrent} onClose={onClose} onShowOnGraph={show} />
      </div>
    </div>,
    document.body,
  );
}
