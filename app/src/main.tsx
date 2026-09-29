import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './App';
import { strings } from './ui/strings';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

document.title = strings['global.appName'];

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
