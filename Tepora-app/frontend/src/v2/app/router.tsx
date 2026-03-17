import { Navigate, createBrowserRouter } from "react-router-dom";
import { V2Workspace } from "./V2Workspace";

function V2RouteError() {
	return (
		<div className="min-h-screen bg-[var(--v2-color-canvas,#0b0f14)] text-[var(--v2-color-foreground,#f8fafc)]">
			<div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
				<h1 className="text-2xl font-semibold">v2 route error</h1>
				<p className="text-sm text-[var(--v2-color-muted,#94a3b8)]">
					The v2 router is mounted, but the requested screen is not available.
				</p>
				<a href="/v2" className="rounded-full border border-white/20 px-4 py-2 text-sm">
					Return to /v2
				</a>
			</div>
		</div>
	);
}

export const v2Router = createBrowserRouter(
	[
		{
			path: "/v2",
			element: <V2Workspace />,
			errorElement: <V2RouteError />,
		},
		{
			path: "/v2/settings",
			element: <V2Workspace isSettingsOpen />,
			errorElement: <V2RouteError />,
		},
		{
			path: "/v2/*",
			element: <Navigate to="/v2" replace />,
		},
	],
	{
		future: {
			v7_startTransition: true,
			v7_relativeSplatPath: true,
		},
	},
);
