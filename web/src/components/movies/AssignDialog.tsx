import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FilmSlate, MagnifyingGlass, Television, X } from '@phosphor-icons/react';
import { assignFile, errorCode, searchTmdb, type AssignBody, type TitleKind, type TmdbHitView, type UnmatchedFile } from '../../moviesApi';
import { Poster } from './Poster';

export interface AssignDialogProps {
  file: UnmatchedFile;
  onClose: () => void;
  /** The server took it: the title it went to (null when the answer did not say) and its name. */
  onAssigned: (titleId: string | null, name: string) => void;
}

function toInt(s: string): number | null {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function guessKind(file: UnmatchedFile): TitleKind {
  const p = file.parsed;
  if (p === null) return 'movie';
  if (p.kind_hint !== null) return p.kind_hint;
  return p.season !== null || p.episode !== null ? 'tv' : 'movie';
}

/**
 * The manual fix (R5.5): search TMDB from the parser's guess, pick a result (a series also takes a
 * season and episode, prefilled from the guess), assign. Esc or the backdrop cancels; Esc never
 * reaches the page or the answer panel behind it.
 */
export function AssignDialog({ file, onClose, onAssigned }: AssignDialogProps) {
  const guess = file.parsed;
  const [q, setQ] = useState(guess !== null && guess.title !== '' ? guess.title : file.name);
  const [kind, setKind] = useState<TitleKind>(() => guessKind(file));
  const [results, setResults] = useState<TmdbHitView[] | null>(null);
  const [picked, setPicked] = useState<TmdbHitView | null>(null);
  const [season, setSeason] = useState(guess !== null && guess.season !== null ? String(guess.season) : '');
  const [episode, setEpisode] = useState(guess !== null && guess.episode !== null ? String(guess.episode) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const search = async (text: string, k: TitleKind) => {
    const query = text.trim();
    if (query === '') return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      const found = await searchTmdb(query, k);
      if (mine === seq.current) setResults(found);
    } catch (e) {
      if (mine === seq.current) {
        setResults(null);
        const code = errorCode(e);
        setError(code === 'tmdb_off' ? 'TMDB credentials are not set on this machine' : `could not search TMDB (${code})`);
      }
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // The guess is searched at once; switching film / series searches the current text again.
  // Only the kind switch re-searches here; typing waits for Enter (the repo runs no hooks lint).
  useEffect(() => {
    void search(q, kind);
  }, [kind]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void search(q, kind);
  };

  const assign = async () => {
    if (picked === null) return;
    let body: AssignBody;
    if (picked.kind === 'tv') {
      const s = toInt(season);
      const ep = toInt(episode);
      body = s !== null && ep !== null ? { kind: 'tv', tmdb_id: picked.tmdb_id, season: s, episode: ep } : { kind: 'tv', tmdb_id: picked.tmdb_id };
    } else {
      body = { kind: 'movie', tmdb_id: picked.tmdb_id };
    }
    setBusy(true);
    setError(null);
    try {
      onAssigned(await assignFile(file.id, body), picked.title);
    } catch (e) {
      setError(`could not assign (${errorCode(e)})`);
      setBusy(false);
    }
  };

  return (
    <div className="mv-dlg" data-modal="assign" onClick={onClose}>
      <div className="mv-dlg-box" role="dialog" aria-modal="true" aria-label={`Assign a title to ${file.name}`} onClick={(e) => e.stopPropagation()}>
        <p className="mv-dlg-file">{file.path}</p>
        <form className="mv-dlg-search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search TMDB" placeholder="Title on TMDB" autoFocus />
          <button type="button" className={kind === 'movie' ? 'ibtn on' : 'ibtn hov'} data-tip="Films" data-tip-side="below" aria-label="Search films" aria-pressed={kind === 'movie'} onClick={() => setKind('movie')}>
            <FilmSlate weight="duotone" />
          </button>
          <button type="button" className={kind === 'tv' ? 'ibtn on' : 'ibtn hov'} data-tip="Series" data-tip-side="below" aria-label="Search series" aria-pressed={kind === 'tv'} onClick={() => setKind('tv')}>
            <Television weight="duotone" />
          </button>
          <button type="submit" className="ibtn hov" data-tip="Search TMDB" data-tip-side="below" aria-label="Search" disabled={busy}>
            <MagnifyingGlass weight="duotone" />
          </button>
        </form>
        {error !== null && (
          <p className="mv-dlg-err" role="alert">
            {error}
          </p>
        )}
        {results !== null && results.length === 0 && <p className="mv-dim">No TMDB match for {q.trim()}.</p>}
        {results !== null && results.length > 0 && (
          <ul className="mv-dlg-results" role="listbox" aria-label="TMDB results">
            {results.map((r) => {
              const on = picked !== null && picked.kind === r.kind && picked.tmdb_id === r.tmdb_id;
              return (
                <li key={`${r.kind}-${r.tmdb_id}`} role="option" aria-selected={on} onClick={() => setPicked(r)}>
                  <Poster key={r.poster_url ?? 'none'} url={r.poster_url} title={r.title} year={r.year} />
                  <span>{r.title}</span>
                  <span className="mv-dim">
                    {[r.year === null ? '' : String(r.year), r.in_library ? 'in library' : ''].filter((s) => s !== '').join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {picked !== null && picked.kind === 'tv' && (
          <div className="mv-dlg-ep">
            <label>
              season
              <input inputMode="numeric" value={season} aria-label="Season" onChange={(e) => setSeason(e.target.value)} />
            </label>
            <label>
              episode
              <input inputMode="numeric" value={episode} aria-label="Episode" onChange={(e) => setEpisode(e.target.value)} />
            </label>
          </div>
        )}
        <div className="mv-dlg-actions">
          <button type="button" className="ibtn hov" data-tip="Cancel" aria-label="Cancel" onClick={onClose}>
            <X weight="duotone" />
          </button>
          <button type="button" className="ibtn on" data-tip="Assign" aria-label="Assign" disabled={picked === null || busy} onClick={() => void assign()}>
            <Check weight="duotone" />
          </button>
        </div>
      </div>
    </div>
  );
}
