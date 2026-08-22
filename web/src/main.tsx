import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/theme.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { useSession } from './store/session';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// Started here rather than from an effect: StrictMode runs effects twice in development,
// and this one spends a wrapped key. It is a no-op unless the store began in `resuming`.
void useSession.getState().resume();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
