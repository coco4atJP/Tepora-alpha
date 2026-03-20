import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "../types";
import { apiClient } from "../utils/api-client";

export function useSystemStatus() {
	return useQuery({
		queryKey: ["system-status"],
		queryFn: () => apiClient.get<SystemStatus>("api/status"),
		refetchInterval: 30000,
		refetchIntervalInBackground: true,
		retry: false,
	});
}
