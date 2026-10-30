import { useEffect, useState } from 'react';

interface Tip {
  text: string;
  x: number;
  y: number;
  right: boolean;
}

/** Design: one document-level mouseover; `[data-tip]` above the element, or right of it with data-tip-side="right". */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const target = e.target;
      const el = target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
      if (!el) {
        setTip((t) => (t ? null : t));
        return;
      }
      const r = el.getBoundingClientRect();
      const right = el.dataset.tipSide === 'right';
      setTip({
        text: el.dataset.tip ?? '',
        x: right ? r.right + 8 : r.left + r.width / 2,
        y: right ? r.top + r.height / 2 : r.top - 6,
        right,
      });
    };
    document.addEventListener('mouseover', onOver);
    return () => document.removeEventListener('mouseover', onOver);
  }, []);

  if (!tip || !tip.text) return null;
  return (
    <div
      className="tip"
      style={{ left: tip.x, top: tip.y, transform: tip.right ? 'translateY(-50%)' : 'translate(-50%,-100%)' }}
    >
      {tip.text}
    </div>
  );
}
