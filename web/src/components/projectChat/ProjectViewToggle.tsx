import { ChatsCircle, Graph } from '@phosphor-icons/react';
import './ProjectChat.css';

/** What the Projects page body shows: the session graph or the project's chat history. */
export type ProjectView = 'graph' | 'chat';

export interface ProjectViewToggleProps {
  view: ProjectView;
  onToggle: (next: ProjectView) => void;
}

/** Icon-only header button: shows the icon of the view it switches to, named by its tooltip. */
export function ProjectViewToggle({ view, onToggle }: ProjectViewToggleProps) {
  const toChat = view === 'graph';
  const label = toChat ? 'Project chat history' : 'Session graph';
  return (
    <button
      type="button"
      className="project-view-toggle"
      data-testid="project-view-toggle"
      data-view={view}
      aria-label={label}
      data-tip={label}
      onClick={() => onToggle(toChat ? 'chat' : 'graph')}
    >
      {toChat ? <ChatsCircle weight="duotone" /> : <Graph weight="duotone" />}
    </button>
  );
}
