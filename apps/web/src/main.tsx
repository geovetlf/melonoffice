import '@melonoffice/ui/styles.css';
import './app.css';
import './office.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
