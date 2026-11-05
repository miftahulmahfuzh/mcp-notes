import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { PILL_PLACEHOLDER } from '../../lib/adversary';
import { ChatBar } from '../ChatBar';

export interface AdversaryPillProps {
  /** Sends one question through the wall's chat (App wraps it with the page context). */
  onAsk: (text: string, imageIds: string[]) => void;
}

/**
 * "Ask about Seer Adversarial": the dark pill pinned to the bottom of the page, ChatBar's page
 * variant with its own draft (the pattern of projectChat/ProjectPillQueryInput). The answer shows in
 * the wall's answer panel, which stays visible on this page.
 */
export function AdversaryPill({ onAsk }: AdversaryPillProps) {
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
    <div className="adv-pill" data-testid="adversary-pill">
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={PILL_PLACEHOLDER}
      />
    </div>
  );
}
