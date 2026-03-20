import {
	QueryClientProvider,
	QueryErrorResetBoundary,
} from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { ReactNode } from "react";
import { Component, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useV2ConfigQuery } from "../features/settings/model/queries";
import { createV2QueryClient } from "../shared/lib/queryClient";

interface AppProvidersProps {
	children: ReactNode;
}

interface AppRootBoundaryProps {
	children: ReactNode;
	onReset: () => void;
}

interface AppRootBoundaryState {
	hasError: boolean;
}

class AppRootBoundary extends Component<AppRootBoundaryProps, AppRootBoundaryState> {
	override state: AppRootBoundaryState = {
		hasError: false,
	};

	static getDerivedStateFromError(): AppRootBoundaryState {
		return { hasError: true };
	}

	private handleReset = () => {
		this.props.onReset();
		this.setState({ hasError: false });
	};

	override render() {
		if (this.state.hasError) {
			return (
				<div className="min-h-screen bg-[var(--v2-color-canvas,#0d1117)] text-[var(--v2-color-foreground,#f8fafc)]">
					<div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
						<h1 className="text-2xl font-semibold">Frontend failed to render</h1>
						<p className="max-w-xl text-sm text-[var(--v2-color-muted,#94a3b8)]">
							The route-level logic rail is mounted, but an unrecovered error
							occurred before the design layer was attached.
						</p>
						<button
							type="button"
							onClick={this.handleReset}
							className="rounded-full border border-white/20 px-4 py-2 text-sm"
						>
							Reset frontend
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}

function resolveTheme(theme: string | undefined) {
	if (theme === "light" || theme === "dark" || theme === "tepora") {
		return theme;
	}

	if (
		theme === "system" &&
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-color-scheme: dark)").matches
	) {
		return "dark";
	}

	return "tepora";
}

function AppEnvironmentSync() {
	const { i18n } = useTranslation();
	const configQuery = useV2ConfigQuery();

	useEffect(() => {
		document.body.classList.add("v2-app");
		return () => {
			document.body.classList.remove("v2-app");
			document.body.style.fontSize = "";
		};
	}, []);

	useEffect(() => {
		const resolvedTheme = resolveTheme(
			typeof configQuery.data?.ui === "object" &&
				configQuery.data.ui &&
				"theme" in configQuery.data.ui
				? String((configQuery.data.ui as { theme?: unknown }).theme ?? "tepora")
				: "tepora",
		);
		document.documentElement.setAttribute("data-theme", resolvedTheme);
	}, [configQuery.data?.ui]);

	useEffect(() => {
		const fontSize =
			typeof configQuery.data?.ui === "object" &&
			configQuery.data.ui &&
			"font_size" in configQuery.data.ui
				? Number((configQuery.data.ui as { font_size?: unknown }).font_size ?? 14)
				: 14;
		document.body.style.fontSize = `${Number.isFinite(fontSize) ? fontSize : 14}px`;
	}, [configQuery.data?.ui]);

	useEffect(() => {
		const nextLanguage =
			typeof configQuery.data?.app === "object" &&
			configQuery.data.app &&
			"language" in configQuery.data.app
				? String((configQuery.data.app as { language?: unknown }).language ?? "")
				: "";
		if (nextLanguage && nextLanguage !== i18n.language) {
			void i18n.changeLanguage(nextLanguage);
		}
	}, [configQuery.data?.app, i18n]);

	return null;
}

const v2QueryClient = createV2QueryClient();

export function AppProviders({ children }: AppProvidersProps) {
	return (
		<QueryErrorResetBoundary>
			{({ reset }) => (
				<AppRootBoundary onReset={reset}>
					<QueryClientProvider client={v2QueryClient}>
						<AppEnvironmentSync />
						{children}
						<ReactQueryDevtools initialIsOpen={false} />
					</QueryClientProvider>
				</AppRootBoundary>
			)}
		</QueryErrorResetBoundary>
	);
}
