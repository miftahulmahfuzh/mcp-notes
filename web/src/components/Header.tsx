import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, onJumpLast, onAdd }: HeaderProps) {
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!bin && last && (
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
        {bin ? 'Restore brings a note or an image back. Delete forever removes it and its files.' : 'Drop or paste an image anywhere to make a photo note.'}
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
