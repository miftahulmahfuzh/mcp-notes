import { useState } from 'react';

export interface PosterProps {
  url: string | null;
  title: string;
  year: number | null;
}

/**
 * A TMDB poster, hotlinked and lazy (posters are shared by both machines; nothing is cached on disk),
 * or a designed tile with the title when TMDB has none or the image fails to load. Key it by `url`
 * at the call site so a new URL gets a fresh try.
 */
export function Poster({ url, title, year }: PosterProps) {
  const [failed, setFailed] = useState(false);
  if (url === null || failed) {
    return (
      <div className="mv-poster mv-fallback" role="img" aria-label={`${title} (no poster)`}>
        <span className="mv-fallback-t">{title}</span>
        {year !== null && <span className="mv-fallback-y">{year}</span>}
      </div>
    );
  }
  return (
    <div className="mv-poster">
      <img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </div>
  );
}
