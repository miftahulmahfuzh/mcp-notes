import { useEffect, useReducer, useState } from 'react';
import { imageInfoUrl, imageUrl } from '../api';
import { ImagePlaceholder, aspectOf } from '../components/NoteImage';
import { cursorFor, imgStyleFor, initialView, viewReducer, type Natural } from './view';

/** The image id from `/full/<imageId>` (or `?id=`). */
export function idFromLocation(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const m = /^\/full\/([^/]+)\/?$/.exec(loc.pathname);
  if (m) return decodeURIComponent(m[1]);
  const q = new URLSearchParams(loc.search).get('id');
  return q && q.trim() ? q.trim() : null;
}

export type Missing = { caption: string; host: string | null; w: number; h: number };

/** Why the display image did not load, plus the image's aspect ratio when it can be read. */
export async function describeMissing(id: string, fetchImpl: typeof fetch = fetch): Promise<Missing> {
  let caption = 'unavailable';
  let host: string | null = null;
  try {
    const res = await fetchImpl(imageUrl(id, 'display'));
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: unknown; host?: unknown } | null;
      if (body && body.error === 'not_on_this_machine') {
        caption = 'not on this machine';
        host = typeof body.host === 'string' && body.host ? body.host : null;
      } else {
        caption = 'not found';
      }
    }
  } catch {
    // network error: keep 'unavailable'
  }
  let dims = aspectOf(null);
  try {
    const res = await fetchImpl(imageInfoUrl(id));
    if (res.ok) {
      const json = (await res.json()) as { width?: unknown; height?: unknown } | null;
      if (json && typeof json.width === 'number' && typeof json.height === 'number') {
        dims = aspectOf({ width: json.width, height: json.height });
      }
    }
  } catch {
    // keep the 3:2 fallback
  }
  return { caption, host, w: dims.w, h: dims.h };
}

export function FullscreenApp({ id }: { id: string | null }) {
  const [view, dispatch] = useReducer(viewReducer, initialView);
  const [natural, setNatural] = useState<Natural>(null);
  const [missing, setMissing] = useState<Missing | null>(
    id === null ? { caption: 'not found', host: null, w: 3, h: 2 } : null,
  );

  useEffect(() => {
    document.title = id ?? 'Image';
  }, [id]);

  const onError = () => {
    if (id === null) return;
    void describeMissing(id).then(setMissing);
  };

  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

  return (
    <div
      data-fullscreen=""
      onMouseDown={(e) => dispatch({ type: 'down', x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => dispatch({ type: 'move', x: e.clientX, y: e.clientY })}
      onMouseUp={() => dispatch({ type: 'up' })}
      onMouseLeave={() => dispatch({ type: 'leave' })}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
        cursor: missing ? 'default' : cursorFor(view),
        userSelect: 'none',
      }}
    >
      {missing ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <ImagePlaceholder
            aspect={`${missing.w} / ${missing.h}`}
            caption={missing.caption}
            host={missing.host}
            width={`min(100vw, calc(100vh * ${(missing.w / missing.h).toFixed(4)}))`}
          />
        </div>
      ) : id !== null ? (
        <img
          src={imageUrl(id, 'display')}
          alt=""
          draggable={false}
          data-fit={view.fit ? 'fit' : 'actual'}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={onError}
          style={imgStyleFor(view, natural, dpr)}
        />
      ) : null}
    </div>
  );
}
