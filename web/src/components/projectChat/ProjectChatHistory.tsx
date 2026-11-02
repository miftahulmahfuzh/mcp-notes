import type { HistoryStore } from '../../hooks/useHistory';
import type { UndoEntry } from '../../hooks/useUndo';
import { HistoryPage } from '../../pages/HistoryPage';
import { projectPlaceholder } from './ProjectPillQueryInput';
import './ProjectChat.css';

export interface ProjectChatHistoryProps {
  repo: string;
  /** A `useHistory` store created with `{ project: repo }`. */
  store: HistoryStore;
  now: Date;
  /** App's undo store, when the page has one; without it bubble deletes have no undo bar. */
  pushUndo?: (entry: UndoEntry) => void;
}

/**
 * `project-chat-history`: the history page (bubbles, edit/delete/restore, replies, its own composer)
 * fed by a store scoped to one project, so it lists only that project's threads.
 */
export function ProjectChatHistory({ repo, store, now, pushUndo }: ProjectChatHistoryProps) {
  return (
    <div className="project-chat-history" data-testid="project-chat-history" data-project={repo}>
      <HistoryPage store={store} focusThread={null} now={now} pushUndo={pushUndo} placeholder={projectPlaceholder(repo)} />
    </div>
  );
}
