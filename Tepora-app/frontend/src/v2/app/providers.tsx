import {
	QueryClientProvider,
	QueryErrorResetBoundary,
} from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { ReactNode } from "react";
import { Component } from "react";
import { createV2QueryClient } from "../shared/lib/queryClient";

interface V2ProvidersProps {
	children: ReactNode;
}

interface V2RootBoundaryProps {
	children: ReactNode;
	onReset: () => void;
}

interface V2RootBoundaryState {
	hasError: boolean;
}

class V2RootBoundary extends Component<V2RootBoundaryProps, V2RootBoundaryState> {
	override state: V2RootBoundaryState = {
		hasError: false,
	};

	static getDerivedStateFromError(): V2RootBoundaryState {
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
						<h1 className="text-2xl font-semibold">Frontend v2 failed to render</h1>
						<p className="max-w-xl text-sm text-[var(--v2-color-muted,#94a3b8)]">
							The route-level logic rail is mounted, but an unrecovered error
							occurred before the design layer was attached.
						</p>
						<button
							type="button"
							onClick={this.handleReset}
							className="rounded-full border border-white/20 px-4 py-2 text-sm"
						>
							Reset v2 boundary
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}

const v2QueryClient = createV2QueryClient();

export function V2Providers({ children }: V2ProvidersProps) {
	return (
		<QueryErrorResetBoundary>
			{({ reset }) => (
				<V2RootBoundary onReset={reset}>
					<QueryClientProvider client={v2QueryClient}>
						{children}
						<ReactQueryDevtools initialIsOpen={false} />
					</QueryClientProvider>
				</V2RootBoundary>
			)}
		</QueryErrorResetBoundary>
	);
}
