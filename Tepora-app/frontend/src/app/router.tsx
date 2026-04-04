import { Navigate, createBrowserRouter, type RouteObject } from "react-router-dom";
import { Workspace } from "./Workspace";

function AppRouteError() {
	return (
		<div className="min-h-screen bg-[var(--v2-color-canvas,#0b0f14)] text-[var(--v2-color-foreground,#f8fafc)]">
			<div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
				<h1 className="text-2xl font-semibold">route not found</h1>
				<p className="text-sm text-[var(--v2-color-muted,#94a3b8)]">
					The requested Tepora screen is not available in the canonical frontend.
				</p>
				<a href="/" className="rounded-full border border-white/20 px-4 py-2 text-sm">
					Return to Tepora
				</a>
			</div>
		</div>
	);
}

export const appRoutes: RouteObject[] = [
	{
		path: "/",
		element: <Workspace />,
		errorElement: <AppRouteError />,
	},
	{
		path: "/settings",
		element: <Workspace isSettingsOpen />,
		errorElement: <AppRouteError />,
	},
	{
		path: "/v2",
		element: <Navigate to="/" replace />,
	},
	{
		path: "/v2/settings",
		element: <Navigate to="/settings" replace />,
	},
	{
		path: "/v2/*",
		element: <Navigate to="/" replace />,
	},
	{
		path: "*",
		element: <AppRouteError />,
	},
];

export const appRouter = createBrowserRouter(appRoutes);
