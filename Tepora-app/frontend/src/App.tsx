import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ChatInterface from './components/ChatInterface';
import { WebSocketProvider } from './context/WebSocketContext';
import SetupWizard from './components/SetupWizard';
import { useSetup } from './hooks/useSetup';
import './i18n';

function App() {
  const { isSetupComplete, isLoading, checkSetup } = useSetup();

  // Handle splash screen / loading state
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-black text-white">
        <div className="flex flex-col items-center">
            <div className="text-tea-400 animate-pulse text-lg mb-2 font-display tracking-widest">TEPORA SYSTEM</div>
            <div className="h-0.5 w-24 bg-tea-500/50 rounded-full overflow-hidden">
                <div className="h-full bg-tea-400 animate-[shimmer_1s_infinite]"></div>
            </div>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <WebSocketProvider>
        {!isSetupComplete && (
          <SetupWizard
            onComplete={checkSetup}
            // Optional: Allow skipping setup in dev mode or if strictly desired
            // onSkip={() => { /* handle skip logic if needed */ }}
          />
        )}

        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/chat" replace />} />
            <Route path="chat" element={<ChatInterface />} />
            {/* Add more routes here if needed */}
          </Route>
        </Routes>
      </WebSocketProvider>
    </BrowserRouter>
  );
}

export default App;
