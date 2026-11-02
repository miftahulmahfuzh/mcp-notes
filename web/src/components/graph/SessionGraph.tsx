import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { SessionNode } from '../../types';
import { GraphEdges } from './GraphEdges';
import { GraphNode, filled } from './GraphNode';
import { OVERSCAN, ROW_H, TITLE_PX, graphWidth, labelX, laneX, rowY, visibleRange, type GraphLayout } from '../../lib/sessionGraph';
import { clearTextWidths, textWidth } from '../../lib/textWidth';
import './SessionGraph.css';

export interface SessionGraphProps {
  layout: GraphLayout;
  /** Selected node id (`?node=`). */
  selected: string | null;
  onSelect: (nodeId: string) => void;
  /** Expand / collapse one node's children (session id). */
  onToggle: (sessionId: string) => void;
  /** Node id to bring into view once (the URL's node). */
  focus?: string | null;
  /** Phase 13 slot, forwarded to GraphNode `badge`. */
  renderBadge?: (node: SessionNode) => ReactNode;
  overscan?: number;
}

/**
 * Custom SVG git-graph (no graph library: settled). The scroll container holds a full-height SVG;
 * only rows in the viewport (plus overscan) mount, and only edges crossing them are drawn.
 */
export function SessionGraph({ layout, selected, onSelect, onToggle, focus = null, renderBadge, overscan = OVERSCAN }: SessionGraphProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const focused = useRef<string | null>(null);
  // Bumped once the web fonts load, so titles are re-measured in the real font.
  const [fonts, setFonts] = useState(0);

  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      clearTextWidths();
      setFonts((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom (and a not-yet-laid-out box) reports 0: fall back to the window height.
    const read = () => setHeight(el.clientHeight || window.innerHeight);
    read();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  // Bring the URL's node into view once per node id, as soon as its row exists. Later polls that
  // rebuild the layout do not yank the scroll back.
  useEffect(() => {
    if (focus === null) {
      focused.current = null;
      return;
    }
    if (focused.current === focus) return;
    const hit = layout.byNodeId.get(focus);
    const el = ref.current;
    if (!hit || !el) return;
    focused.current = focus;
    const y = hit.row * ROW_H;
    const view = el.clientHeight || window.innerHeight;
    if (y >= el.scrollTop && y + ROW_H <= el.scrollTop + view) return;
    const target = Math.max(0, y - Math.floor(view / 3));
    el.scrollTop = target;
    setScrollTop(target);
  }, [focus, layout]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop);

  const total = layout.rows.length;
  const { first, last } = visibleRange(scrollTop, height, total, overscan);
  const lx = labelX(layout.lanes);
  const width = useMemo(() => {
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    return graphWidth(layout, (t) => textWidth(t, TITLE_PX, family), (n) => (renderBadge ? filled(renderBadge(n)) : false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fonts` only forces a re-measure
  }, [layout, renderBadge, fonts]);
  const svgH = Math.max(total * ROW_H, ROW_H);
  const rows = last >= first ? layout.rows.slice(first, last + 1) : [];

  return (
    <div ref={ref} className="graph-scroll" onScroll={onScroll}>
      <svg className="graph-svg" width={width} height={svgH} viewBox={`0 0 ${width} ${svgH}`} role="group" aria-label="Session graph">
        <GraphEdges layout={layout} first={first} last={last} />
        {rows.map((laid) => (
          <GraphNode
            key={laid.node.session_id}
            laid={laid}
            x={laneX(laid.lane)}
            y={rowY(laid.row)}
            labelX={lx}
            width={width}
            selected={selected === laid.node.node_id}
            onSelect={onSelect}
            onToggle={onToggle}
            badge={renderBadge ? renderBadge(laid.node) : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
