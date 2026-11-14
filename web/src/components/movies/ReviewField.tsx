import { useEffect, useRef, useState } from 'react';
import { errorCode, saveTitleUser } from '../../moviesApi';

export interface ReviewFieldProps {
  titleId: string;
  /** The server's review text ('' when none). */
  saved: string;
  onSaved: () => void;
  onNotice: (text: string) => void;
}

/**
 * The review: one text field, saved when it loses focus and only when the text changed. Phase 4
 * stores it as a normal note linked to the title (search, revisions and /n come with it). A server
 * update never overwrites what the owner is typing.
 */
export function ReviewField({ titleId, saved, onSaved, onNotice }: ReviewFieldProps) {
  const [draft, setDraft] = useState(saved);
  const focused = useRef(false);
  const last = useRef(saved);

  useEffect(() => {
    last.current = saved;
    if (!focused.current) setDraft(saved);
  }, [saved]);

  const commit = async () => {
    focused.current = false;
    if (draft === last.current) return;
    const text = draft;
    try {
      await saveTitleUser(titleId, { review: text });
      last.current = text;
      onNotice('review saved');
    } catch (e) {
      onNotice(`could not save the review (${errorCode(e)})`);
    } finally {
      onSaved();
    }
  };

  return (
    <label className="mv-review">
      <span className="mv-label">Review</span>
      <textarea
        value={draft}
        rows={3}
        aria-label="Review"
        placeholder="What did you think? Saved as a note when you leave the field."
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
      />
    </label>
  );
}
