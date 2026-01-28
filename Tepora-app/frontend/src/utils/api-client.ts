import { getApiBase, getAuthHeaders, getAuthHeadersAsync } from "./api";
import { refreshSessionToken } from "./sessionToken";

export class ApiError extends Error {
	status: number;
	data: unknown;

	constructor(message: string, status: number, data: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.data = data;
	}
}

async function handleResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			errorData = { message: response.statusText };
		}

		const message =
			typeof errorData === "object" &&
			errorData !== null &&
			"message" in errorData &&
			typeof (errorData as { message?: unknown }).message === "string"
				? (errorData as { message: string }).message
				: response.statusText || "API request failed";

		throw new ApiError(message, response.status, errorData);
	}

	if (response.status === 204) {
		return {} as T;
	}

	try {
		return await response.json();
	} catch {
		return {} as T;
	}
}

async function request<T>(
	endpoint: string,
	config: RequestInit = {},
	isRetry: boolean = false,
): Promise<T> {
	const apiBase = getApiBase();
	// Ensure no double slash if apiBase ends with / (it usually doesn't based on api.ts)
	// apiBase is either "" or "http://localhost:port"
	const url = `${apiBase}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

	const headers = {
		"Content-Type": "application/json",
		...getAuthHeaders(),
		...config.headers,
	} as HeadersInit;

	const response = await fetch(url, {
		...config,
		headers,
	});

	// Handle 401 with token refresh and retry (once)
	if (response.status === 401 && !isRetry) {
		console.log("[API] 401 received, refreshing token and retrying...");
		await refreshSessionToken();
		const freshHeaders = await getAuthHeadersAsync();
		const retryResponse = await fetch(url, {
			...config,
			headers: {
				"Content-Type": "application/json",
				...freshHeaders,
				...config.headers,
			},
		});
		return handleResponse<T>(retryResponse);
	}

	return handleResponse<T>(response);
}

export const apiClient = {
	get: <T>(endpoint: string, config?: RequestInit) =>
		request<T>(endpoint, { ...config, method: "GET" }),

	post: <T>(endpoint: string, body?: unknown, config?: RequestInit) =>
		request<T>(endpoint, {
			...config,
			method: "POST",
			body: JSON.stringify(body),
		}),

	put: <T>(endpoint: string, body?: unknown, config?: RequestInit) =>
		request<T>(endpoint, {
			...config,
			method: "PUT",
			body: JSON.stringify(body),
		}),

	delete: <T>(endpoint: string, config?: RequestInit) =>
		request<T>(endpoint, { ...config, method: "DELETE" }),

	patch: <T>(endpoint: string, body?: unknown, config?: RequestInit) =>
		request<T>(endpoint, {
			...config,
			method: "PATCH",
			body: JSON.stringify(body),
		}),
};
