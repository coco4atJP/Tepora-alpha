import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './i18n';
import { WebSocketProvider } from './context/WebSocketContext';
import { SettingsProvider } from './context/SettingsContext';

import { startSidecar, backendReady, isDesktop } from './utils/sidecar';

// Start the backend sidecar and wait for it before mounting React
async function init() {
  // Start sidecar (non-blocking)
  startSidecar();

  // Wait for backend to be ready (with timeout)
  if (isDesktop()) {
    try {
      await Promise.race([
        backendReady,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Backend startup timeout')), 30000)
        )
      ]);
      console.log('[Main] Backend is ready, mounting React app');
    } catch (error) {
      console.warn('[Main] Backend startup issue:', error);
      // Continue anyway - App will handle connection errors
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <WebSocketProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </WebSocketProvider>
    </React.StrictMode>,
  )
}

init();
