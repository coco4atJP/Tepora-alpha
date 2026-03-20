import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { appRoutes } from "../../app/router";

vi.mock("../../app/Workspace", () => ({
	Workspace: ({ isSettingsOpen = false }: { isSettingsOpen?: boolean }) => (
		<div>{isSettingsOpen ? "settings-screen" : "root-screen"}</div>
	),
}));

function renderRoute(initialEntry: string) {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [initialEntry],
	});
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
			mutations: {
				retry: 0,
			},
		},
	});

	const view = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);

	return { router, queryClient, view };
}

afterEach(() => {
	window.history.replaceState({}, "", "/");
});

it("redirects /v2 to the canonical root route", async () => {
	const { router } = renderRoute("/v2");

	await waitFor(() => {
		expect(router.state.location.pathname).toBe("/");
	});
});

it("redirects /v2/settings to the canonical settings route", async () => {
	const { router } = renderRoute("/v2/settings");

	await waitFor(() => {
		expect(router.state.location.pathname).toBe("/settings");
	});
});

it("shows not found for removed legacy routes", async () => {
	renderRoute("/logs");

	expect(await screen.findByText("route not found")).toBeInTheDocument();
});
