import './MessageItem.css';

export interface HistoryToolsProps {
  showDeleted: boolean;
  onToggleDeleted: () => void;
  /** Quiet one-line notice (jump gave up, an action failed); null hides it. */
  notice: string | null;
}

/** The history page header's right side: the quiet notice and the "Show deleted" toggle. */
export function HistoryTools({ showDeleted, onToggleDeleted, notice }: HistoryToolsProps) {
  return (
    <div className="history-tools">
      {notice && (
        <span className="history-notice" role="status">
          {notice}
        </span>
      )}
      <button type="button" className="history-toggle" aria-pressed={showDeleted} onClick={onToggleDeleted}>
        Show deleted
      </button>
    </div>
  );
}
