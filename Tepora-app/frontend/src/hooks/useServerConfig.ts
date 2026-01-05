import { useQuery } from "@tanstack/react-query";
import type { Config as AppConfig } from "../context/SettingsContext";
import { apiClient } from "../utils/api-client";

export function useRequirements() {
	return useQuery({
		queryKey: ["requirements"],
		queryFn: () =>
			apiClient.get<{ is_ready: boolean }>("api/setup/requirements"),
		retry: false,
		refetchOnWindowFocus: false,
		staleTime: 0, // Always check on mount
	});
}

export function useServerConfig() {
	return useQuery({
		queryKey: ["config"],
		queryFn: () => apiClient.get<AppConfig>("api/config"),
		retry: 1,
		refetchOnWindowFocus: false,
		staleTime: 60000, // Config unlikely to change often externally
	});
}
