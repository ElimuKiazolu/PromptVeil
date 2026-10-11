import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import '@/src/ui/theme.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Popup root element is missing');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
