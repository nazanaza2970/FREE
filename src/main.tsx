import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initApiBase } from './api';
import './styles/index.css';

// On desktop the Rust core hands us the loopback API URL (and, on first run,
// the bootstrap token) before anything may talk to the network.
await initApiBase();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
