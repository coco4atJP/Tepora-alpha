import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import { SettingsProvider } from "./context/SettingsContext";
import { WebSocketProvider } from "./context/WebSocketContext";
import { getSessionToken } from "./utils/sessionToken";

const queryClient = new QueryClient();

import { backendReady, isDesktop, startSidecar } from "./utils/sidecar";

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
					setTimeout(() => reject(new Error("Backend startup timeout")), 30000),
				),
			]);
			console.log("[Main] Backend is ready, mounting React app");
		} catch (error) {
			console.warn("[Main] Backend startup issue:", error);
			// Continue anyway - App will handle connection errors
		}
	}

	try {
		await getSessionToken();
	} catch (error) {
		console.warn("[Main] Failed to load session token:", error);
	}

	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<ErrorBoundary>
				<QueryClientProvider client={queryClient}>
					<WebSocketProvider>
						<SettingsProvider>
							<App />
						</SettingsProvider>
					</WebSocketProvider>
					<ReactQueryDevtools initialIsOpen={false} />
				</QueryClientProvider>
			</ErrorBoundary>
		</React.StrictMode>,
	);
}

init();
