import { useEffect, useState, type ReactNode } from 'react';
import { ArrowSquareOut, CalendarBlank, Cloud, Globe, HardDrives, Heartbeat, MagnetStraight, Warning } from '@phosphor-icons/react';
import { relativeDate } from '../../lib/dates';
import { errorCode, fetchStreamHealth, type HealthFailure, type HealthFigures, type HealthPlay, type HealthSource, type HealthUnhandled, type StreamHealth } from '../../moviesApi';
import './CachePage.css';
import './HealthPage.css';

/** The periods the page offers, in days. */
export const HEALTH_DAYS = [7, 30, 90] as const;
/** How often the page reads the log again while it is visible. */
export const HEALTH_REFRESH_MS = 30_000;

const CHANNEL_ORDER = ['all', 'torrent', 'cloud', 'cache', 'site', 'none'];
const CHANNEL_NAME: Record<string, string> = { all: 'Every ask', torrent: 'Torrents', cloud: 'Cloud', cache: 'From disk', site: 'Streaming sites', none: 'No source named' };

function channelIcon(channel: string | null): ReactNode {
  switch (channel) {
    case 'all':
      return <Heartbeat weight="duotone" />;
    case 'torrent':
      return <MagnetStraight weight="duotone" />;
    case 'cloud':
      return <Cloud weight="duotone" />;
    case 'cache':
      return <HardDrives weight="duotone" />;
    case 'site':
      return <Globe weight="duotone" />;
    default:
      return <Warning weight="duotone" />;
  }
}

/**
 * An outcome word in the owner's words: what was missing. Every word phase 1 writes is named (its `failure`:
 * DirectStreamErrorCode, CachePlayErrorCode, `error`; its `cloud_failure`/`torrent_failure`: ResolveOutcome and
 * `no_source`, `resolve_failed`, `torrent_off`); an unknown word falls back to itself with spaces.
 */
export function failureText(word: string, channel: string | null): string {
  switch (word) {
    case 'no_source':
    case 'no_stream':
      return channel === 'torrent' ? 'no torrent found' : channel === 'cloud' ? 'no cloud source' : 'no source';
    case 'resolved':
      return 'found, did not play';
    case 'bot_check':
      return 'bot check';
    case 'dubbed':
      return 'dub only';
    case 'unplayable':
      return 'file Chrome cannot play';
    case 'error':
      return 'error';
    case 'skipped':
    case 'skipped_browser_only':
    case 'skipped_no_template':
      return 'not tried';
    case 'torrent_off':
      return 'torrents off';
    case 'resolve_failed':
      return 'resolver failed';
    case 'open_failed':
      return 'player did not open';
    case 'bad_info_hash':
      return 'bad magnet';
    case 'no_episode':
      return 'no such episode';
    case 'no_subtitle':
      return 'no subtitle';
    case 'unknown_session':
      return 'session gone';
    case 'not_on_this_machine':
      return 'cache on the other machine';
    case 'cache_failed':
      return 'cache broken';
    case 'cache_language':
      return 'cache is a dub';
    default:
      return word.replace(/_/g, ' ');
  }
}

/** "2.4 s", "38 s", or a dash for nothing measured. */
export function seconds(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function percent(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Severance S02E03", or the film's name. */
export function playLabel(p: { title: string; season: number | null; episode: number | null }): string {
  return p.season !== null && p.episode !== null ? `${p.title} S${pad(p.season)}E${pad(p.episode)}` : p.title;
}

/** How a play ended, in words. A short play that reached the screen is never called a failure. */
export function endedText(p: HealthPlay): string {
  if (p.outcome === 'failed') return p.failure === null ? 'failed' : `failed · ${failureText(p.failure, p.channel)}`;
  // A session whose page has not reported yet may still be loading: it is not called a failure until it ended.
  if (p.outcome === 'no_picture') return p.ended === null ? 'no picture yet' : 'no picture';
  if (p.outcome === 'site') return 'played on a site';
  switch (p.ended) {
    case null:
      return 'playing';
    case 'finished':
      return 'finished';
    case 'closed':
      return 'closed';
    case 'replaced':
      return 'replaced by another play';
    case 'expired':
      return 'session expired';
    case 'restart':
      return 'daemon restarted';
    default:
      return p.ended;
  }
}

function stallsText(p: HealthPlay): string {
  if (p.outcome === 'failed') return '—';
  const n = `${p.stalls} ${p.stalls === 1 ? 'stall' : 'stalls'}`;
  return p.stalled_ms > 0 ? `${n} · ${seconds(p.stalled_ms)}` : n;
}

function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <span className="hp-stat" data-tip={tip}>
      <span className="hp-stat-v">{value}</span>
      <span className="hp-stat-l">{label}</span>
    </span>
  );
}

