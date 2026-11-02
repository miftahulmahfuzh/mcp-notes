let ctx: OffscreenCanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

/**
 * Rendered width of `text` in px, measured on an offscreen canvas. Without one (jsdom) it falls back
 * to an estimate of 0.6em per character.
 */
export function textWidth(text: string, px: number, family: string): number {
  const font = `${px}px ${family}`;
  const key = `${font}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) ctx = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
  let w = text.length * px * 0.6;
  if (ctx !== null) {
    ctx.font = font;
    w = ctx.measureText(text).width;
  }
  cache.set(key, w);
  return w;
}

/** Drops measurements taken before the web fonts loaded. */
export function clearTextWidths(): void {
  cache.clear();
}
