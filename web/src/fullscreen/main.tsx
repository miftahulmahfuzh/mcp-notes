import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist-mono/400.css';
import { FullscreenApp, idFromLocation } from './FullscreenApp';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <FullscreenApp id={idFromLocation(window.location)} />
    </StrictMode>,
  );
}
