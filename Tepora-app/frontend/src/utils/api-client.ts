import { getApiBase, getAuthHeaders } from "./api";

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
		let errorData;
		try {
			errorData = await response.json();
		} catch {
			errorData = { message: response.statusText };
		}
		throw new ApiError(
			errorData.message || "API request failed",
			response.status,
			errorData,
		);
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
