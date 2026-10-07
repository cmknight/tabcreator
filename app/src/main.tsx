import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './App';
import { instanceLock } from './session/instance-lock';
import { recheckStorageFull } from './storage/persistence';
import { strings } from './ui/strings';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

document.title = strings['global.appName'];

// Dev-only fake microphone (stories US-0.4, 2.2): `?fakeMic=<fixture>[,<fixture>…]`, one device
// per fixture, with test hooks on `window.__fakeMic`. Production builds replace the condition
// with `false`, so this branch, the module and the parameter name tree-shake out.
if (import.meta.env.DEV) {
  const param = new URLSearchParams(window.location.search).get('fakeMic');
  if (param !== null) {
    const fixtures = param
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const { installFakeMic } = await import('./dev/fake-mic');
    window.__fakeMic = installFakeMic(fixtures);
  }
}

// The instance lock is requested before the first render: no screen that can write storage
// mounts until it is held (story 3.10, spine AD-6).
instanceLock.start();

// The storage-full status starts from a re-check of the free space (it lives in memory, so a
// reload would forget a full disk): too little room sets it, room clears it, an unknown estimate
// changes nothing. Read-only, so it needs no lock.
void recheckStorageFull();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
