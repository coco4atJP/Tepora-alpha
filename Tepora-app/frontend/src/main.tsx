import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import { SettingsProvider } from "./context/SettingsContext";
import { ThemeProvider } from "./context/ThemeContext";
import { WebSocketProvider } from "./context/WebSocketContext";
import { getSessionToken } from "./utils/sessionToken";

const queryClient = new QueryClient();

import { isDesktop, startSidecar } from "./utils/sidecar";

// Start the backend sidecar and wait for it before mounting React
async function init() {
	// Start sidecar (non-blocking)
	startSidecar();

	// Optimistic Rendering: We do NOT wait for backendReady here.
	// The App component handles the "connecting" state via useRequirements.
	if (isDesktop()) {
		console.log(
			"[Main] Desktop mode detected, proceeding with optimistic render",
		);
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
							<ThemeProvider>
								<App />
							</ThemeProvider>
						</SettingsProvider>
					</WebSocketProvider>
					<ReactQueryDevtools initialIsOpen={false} />
				</QueryClientProvider>
			</ErrorBoundary>
		</React.StrictMode>,
	);
}

init();
