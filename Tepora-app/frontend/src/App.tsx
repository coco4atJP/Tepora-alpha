import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createBrowserRouter,
	createRoutesFromElements,
	Route,
	RouterProvider,
} from "react-router-dom";
import ChatInterface from "./components/ChatInterface";
import Layout from "./components/Layout";
import SetupWizard from "./components/SetupWizard";
import { useRequirements, useServerConfig } from "./hooks/useServerConfig";
import Logs from "./pages/Logs";
import Memory from "./pages/Memory";

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
			<div className="min-h-screen w-full flex items-center justify-center bg-[#050201]">
				<div className="text-center">
					<div className="text-gold-400 animate-pulse text-lg mb-2">
						{t("app.loading", "Connecting to server...")}
					</div>
					<div className="text-gray-500 text-sm">
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
					<div className="text-red-400 text-6xl mb-4" aria-hidden="true">
						⚠
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
		!requirements?.is_ready && !isSetupCompleted && !isSkipped;

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
	return <RouterProvider router={router} />;
}

export default App;
