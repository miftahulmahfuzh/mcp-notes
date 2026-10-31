import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';
import { HISTORY_HINT } from '../lib/timeline';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  /** The chat history page is showing (phase 9): no "Last edited" link, and the hint explains the page. */
  history?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

const WALL_HINT = 'Drop or paste an image anywhere to make a photo note.';
const BIN_HINT = 'Restore brings a note or an image back. Delete forever removes it and its files.';

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : WALL_HINT;
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!bin && !history && last && (
          <>
            {' '}Last edited{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpLast();
              }}
            >
              {last.id}
            </a>{' '}
            {lastWhen}.
          </>
        )}{' '}
        {hint}
      </p>
      <h1>{heading}</h1>
      {showSticker && (
        <button type="button" className="sticker" data-tip="New note" aria-label="New note" onClick={onAdd}>
          <Plus weight="duotone" />
        </button>
      )}
    </header>
  );
}