function FigureRow({ icon, name, f, sub = false }: { icon: ReactNode; name: string; f: HealthFigures; sub?: boolean }) {
  return (
    <div className={sub ? 'hp-row hp-sub' : 'hp-row'} data-testid={sub ? undefined : `hp-channel-${name}`}>
      <span className="hp-icon">{icon}</span>
      <span className="hp-name">{name}</span>
      <Stat label="started" value={`${f.played}/${f.asks}`} tip="Asks that reached the screen, of every ask. A short play counts: it started." />
      <Stat label="success" value={percent(f.success_rate)} tip="Share of the asks that reached the screen" />
      <Stat label="first frame" value={seconds(f.median_first_frame_ms)} tip="Median time from the player page's load to the first frame" />
      <Stat label="to answer" value={seconds(f.median_resolve_ms)} tip="Median time from the ask to a player" />
      <Stat label="stalls / h" value={f.stalls_per_hour === null ? '—' : f.stalls_per_hour.toFixed(1)} tip="Stalls per hour played" />
      <Stat label="1080p" value={percent(f.hd_share)} tip="Share of the plays at 1080p or better" />
      <Stat label="stood still" value={f.stalled_share === null ? '—' : `${(f.stalled_share * 100).toFixed(1)}%`} tip="Time the film stood still in a stall, per time played" />
      <Stat label="no picture" value={String(f.no_picture)} tip="Asks answered with a player whose page never showed the film" />
    </div>
  );
}

function FailureChips({ failures }: { failures: HealthFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <div className="hp-fails">
      {failures.map((f) => (
        <span key={`${f.channel}:${f.failure}`} className="mv-chip hp-tag" data-tip={`${f.count} failed ${f.count === 1 ? 'ask' : 'asks'}: ${failureText(f.failure, f.channel)}`}>
          {failureText(f.failure, f.channel)} ×{f.count}
        </span>
      ))}
    </div>
  );
}

function OpenButton({ id, label, onOpen }: { id: string | null; label: string; onOpen: (id: string) => void }) {
  if (id === null) return <span className="cp-btn-gap" />;
  return (
    <button type="button" className="ibtn hov" data-tip="Go to the title page" aria-label={`Open ${label}`} onClick={() => onOpen(id)}>
      <ArrowSquareOut weight="duotone" />
    </button>
  );
}

function UnhandledRow({ u, now, onOpen }: { u: HealthUnhandled; now: Date; onOpen: (id: string) => void }) {
  const label = playLabel(u);
  return (
    <li className="hp-item" data-unhandled={label}>
      <div className="hp-row">
        <span className="hp-icon">
          <Warning weight="duotone" />
        </span>
        <span className="hp-name">{label}</span>
        <span className="mv-chip hp-tag hp-why" data-tip="What the cloud providers last answered">
          <Cloud weight="duotone" /> {u.cloud_failure === null ? 'not asked' : failureText(u.cloud_failure, 'cloud')}
        </span>
        <span className="mv-chip hp-tag hp-why" data-tip="What the torrents last answered">
          <MagnetStraight weight="duotone" /> {u.torrent_failure === null ? 'not asked' : failureText(u.torrent_failure, 'torrent')}
        </span>
        <span className="hp-when">
          {u.asks} {u.asks === 1 ? 'ask' : 'asks'} · {relativeDate(u.last_asked_at, now, true)}
        </span>
        <OpenButton id={u.movie_id} label={label} onOpen={onOpen} />
      </div>
    </li>
  );
}

function PlayRow({ p, now, onOpen }: { p: HealthPlay; now: Date; onOpen: (id: string) => void }) {
  const label = playLabel(p);
  return (
    <li className="hp-item" data-outcome={p.outcome}>
      <div className="hp-row">
        <span className="hp-icon">{channelIcon(p.channel)}</span>
        <span className="hp-name">{label}</span>
        <span className="mv-chip hp-tag">{p.source ?? (p.channel === null ? 'no source' : (CHANNEL_NAME[p.channel] ?? p.channel))}</span>
        <span className="hp-num" data-tip="Height that played">{p.height === null ? '—' : `${p.height}p`}</span>
        <span className="hp-num" data-tip="First frame">{seconds(p.first_frame_ms)}</span>
        <span className="hp-num hp-wide" data-tip="Stalls, and how long the film stood still">{stallsText(p)}</span>
        <span className="hp-ended">{endedText(p)}</span>
        <span className="hp-when">{relativeDate(p.asked_at, now, true)}</span>
        <OpenButton id={p.movie_id} label={label} onOpen={onOpen} />
      </div>
    </li>
  );
}

