import { useState } from 'react';
import { createPortal } from 'react-dom';
import { LinkSimple } from '@phosphor-icons/react';
import type { UnmatchedFile } from '../../moviesApi';
import { clock, moviesErrorText, reasonText } from '../../lib/movies';
import { AssignDialog } from './AssignDialog';

export interface UnmatchedListProps {
  files: UnmatchedFile[] | null;
  error: string | null;
  onAssigned: (titleId: string | null, name: string) => void;
}

/** `/movies/unmatched`: this machine's files that matched no title, each with its reason and an assign icon. */
export function UnmatchedList({ files, error, onAssigned }: UnmatchedListProps) {
  const [assigning, setAssigning] = useState<UnmatchedFile | null>(null);
  if (error !== null) return <p className="mv-empty mv-content">{moviesErrorText(error)}</p>;
  if (files === null) return <p className="mv-empty mv-content">loading unmatched files</p>;
  if (files.length === 0) return <p className="mv-empty mv-content">Every file on this machine matched a title.</p>;
  return (
    <section className="mv-content" aria-label="Unmatched files">
      <ul className="mv-unm">
        {files.map((f) => (
          <li key={f.id} className="mv-unm-row" data-file={f.id}>
            <span className="mv-unm-main">
              <span className="mv-unm-name">{f.name}</span>
              <span className="mv-unm-path">{f.path}</span>
            </span>
            <span className="mv-chip">{reasonText(f.reason, f.status)}</span>
            <span className="mv-dim">{f.duration_s !== null ? clock(f.duration_s) : ''}</span>
            <button type="button" className="ibtn hov" data-tip="Assign a title" data-tip-side="below" aria-label={`Assign a title to ${f.name}`} onClick={() => setAssigning(f)}>
              <LinkSimple weight="duotone" />
            </button>
          </li>
        ))}
      </ul>
      {assigning !== null &&
        createPortal(
          <AssignDialog
            file={assigning}
            onClose={() => setAssigning(null)}
            onAssigned={(id, name) => {
              setAssigning(null);
              onAssigned(id, name);
            }}
          />,
          document.body,
        )}
    </section>
  );
}
