import { RouterProvider } from "react-router-dom";
import "../shared/theme/tailwind.css";
import "../shared/theme/variables.css";
import { V2Providers } from "./providers";
import { v2Router } from "./router";

export function shouldBootV2(pathname?: string): boolean {
	const resolvedPathname =
		pathname ??
		(typeof window !== "undefined" ? window.location.pathname : "/");

	return resolvedPathname.startsWith("/v2");
}

export function V2AppEntry() {
	return (
		<V2Providers>
			<RouterProvider router={v2Router} />
		</V2Providers>
	);
}