export interface HealthPageProps {
  /** Open a title's page on the Stream side. */
  onOpen: (id: string) => void;
}

/**
 * The Stream health page (`/movies/health`): how direct-stream plays went on this machine, from the play log.
 * Start success, first frame, stalls and the share at 1080p lead, per channel and per torrent index or cloud provider;
 * a short play is a play. Then the films and episodes that could not be played (all time) and the latest plays.
 */
export function HealthPage({ onOpen }: HealthPageProps) {
  const [days, setDays] = useState<number>(HEALTH_DAYS[0]);
  const [health, setHealth] = useState<StreamHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One period's reads: aborted when the period changes, so an older answer or error never lands on the new one.
    const stop = new AbortController();
    // An error of the previous period is not this one's.
    setError(null);
    const load = async (): Promise<void> => {
      try {
        const next = await fetchStreamHealth(days, stop.signal);
        if (stop.signal.aborted) return;
        setHealth(next);
        setError(null);
      } catch (e) {
        if (!stop.signal.aborted) setError(errorCode(e));
      }
    };
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, HEALTH_REFRESH_MS);
    return () => {
      stop.abort();
      window.clearInterval(t);
    };
  }, [days]);

  const now = new Date();
  let body: ReactNode;
  if (error !== null) body = <p className="mv-empty">{error === 'direct_stream_off' ? 'The movie library is off on this machine, so nothing is streamed or logged.' : `Could not read the play log (${error}).`}</p>;
  else if (health === null || health.days !== days) body = <p className="mv-empty">reading the play log</p>;
  else {
    const nothing = (health.totals.all?.asks ?? 0) === 0;
    const channels = CHANNEL_ORDER.filter((c) => health.totals[c] !== undefined && (c === 'all' || c === 'torrent' || c === 'cloud' || health.totals[c]!.asks > 0));
    const sourcesOf = (c: string): HealthSource[] => health.by_source.filter((s) => s.channel === c);
    body = (
      <>
        {nothing ? (
          <p className="mv-empty" data-testid="hp-nothing">
            Nothing was played in the last {days} days.
          </p>
        ) : (
          <>
            <h3 className="hp-label">By channel</h3>
            <ul className="hp-list" aria-label="Channels">
              {channels.map((c) => (
                <li key={c} className="hp-item" data-channel={c}>
                  <FigureRow icon={channelIcon(c)} name={CHANNEL_NAME[c] ?? c} f={health.totals[c]!} />
                  {c !== 'all' && sourcesOf(c).length > 0 && (
                    <ul className="hp-sources" aria-label={`${CHANNEL_NAME[c] ?? c} sources`}>
                      {sourcesOf(c).map((s) => (
                        <li key={s.source} data-source={s.source}>
                          <FigureRow icon={<span className="hp-dot" />} name={s.source} f={s} sub />
                        </li>
                      ))}
                    </ul>
                  )}
                  {c !== 'all' && <FailureChips failures={health.failures.filter((f) => f.channel === c)} />}
                </li>
              ))}
            </ul>
          </>
        )}
        {health.unhandled.length > 0 && (
          <>
            <h3 className="hp-label">Could not be played</h3>
            <ul className="hp-list" aria-label="Could not be played">
              {health.unhandled.map((u) => (
                <UnhandledRow key={`${u.kind}-${u.tmdb_id}-${u.season ?? ''}-${u.episode ?? ''}`} u={u} now={now} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}
        {!nothing && (
          <>
            <h3 className="hp-label">Latest plays</h3>
            <ul className="hp-list" aria-label="Latest plays">
              {health.recent.map((p) => (
                <PlayRow key={p.id} p={p} now={now} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  const since = health?.first_logged_at ?? null;
  return (
    <section className="hp mv-content" aria-label="Stream health">
      <div className="cp-head">
        <span className="cp-total" data-testid="hp-period">
          Last {days} days{since === null ? ' · nothing logged yet' : ` · logged since ${relativeDate(since, now, true)}`}
        </span>
        <div className="cp-bulk" role="group" aria-label="Period">
          {HEALTH_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === days ? 'ibtn on cp-bulkbtn' : 'ibtn hov cp-bulkbtn'}
              data-tip={`The last ${d} days`}
              data-tip-side="below"
              aria-label={`Last ${d} days`}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              <CalendarBlank weight="duotone" />
              <span className="cp-n">{d}</span>
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}
