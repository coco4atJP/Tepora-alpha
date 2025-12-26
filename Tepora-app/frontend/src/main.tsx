import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './i18n';
import { WebSocketProvider } from './context/WebSocketContext';
import { SettingsProvider } from './context/SettingsContext';

import { startSidecar } from './utils/sidecar';

// Start the backend sidecar
startSidecar();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebSocketProvider>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </WebSocketProvider>
  </React.StrictMode>,
)
