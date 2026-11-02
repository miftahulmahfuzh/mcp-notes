import { useCallback } from 'react';
import { useHistory } from '../../hooks/useHistory';
import { useNow } from '../../hooks/useNow';
import type { UndoEntry } from '../../hooks/useUndo';
import { ProjectChatHistory } from './ProjectChatHistory';
import { ProjectPillQueryInput } from './ProjectPillQueryInput';
import type { ProjectView } from './ProjectViewToggle';

export interface ProjectChatProps {
  /** The selected repo key. Mount with `key={repo}`: the store is scoped to one project for its life. */
  repo: string;
  view: ProjectView;
  /** A question was sent from the pill: the page switches to the chat view to show the answer streaming. */
  onAsked: () => void;
  pushUndo?: (entry: UndoEntry) => void;
}

/** Graph view: the pill at the bottom. Chat view: the project's chat history (with its own composer). */
export function ProjectChat({ repo, view, onAsked, pushUndo }: ProjectChatProps) {
  const store = useHistory(view === 'chat', { project: repo, includeDeleted: true });
  const now = useNow();
  const { send } = store;
  const ask = useCallback(
    (text: string, imageIds: string[], noteImageIds: string[]): boolean => {
      const ok = noteImageIds.length > 0 ? send(text, imageIds, undefined, noteImageIds) : send(text, imageIds);
      if (ok) onAsked();
      return ok;
    },
    [send, onAsked],
  );
  if (view === 'chat') return <ProjectChatHistory repo={repo} store={store} now={now} pushUndo={pushUndo} />;
  return <ProjectPillQueryInput repo={repo} onSend={ask} />;
}
