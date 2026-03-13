import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createBrowserRouter,
	createRoutesFromElements,
	Route,
	RouterProvider,
} from "react-router-dom";
import { ToastProvider } from "./context/ToastContext";
import ChatInterface from "./features/chat/ChatInterface";
import Layout from "./features/navigation/Layout";
import SetupWizard from "./features/settings/components/SetupWizard";
import { useRequirements, useServerConfig } from "./hooks/useServerConfig";
import Logs from "./pages/Logs";
import Memory from "./pages/Memory";
import { useWebSocketStore } from "./stores";

// ルーターをコンポーネント外で一度だけ作成
const router = createBrowserRouter(
	createRoutesFromElements(
		<Route path="/" element={<Layout />}>
			<Route index element={<ChatInterface />} />
			<Route path="logs" element={<Logs />} />
			<Route path="memory" element={<Memory />} />
			<Route path="*" element={<ChatInterface />} />
		</Route>,
	),
	{
		future: {
			v7_startTransition: true,
			v7_relativeSplatPath: true,
		},
	},
);

function App() {
	const { t, i18n } = useTranslation();
	const [isSkipped, setIsSkipped] = useState(false);

	// Manage WebSocket lifecycle explicitly (avoid import-time side effects)
	useEffect(() => {
		const { connect, disconnect } = useWebSocketStore.getState();
		connect();
		return () => disconnect();
	}, []);

	const {
		data: requirements,
		isLoading: reqLoading,
		isError: reqError,
		error: reqErrorObj,
		refetch: refetchRequirements,
	} = useRequirements();

	const { data: config, refetch: refetchConfig } = useServerConfig();

	// Load backend language setting
	useEffect(() => {
		// Only sync if setup is completed to avoid overriding SetupWizard choice
		if (!config?.app?.setup_completed) return;

		if (config?.app?.language && config.app.language !== i18n.language) {
			i18n.changeLanguage(config.app.language);
		}
	}, [config, i18n]);

	// Loading State
	if (reqLoading) {
		return (
			<div className="min-h-screen w-full flex items-center justify-center bg-[#050201] relative overflow-hidden">
				<div className="absolute inset-0 z-0 flex items-center justify-center">
					<div className="w-[40vw] h-[40vw] bg-[radial-gradient(circle,rgba(219,140,37,0.15)_0%,transparent_60%)] animate-slow-breathe pointer-events-none rounded-full" />
				</div>
				<div className="text-center z-10">
					<div className="text-transparent bg-clip-text bg-gradient-to-r from-gold-400 via-tea-100 to-gold-300 animate-tea-wave text-2xl mb-3 font-[Playfair_Display] tracking-widest drop-shadow-[0_0_15px_rgba(255,215,0,0.3)]">
						TEPORA
					</div>
					<div className="text-gold-400/80 animate-pulse text-sm mb-2 font-medium tracking-wide">
						{t("app.loading", "Connecting to server…")}
					</div>
					<div className="text-gray-500/60 text-xs tracking-wider">
						{t("app.loadingHint", "This may take a few seconds")}
					</div>
				</div>
			</div>
		);
	}

	// Error State
	if (reqError) {
		const errorMsg =
			reqErrorObj instanceof Error
				? reqErrorObj.message
				: t("errors.unknownError", "An unknown error occurred.");

		return (
			<div className="min-h-screen w-full flex items-center justify-center bg-[#050201]">
				<div className="text-center max-w-md px-6">
					<div className="flex justify-center mb-4" aria-hidden="true">
						<AlertTriangle className="w-14 h-14 text-red-400" />
					</div>
					<h1 className="text-white text-xl font-semibold mb-2">
						{t("errors.connectionErrorTitle", "Connection Error")}
					</h1>
					<p className="text-gray-400 mb-6" role="alert">
						{errorMsg}
					</p>
					<div className="space-y-3">
						<button
							type="button"
							onClick={() => refetchRequirements()}
							className="w-full px-6 py-3 bg-gold-500 hover:bg-gold-600 text-black font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-gold-400 focus:ring-offset-2 focus:ring-offset-gray-950"
							aria-label={t("errors.retryButton", "Retry connection")}
						>
							{t("errors.retryButton", "Retry Connection")}
						</button>
						<a
							href="/logs"
							className="w-full inline-flex items-center justify-center px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-gold-400 focus:ring-offset-2 focus:ring-offset-gray-950"
							aria-label={t("errors.viewLogsButton", "View logs")}
						>
							{t("errors.viewLogsButton", "View Logs")}
						</a>
						<p className="text-gray-500 text-sm">
							{t(
								"errors.troubleshootHint",
								"Make sure the backend server is running on the expected port.",
							)}
						</p>
					</div>
				</div>
			</div>
		);
	}

	// Setup Required
	// Show logic: IF (not ready AND not completed) AND not skipped
	const isSetupCompleted = config?.app?.setup_completed === true;
	const shouldShowSetup =
		(!requirements?.is_ready || requirements?.has_missing) &&
		!isSetupCompleted &&
		!isSkipped;

	if (shouldShowSetup) {
		return (
			<SetupWizard
				onComplete={() => {
					refetchRequirements();
					refetchConfig();
				}}
				onSkip={() => setIsSkipped(true)}
			/>
		);
	}

	// Ready
	return (
		<ToastProvider>
			<RouterProvider router={router} />
		</ToastProvider>
	);
}

export default App;
