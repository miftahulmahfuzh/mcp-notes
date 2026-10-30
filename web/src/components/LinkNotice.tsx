import './LinkNotice.css';

export interface LinkNoticeProps {
  /** e.g. "no note Z-Z99"; null hides it. */
  text: string | null;
}

/** The deep link's quiet status line, top right (the undo line owns the bottom right). */
export function LinkNotice({ text }: LinkNoticeProps) {
  if (!text) return null;
  return (
    <div className="link-notice" role="status" data-link-notice="">
      {text}
    </div>
  );
}
