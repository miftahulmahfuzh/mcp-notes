import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

export function Header({ heading, countLine, last, lastWhen, showSticker, onJumpLast, onAdd }: HeaderProps) {
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {last && (
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
        Drop or paste an image anywhere to make a photo note.
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
