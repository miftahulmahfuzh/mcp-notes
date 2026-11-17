import { ArrowsClockwise, Play } from '@phosphor-icons/react';
import type { TrendingListResponse, TrendingTitle } from '../../moviesApi';
import { agoText, magnetQuality, trendingOffText, type TitleMark } from '../../lib/movies';
import { PosterTile } from './PosterTile';

export interface TrendingSectionProps {
  trending: TrendingListResponse | null;
  /** A pass is running now (here or from an earlier click). */
  running: boolean;
  onOpen: (titleId: string) => void;
  onMark: (title: TrendingTitle, patch: TitleMark) => void;
  onRefresh: () => void;
  /** Plays a film from its torrent (a series is opened on its page: it needs an episode). */
  onPlayTorrent: (title: TrendingTitle) => void;
}

/**
 * Trending on torrent indexes: the most seeded films and series the owner has not seen, under the Stream grid. A second,
 * separately labeled section: these titles were never asked to play, so nothing here is "verified to stream". Each poster says
 * how many seeds the index lists and, apart from that, whether opening its swarm showed a live peer, and when.
 */
export function TrendingSection({ trending, running, onOpen, onMark, onRefresh, onPlayTorrent }: TrendingSectionProps) {
  if (trending === null) return null;
  if (!trending.enabled) {
    return (
      <section className="mv-trend mv-content" aria-label="Trending">
        <h2 className="mv-trend-h">Trending on torrents</h2>
        <p className="mv-empty">{trendingOffText(trending.reason)}</p>
      </section>
    );
  }
  // A title marked watched or not interested leaves at the click, before the list is read again.
  const titles = trending.titles.filter((t) => !t.watched && !t.not_interested);
  const confirmed = titles.filter((t) => t.trending.probe?.outcome === 'confirmed').length;
  const refreshTip = running ? 'Building the trending list' : 'Build the trending list again now';
  return (
    <section className="mv-trend mv-content" aria-label="Trending">
      <div className="mv-trend-head">
        <h2 className="mv-trend-h">Trending on torrents</h2>
        <button type="button" className={running ? 'ibtn on mv-spin' : 'ibtn hov'} data-tip={refreshTip} data-tip-side="below" aria-label={refreshTip} aria-busy={running} disabled={running} onClick={onRefresh}>
          <ArrowsClockwise weight="duotone" />
        </button>
      </div>
      <p className="mv-trend-sub">
        Most seeded on the torrent indexes, not seen or marked not interested by you. Seeds are the index&apos;s claim; &ldquo;confirmed&rdquo; means a peer answered when the swarm was opened.
        {trending.listed_at !== null && ` Listed ${agoText(trending.listed_at)}; ${confirmed} of ${titles.length} confirmed.`}
      </p>
      {titles.length === 0 ? (
        <p className="mv-empty">{running ? 'Building the list.' : 'Nothing listed yet: the first list is built a couple of minutes after notesd starts, then once a day.'}</p>
      ) : (
        <div className="mv-grid" role="list" aria-label="Trending posters">
          {titles.map((t) => {
            const q = magnetQuality(t);
            return (
              <div key={t.id} role="listitem" className="mv-trend-cell">
                <PosterTile title={t} side="stream" onOpen={onOpen} onMark={(title, patch) => onMark(t, patch)} />
                <div className="mv-qrow">
                  <span className="mv-q" data-state={q.state} data-tip={q.tip} data-tip-side="below" title={q.tip}>
                    <span className="mv-q-dot" aria-hidden="true" />
                    <span className="mv-q-seeds">{t.trending.seeds.toLocaleString('en-US')}</span>
                    <span className="mv-q-label">{q.label}</span>
                  </span>
                  {t.kind === 'movie' && (
                    <button type="button" className="ibtn hov mv-trend-play" data-tip={`Play ${t.title} from its torrent`} data-tip-side="below" aria-label={`Play ${t.title} from its torrent`} onClick={() => onPlayTorrent(t)}>
                      <Play weight="duotone" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
