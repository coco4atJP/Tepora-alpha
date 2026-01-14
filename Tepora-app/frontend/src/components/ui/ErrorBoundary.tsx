import { AlertTriangle, RefreshCcw } from "lucide-react";
import React from "react";

interface ErrorBoundaryProps {
	children: React.ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export default class ErrorBoundary extends React.Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = {
		hasError: false,
		error: null,
	};

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error) {
		console.error("[UI] Uncaught error:", error);
	}

	private handleReload = () => {
		window.location.reload();
	};

	render() {
		if (!this.state.hasError) return this.props.children;

		return (
			<div className="min-h-screen w-full flex items-center justify-center bg-[#050201] text-white p-6">
				<div className="w-full max-w-lg glass-tepora rounded-2xl border border-white/10 shadow-2xl p-6">
					<div className="flex items-center gap-3 mb-3">
						<AlertTriangle
							className="w-6 h-6 text-red-400"
							aria-hidden="true"
						/>
						<h1 className="text-lg font-semibold">Something went wrong</h1>
					</div>

					<p className="text-sm text-gray-300">
						The UI encountered an unexpected error. Reload the app to continue.
					</p>

					{this.state.error && (
						<details className="mt-4 text-xs text-gray-300 bg-black/30 rounded-xl border border-white/10 p-3">
							<summary className="cursor-pointer select-none text-gray-400">
								Error details
							</summary>
							<pre className="mt-2 whitespace-pre-wrap break-words font-mono">
								{this.state.error.message}
							</pre>
						</details>
					)}

					<div className="mt-6 flex justify-end">
						<button
							type="button"
							onClick={this.handleReload}
							className="glass-button px-4 py-2 text-sm text-gold-200 flex items-center gap-2"
						>
							<RefreshCcw className="w-4 h-4" aria-hidden="true" />
							Reload
						</button>
					</div>
				</div>
			</div>
		);
	}
}
