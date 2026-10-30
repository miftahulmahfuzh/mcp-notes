import '@fontsource-variable/host-grotesk';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
