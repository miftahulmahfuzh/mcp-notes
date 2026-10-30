import type { CSSProperties } from 'react';

export const DRAG_THRESHOLD = 4;

type Drag = { sx: number; sy: number; ox: number; oy: number; moved: boolean };

export type View = { fit: boolean; x: number; y: number; drag: Drag | null };

export type ViewAction =
  | { type: 'down'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'up' }
  | { type: 'leave' };

export const initialView: View = { fit: true, x: 0, y: 0, drag: null };

export function viewReducer(s: View, a: ViewAction): View {
  switch (a.type) {
    case 'down':
      return { ...s, drag: { sx: a.x, sy: a.y, ox: s.x, oy: s.y, moved: false } };
    case 'move': {
      const d = s.drag;
      if (!d || s.fit) return s;
      const dx = a.x - d.sx;
      const dy = a.y - d.sy;
      if (d.moved || Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        return { ...s, x: d.ox + dx, y: d.oy + dy, drag: { ...d, moved: true } };
      }
      return s;
    }
    case 'up': {
      const d = s.drag;
      if (d && !d.moved) return { fit: !s.fit, x: 0, y: 0, drag: null };
      return { ...s, drag: null };
    }
    case 'leave':
      return s.drag ? { ...s, drag: null } : s;
  }
}

export type Natural = { w: number; h: number } | null;

export function imgStyleFor(v: View, natural: Natural, dpr: number): CSSProperties {
  if (v.fit) {
    return { position: 'absolute', inset: 0, margin: 'auto', maxWidth: '100%', maxHeight: '100%', display: 'block' };
  }
  const ratio = dpr > 0 ? dpr : 1;
  const size: CSSProperties = natural ? { width: natural.w / ratio, height: natural.h / ratio } : {};
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    maxWidth: 'none',
    maxHeight: 'none',
    display: 'block',
    ...size,
    transform: `translate(calc(-50% + ${v.x}px), calc(-50% + ${v.y}px))`,
  };
}

export function cursorFor(v: View): string {
  if (v.fit) return 'zoom-in';
  return v.drag && v.drag.moved ? 'grabbing' : 'grab';
}
