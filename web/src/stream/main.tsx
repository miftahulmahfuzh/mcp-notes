import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/host-grotesk';
import '@fontsource/geist-mono/400.css';
import './stream.css';
import { StreamApp } from './StreamApp';
import { mutedFromLocation, sessionIdFromLocation } from './session';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StreamApp sessionId={sessionIdFromLocation(window.location)} muted={mutedFromLocation(window.location)} />
    </StrictMode>,
  );
}
