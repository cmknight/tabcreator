import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './App';
import { strings } from './ui/strings';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

document.title = strings['global.appName'];

// Dev-only fake microphone (stories US-0.4). Production builds replace the condition with
// `false`, so this branch, the module and the parameter name tree-shake out.
if (import.meta.env.DEV) {
  const fixture = new URLSearchParams(window.location.search).get('fakeMic');
  if (fixture !== null) {
    const { installFakeMic } = await import('./audio/fake-mic');
    installFakeMic(fixture);
  }
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
