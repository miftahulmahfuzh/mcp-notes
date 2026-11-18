import { useEffect, useRef, useState } from 'react';
import { CaretDown, Cloud, DownloadSimple, Globe, HardDrives, Magnet } from '@phosphor-icons/react';
import { continueTitle, fetchPahe, playFile, sitePlay, streamPlay, type EpisodeView, type PlayerState, type TitleDetail } from '../../moviesApi';
import { continueNotice, methodDoing, methodErrorText, playErrorText, playMenu, playPlan, primaryFile, startedNotice, STREAM_OPENING_NOTICE, streamErrorText, type PlayMethodItem, type PlayMethodKey } from '../../lib/movies';

export interface PlayMenuProps {
  detail: TitleDetail;
  /** One episode row's menu; null: the title's (a series: the episode its Play carries on with). */
  episode: EpisodeView | null;
  player: PlayerState | null;
  busy: boolean;
  streamEnabled: boolean;
  /** `ibtn` beside the title's Play, `pbtn` in an episode row. */
  size?: 'row' | 'page';
  /** Runs one play: the page shows its notice, or `failed`'s text, and re-reads the title. */
  /** `doing` is what the page says at once, until the play answers (the daemon's own stage replaces it while a stream is being started). */
  onRun: (act: () => Promise<string>, failed: (code: string, detail: string | null) => string, doing: string) => void;
}

/** Whether a play menu is open: its Esc closes the menu, not the pop-up it is in. */
export const isPlayMenuOpen = (): boolean => document.querySelector('.mv-menu-list') !== null;

function MethodIcon({ method }: { method: PlayMethodKey }) {
  if (method === 'file') return <HardDrives weight="duotone" />;
  if (method === 'pahe') return <DownloadSimple weight="duotone" />;
  if (method === 'cloud') return <Cloud weight="duotone" />;
  if (method === 'torrent') return <Magnet weight="duotone" />;
  return <Globe weight="duotone" />;
}

/**
 * The caret beside a Play button: every way the title, or one episode, can be played, chosen by
 * hand. Play itself still goes where the title last played; this names the source instead, the way
 * a watch codename does (DM, NTM, TM), and each row says what it remembers of the title. What
 * plays is remembered per method, so the same choice later goes to the same provider or torrent.
 * Esc and a click outside close it.
 */
export function PlayMenu({ detail: d, episode, player, busy, streamEnabled, size = 'row', onRun }: PlayMenuProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);

  const menu = playMenu(d, episode, player, streamEnabled);
  const what = menu.code === '' ? d.title : menu.code;
  const label = `Choose how to play ${what}`;

  const choose = (item: PlayMethodItem) => {
    setOpen(false);
    const key = item.key;
    const doing = methodDoing(key, item.label);
    const target = menu.target;
    if (key === 'file') {
      const file = episode !== null ? primaryFile(episode) : null;
      const plan = playPlan(d);
      onRun(async () => {
        if (file !== null) return startedNotice(file, await playFile(file.id));
        if (plan.kind === 'file') return startedNotice(plan.file, await playFile(plan.file.id));
        return continueNotice(await continueTitle(d.id));
      }, playErrorText, doing);
      return;
    }
    if (key === 'pahe') {
      // Opened inside the click, so the browser lets it through; its address is set once pahe answered.
      const tab = window.open('about:blank', '_blank');
      onRun(async () => {
        try {
          const found = await fetchPahe(d.id);
          const best = found.matches[0];
          const url = best?.url ?? found.search_url;
          if (url === null || url === undefined) throw new Error('pahe_error');
          if (tab !== null) {
            tab.opener = null;
            tab.location.href = url;
          }
          const where = tab === null ? `allow pop-ups to open it: ${url}` : 'opened in a new tab';
          if (best === undefined) return `pahe.ink lists no ${d.title}; its search page is ${where}`;
          return `${best.title} on pahe.ink, ${where}${found.matches.length > 1 ? ` (the best of ${found.matches.length} releases)` : ''}`;
        } catch (e) {
          tab?.close();
          throw e;
        }
      }, methodErrorText, doing);
      return;
    }
    if (target === null) return;
    if (key === 'cloud' || key === 'torrent') {
      onRun(
        async () => {
          await streamPlay({ ...target.ref, provider: key });
          return `${STREAM_OPENING_NOTICE}${key === 'torrent' ? ', from a torrent' : ', from a cloud provider'}`;
        },
        (code, detail) => (code === 'no_source' ? `no ${key === 'torrent' ? 'torrent' : 'cloud provider'} could stream ${what} now` : streamErrorText(code, detail, target, d.title)),
        doing,
      );
      return;
    }
    onRun(async () => {
      await sitePlay(d.id, key, target.ref.kind === 'tv' ? { season: target.ref.season, episode: target.ref.episode } : null);
      return `Playing ${what} on ${item.label} in the streaming Chrome window`;
    }, methodErrorText, doing);
  };

  return (
    <span className="mv-menu" ref={box}>
      <button
        type="button"
        className={size === 'page' ? 'ibtn hov mv-menu-btn' : 'pbtn hov mv-menu-btn'}
        data-tip={open ? undefined : label}
        data-tip-side={size === 'page' ? 'below' : undefined}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <CaretDown weight="bold" />
      </button>
      {open && (
        <span className={size === 'page' ? 'mv-menu-list' : 'mv-menu-list right'} role="menu" aria-label={`Play ${what} from`}>
          <span className="mv-menu-head">play {what} from</span>
          {menu.items.map((item) => (
            <button key={item.key} type="button" role="menuitem" className={item.last ? 'mv-menu-item last' : 'mv-menu-item'} data-method={item.key} disabled={item.disabled} onClick={() => choose(item)}>
              <MethodIcon method={item.key} />
              <span className="mv-menu-t">
                <span className="mv-menu-label">
                  {item.label}
                  {item.last && <span className="mv-flag">played last</span>}
                </span>
                {item.hint !== null && <span className="mv-menu-hint">{item.hint}</span>}
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
