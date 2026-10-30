import { useState, type ReactNode } from 'react';
import { ArrowCounterClockwise, Check, Trash, X } from '@phosphor-icons/react';
import type { BinImage, Note } from '../types';
import { DuplicateImageError, purgeImage, purgeNote, restoreImage, restoreNote } from '../api';
import type { BinStore } from '../hooks/useBin';
import { fontSizeFor, letterSpacingFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';
import { galleryTile } from './Gallery';
import './Bin.css';

/** What a bin entry's two actions act on. A tile of a deleted note acts on the note. */
type Target = { kind: 'note' | 'image'; id: string };

const keyOf = (t: Target): string => `${t.kind}:${t.id}`;

const targetOf = (b: BinImage): Target => (b.kind === 'note' ? { kind: 'note', id: b.note_id } : { kind: 'image', id: b.image.id });

interface BinActionsProps {
  what: 'note' | 'image';
  confirming: boolean;
  busy: boolean;
  onRestore: () => void;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Restore + delete forever; delete forever turns the pair into Check (Delete forever) + X (Cancel). Icons only. */
function BinActions({ what, confirming, busy, onRestore, onAsk, onConfirm, onCancel }: BinActionsProps) {
  if (confirming) {
    return (
      <span className="bin-actions" data-confirm="">
        <button type="button" className="copybtn" data-tip="Delete forever" aria-label="Delete forever" disabled={busy} onClick={onConfirm}>
          <Check weight="duotone" />
        </button>
        <button type="button" className="copybtn" data-tip="Cancel" aria-label="Cancel" onClick={onCancel}>
          <X weight="duotone" />
        </button>
      </span>
    );
  }
  return (
    <span className="bin-actions">
      <button type="button" className="copybtn" data-tip={`Restore ${what}`} aria-label={`Restore ${what}`} disabled={busy} onClick={onRestore}>
        <ArrowCounterClockwise weight="duotone" />
      </button>
      <button type="button" className="copybtn" data-tip={`Delete ${what} forever`} aria-label={`Delete ${what} forever`} disabled={busy} onClick={onAsk}>
        <Trash weight="duotone" />
      </button>
    </span>
  );
}

/** A deleted note in wall style: cover + count, read-only text with inert tag chips, id, deleted date, actions. */
function BinCard({ note, now, actions }: { note: Note; now: Date; actions: ReactNode }) {
  const shown = note.images.filter((img) => img.available);
  const n = shown.length;
  const cover = shown[0];
  const fs = fontSizeFor(note.body, n > 0);
  return (
    <article className={n > 0 ? 'card img' : 'card'} data-bin-note={note.id}>
      {cover && (
        <div className="card-cover">
          <NoteImage image={cover} />
          {n > 1 && (
            <span className="card-count" data-count={n}>
              {n}
            </span>
          )}
        </div>
      )}
      <div className="card-body">
        {note.body.trim() !== '' && (
          <p className="card-text bin-text" style={{ fontSize: fs, letterSpacing: letterSpacingFor(fs) }}>
            {segmentBody(note.body).map((s, i) =>
              s.kind === 'tag' ? (
                <span key={i} className="tagchip bin-tag">
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
        <div className="card-meta">
          <span className="card-id">{note.id}</span>
          <span className="card-date">{note.deleted_at ? relativeDate(note.deleted_at, now) : ''}</span>
          {actions}
        </div>
      </div>
    </article>
  );
}

export interface BinProps {
  store: BinStore;
  now: Date;
  /** A note is live again (restore of the note, or of one of its images). App puts it back on the wall. */
  onRestored: (note: Note) => void;
}

/** "Deleted.": image grid (gallery style) on top, deleted-note cards (wall style) below, both newest-deleted first. */
export function Bin({ store, now, onRestored }: BinProps) {
  const { bin, loaded } = store;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});

  const restore = async (t: Target): Promise<void> => {
    const k = keyOf(t);
    setConfirming(null);
    setBusy(k);
    try {
      if (t.kind === 'note') {
        store.dropNote(t.id);
        onRestored(await restoreNote(t.id));
      } else {
        const note = await restoreImage(t.id);
        store.dropImage(t.id);
        onRestored(note);
      }
    } catch (e) {
      if (e instanceof DuplicateImageError) setNotices((m) => ({ ...m, [k]: `already in ${e.noteId}` }));
      else console.error('restore failed', e);
    } finally {
      setBusy(null);
      store.refetch();
    }
  };

  const purge = async (t: Target): Promise<void> => {
    setConfirming(null);
    setBusy(keyOf(t));
    try {
      if (t.kind === 'note') {
        store.dropNote(t.id);
        await purgeNote(t.id);
      } else {
        store.dropImage(t.id);
        await purgeImage(t.id);
      }
    } catch (e) {
      console.error('delete forever failed', e);
    } finally {
      setBusy(null);
      store.refetch();
    }
  };

  const actions = (t: Target): ReactNode => {
    const k = keyOf(t);
    return (
      <BinActions
        what={t.kind}
        confirming={confirming === k}
        busy={busy === k}
        onRestore={() => void restore(t)}
        onAsk={() => setConfirming(k)}
        onConfirm={() => void purge(t)}
        onCancel={() => setConfirming((c) => (c === k ? null : c))}
      />
    );
  };

  const empty = loaded && bin.notes.length === 0 && bin.images.length === 0;

  return (
    <section className="bin" data-bin="">
      {bin.images.some((b) => b.image.available) && (
        <div className="bin-grid">
          {bin.images.filter((b) => b.image.available).map((b) => {
            const t = targetOf(b);
            const g = galleryTile(b.image);
            const notice = notices[keyOf(t)];
            return (
              <div key={b.image.id} className="bin-tile" data-bin-image={b.image.id} data-kind={b.kind} style={{ flex: `${g.grow} 1 ${g.basis}px` }}>
                <NoteImage image={b.image} />
                <div className="card-meta bin-meta">
                  <span className="card-id">{b.note_id}</span>
                  <span>{b.kind}</span>
                  {notice && <span className="bin-notice">{notice}</span>}
                  {actions(t)}
                </div>
              </div>
            );
          })}
          <div className="bin-spacer" />
        </div>
      )}
      {bin.notes.length > 0 && (
        <section className="wall">
          {bin.notes.map((n) => (
            <BinCard key={n.id} note={n} now={now} actions={actions({ kind: 'note', id: n.id })} />
          ))}
        </section>
      )}
      {empty && <p className="bin-empty">Nothing deleted.</p>}
    </section>
  );
}
