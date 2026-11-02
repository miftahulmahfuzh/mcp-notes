import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { ChatBar } from '../ChatBar';
import './ProjectChat.css';

/** Placeholder (and accessible name) of the project composer. */
export function projectPlaceholder(repo: string): string {
  return `Ask about ${repo}`;
}

export interface ProjectPillQueryInputProps {
  /** The selected repo key; named in the placeholder. */
  repo: string;
  /**
   * Sends one question in this project (the project store's `send`). False when refused (blank, or a
   * reply still streaming): the draft is kept.
   */
  onSend: (text: string, imageIds: string[], noteImageIds: string[]) => boolean;
}

/**
 * `project-pill-query-input`: the dark chat pill pinned to the bottom of the Projects page while the
 * graph is shown. Same ChatBar (page variant) and paste-an-image flow as the history composer, with
 * its own draft, so the wall bar's draft is untouched.
 */
export function ProjectPillQueryInput({ repo, onSend }: ProjectPillQueryInputProps) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (images.blocked) return;
    const ids = images.readyIds;
    const noteIds = images.noteIds;
    if (!draft.trim() && ids.length === 0 && noteIds.length === 0) return;
    if (onSend(draft, ids, noteIds)) {
      setDraft('');
      images.clear();
    }
  };
  return (
    <div className="project-pill-query-input" data-testid="project-pill-query-input" data-project={repo}>
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={projectPlaceholder(repo)}
      />
    </div>
  );
}
