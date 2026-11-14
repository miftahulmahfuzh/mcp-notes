import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { MOVIES_PILL_PLACEHOLDER } from '../../lib/movies';
import { ChatBar } from '../ChatBar';

export interface MoviesPillProps {
  /** Sends one question through the wall's chat (App wraps it with the page context). */
  onAsk: (text: string, imageIds: string[]) => void;
}

/** "Ask about your movies": ChatBar's page variant with its own draft, as AdversaryPill. The answer shows in the wall's answer panel over the page. */
export function MoviesPill({ onAsk }: MoviesPillProps) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (images.blocked) return;
    const ids = images.readyIds;
    if (!draft.trim() && ids.length === 0) return;
    onAsk(draft, ids);
    setDraft('');
    images.clear();
  };
  return (
    <div className="mv-pill" data-testid="movies-pill">
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={MOVIES_PILL_PLACEHOLDER}
      />
    </div>
  );
}
