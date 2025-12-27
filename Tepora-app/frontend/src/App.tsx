import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, createBrowserRouter, createRoutesFromElements, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import ChatInterface from './components/ChatInterface';
import Logs from './pages/Logs';
import Memory from './pages/Memory';
import SetupWizard from './components/SetupWizard';
import { getApiBase, getAuthHeaders } from './utils/api';

// Fetch with timeout
const fetchWithTimeout = async (url: string, timeoutMs: number = 10000): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { ...getAuthHeaders() }
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

// ルーターをコンポーネント外で一度だけ作成
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<Layout />}>
      <Route index element={<ChatInterface />} />
      <Route path="logs" element={<Logs />} />
      <Route path="memory" element={<Memory />} />
      <Route path="*" element={<ChatInterface />} />
    </Route>
  ),
  {
    future: {
      v7_startTransition: true,
      v7_relativeSplatPath: true,
    },
  }
);

type AppState = 'loading' | 'error' | 'setup' | 'ready';

function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);

  const { t, i18n } = useTranslation();

  const initApp = useCallback(async () => {
    setAppState('loading');
    setErrorMessage('');

    try {
      // 1. Check requirements with timeout
      const reqResponse = await fetchWithTimeout(`${getApiBase()}/api/setup/requirements`, 10000);
      if (reqResponse.ok) {
        const data = await reqResponse.json();
        if (!data.is_ready) {
          setAppState('setup');
          return;
        }
      } else {
        setAppState('setup');
        return;
      }

      // 2. Load language setting (non-critical, don't fail if this fails)
      try {
        const configResponse = await fetchWithTimeout(`${getApiBase()}/api/config`, 5000);
        if (configResponse.ok) {
          const config = await configResponse.json();
          if (config.language && config.language !== i18n.language) {
            i18n.changeLanguage(config.language);
          }
        }
      } catch (e) {
        console.warn("Failed to load language config:", e);
      }

      setAppState('ready');
    } catch (error) {
      console.error("Initialization error:", error);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setErrorMessage(t('errors.connectionTimeout', 'Connection timed out. Please ensure the backend server is running.'));
        } else {
          setErrorMessage(error.message || t('errors.connectionFailed', 'Failed to connect to the server.'));
        }
      } else {
        setErrorMessage(t('errors.unknownError', 'An unknown error occurred.'));
      }
      setAppState('error');
    }
  }, [i18n, t]);

  useEffect(() => {
    initApp();
  }, [initApp, retryCount]);

  const handleRetry = () => {
    setRetryCount(prev => prev + 1);
  };

  // ローディング中
  if (appState === 'loading') {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="text-gold-400 animate-pulse text-lg mb-2">
            {t('app.loading', 'Connecting to server...')}
          </div>
          <div className="text-gray-500 text-sm">
            {t('app.loadingHint', 'This may take a few seconds')}
          </div>
        </div>
      </div>
    );
  }

  // エラー状態
  if (appState === 'error') {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-950">
        <div className="text-center max-w-md px-6">
          <div className="text-red-400 text-6xl mb-4" aria-hidden="true">⚠</div>
          <h1 className="text-white text-xl font-semibold mb-2">
            {t('errors.connectionErrorTitle', 'Connection Error')}
          </h1>
          <p className="text-gray-400 mb-6" role="alert">
            {errorMessage}
          </p>
          <div className="space-y-3">
            <button
              onClick={handleRetry}
              className="w-full px-6 py-3 bg-gold-500 hover:bg-gold-600 text-black font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-gold-400 focus:ring-offset-2 focus:ring-offset-gray-950"
              aria-label={t('errors.retryButton', 'Retry connection')}
            >
              {t('errors.retryButton', 'Retry Connection')}
            </button>
            <p className="text-gray-500 text-sm">
              {t('errors.troubleshootHint', 'Make sure the backend server is running on the expected port.')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // セットアップが必要
  if (appState === 'setup') {
    return (
      <SetupWizard
        onComplete={() => setAppState('ready')}
        onSkip={() => setAppState('ready')}
      />
    );
  }

  return <RouterProvider router={router} />;
}

export default App;
