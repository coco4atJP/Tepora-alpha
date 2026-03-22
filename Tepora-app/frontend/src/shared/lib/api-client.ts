import type { ZodType } from "zod";
import { getApiBase, getAuthHeaders, getAuthHeadersAsync } from "../../utils/api";
import { logger } from "../../utils/logger";
import { refreshSessionToken } from "../../utils/sessionToken";

export class V2ApiError extends Error {
	readonly status: number;
	readonly data: unknown;

	constructor(message: string, status: number, data: unknown) {
		super(message);
		this.name = "V2ApiError";
		this.status = status;
		this.data = data;
	}
}

async function parseJson(response: Response): Promise<unknown> {
	if (response.status === 204) {
		return {};
	}

	try {
		return await response.json();
	} catch {
		return {};
	}
}

function resolveErrorMessage(response: Response, payload: unknown): string {
	if (typeof payload === "object" && payload !== null) {
		const errorPayload = payload as {
			message?: unknown;
			error?: unknown;
			detail?: unknown;
		};
		if (typeof errorPayload.message === "string" && errorPayload.message) {
			return errorPayload.message;
		}
		if (typeof errorPayload.error === "string" && errorPayload.error) {
			return errorPayload.error;
		}
		if (typeof errorPayload.detail === "string" && errorPayload.detail) {
			return errorPayload.detail;
		}
	}

	return response.statusText || "API request failed";
}

function parseWithSchema<T>(schema: ZodType<T>, payload: unknown, endpoint: string): T {
	const result = schema.safeParse(payload);
	if (!result.success) {
		logger.error(`[V2 API] Failed to parse response for ${endpoint}`, result.error.flatten());
		throw new V2ApiError(`Invalid API response for ${endpoint}`, 500, payload);
	}
	return result.data;
}

async function executeRequest<T>(
	endpoint: string,
	schema: ZodType<T>,
	config: RequestInit = {},
	isRetry = false,
): Promise<T> {
	const apiBase = getApiBase();
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

	if (response.status === 401 && !isRetry) {
		logger.log("[V2 API] 401 received, refreshing token and retrying...");
		await refreshSessionToken();
		const freshHeaders = await getAuthHeadersAsync();
		return executeRequest(endpoint, schema, {
			...config,
			headers: {
				"Content-Type": "application/json",
				...freshHeaders,
				...config.headers,
			},
		}, true);
	}

	const payload = await parseJson(response);
	if (!response.ok) {
		throw new V2ApiError(resolveErrorMessage(response, payload), response.status, payload);
	}

	return parseWithSchema(schema, payload, endpoint);
}

export const v2ApiClient = {
	get<T>(endpoint: string, schema: ZodType<T>, config?: RequestInit) {
		return executeRequest(endpoint, schema, { ...config, method: "GET" });
	},
	post<T>(endpoint: string, schema: ZodType<T>, body?: unknown, config?: RequestInit) {
		return executeRequest(endpoint, schema, {
			...config,
			method: "POST",
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	},
	put<T>(endpoint: string, schema: ZodType<T>, body?: unknown, config?: RequestInit) {
		return executeRequest(endpoint, schema, {
			...config,
			method: "PUT",
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	},
	patch<T>(endpoint: string, schema: ZodType<T>, body?: unknown, config?: RequestInit) {
		return executeRequest(endpoint, schema, {
			...config,
			method: "PATCH",
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	},
	delete<T>(endpoint: string, schema: ZodType<T>, config?: RequestInit) {
		return executeRequest(endpoint, schema, { ...config, method: "DELETE" });
	},
};
