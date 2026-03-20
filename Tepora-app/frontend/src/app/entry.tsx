import { RouterProvider } from "react-router-dom";
import "../shared/theme/tailwind.css";
import "../shared/theme/variables.css";
import { AppProviders } from "./providers";
import { appRouter } from "./router";

export function AppEntry() {
	return (
		<AppProviders>
			<RouterProvider router={appRouter} />
		</AppProviders>
	);
}
