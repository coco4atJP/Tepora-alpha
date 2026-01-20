import { useCallback, useEffect, useRef, useState } from "react";
import { getWsBase } from "../../utils/api";
import { getSessionToken, refreshSessionToken } from "../../utils/sessionToken";
import { backendReady, isDesktop } from "../../utils/sidecar";

/**
 * Build WebSocket URL with optional token query parameter.
 * @param token - Session token to append as query parameter
 */
const getWsUrl = (token: string | null = null) => {
	let baseUrl: string;
	if (isDesktop()) {
		baseUrl = `${getWsBase()}/ws`;
	} else {
		baseUrl = import.meta.env.VITE_WS_URL || `${getWsBase()}/ws`;
	}

	// Append token as query parameter for authentication
	if (token) {
		const separator = baseUrl.includes("?") ? "&" : "?";
		return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
	}
	return baseUrl;
};

// Calculate backoff outside component to avoid re-creation
const calculateBackoff = (attempt: number) => {
	// Exponential backoff: 1s, 2s, 4s, 8s, 16s... capped at 30s
	const baseDelay = 1000;
	const maxDelay = 30000;
	const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
	// Add random jitter +/- 10%
	const jitter = delay * 0.1 * (Math.random() * 2 - 1);
	return delay + jitter;
};

interface UseSocketConnectionProps {
	onOpen?: () => void;
	onMessage?: (event: MessageEvent) => void;
	onError?: (event: Event) => void;
	onClose?: () => void;
}

export const useSocketConnection = ({
	onOpen,
	onMessage,
	onError,
	onClose,
}: UseSocketConnectionProps = {}) => {
	const [isConnected, setIsConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const isMounted = useRef(true);
	const retryCountRef = useRef(0); // Use ref to avoid triggering re-render/re-creation of connect
	const tokenRef = useRef<string | null>(null); // Cache token for reconnection

	// Use refs for callbacks to avoid re-triggering effect on callback change
	const onOpenRef = useRef(onOpen);
	const onMessageRef = useRef(onMessage);
	const onErrorRef = useRef(onError);
	const onCloseRef = useRef(onClose);

	useEffect(() => {
		onOpenRef.current = onOpen;
		onMessageRef.current = onMessage;
		onErrorRef.current = onError;
		onCloseRef.current = onClose;
	}, [onOpen, onMessage, onError, onClose]);

	const connect = useCallback(async () => {
		if (!isMounted.current) return;

		try {
			// Wait for backend to be ready before connecting WebSocket
			// This ensures dynamic port is set correctly
			if (isDesktop()) {
				console.log("[WebSocket] Waiting for backend to be ready...");
				await backendReady;
				console.log("[WebSocket] Backend is ready, proceeding with connection");
			}

			// Get session token for authentication
			if (!tokenRef.current) {
				tokenRef.current = await getSessionToken();
				if (import.meta.env.DEV && tokenRef.current) {
					console.log("[WebSocket] Token loaded for connection");
				}
			}

			const WS_URL = getWsUrl(tokenRef.current);
			const ws = new WebSocket(WS_URL);

			ws.onopen = () => {
				if (!isMounted.current) {
					ws.close();
					return;
				}
				setIsConnected(true);
				retryCountRef.current = 0; // Reset retry count on successful connection
				onOpenRef.current?.();
			};

			ws.onmessage = (event) => {
				if (!isMounted.current) return;
				onMessageRef.current?.(event);
			};

			ws.onerror = (error) => {
				if (!isMounted.current) return;
				console.error("WebSocket error:", error);
				// Don't modify isConnected here, allow onclose to handle state
				onErrorRef.current?.(error);
			};

			ws.onclose = (event) => {
				if (!isMounted.current) return;
				setIsConnected(false);
				onCloseRef.current?.();

				// If closed due to auth failure (4001), try refreshing token
				if (event.code === 4001) {
					tokenRef.current = null;
					// Also refresh the global cached token
					refreshSessionToken()
						.then((newToken) => {
							if (import.meta.env.DEV && newToken) {
								console.log("[WebSocket] Token refreshed after auth failure");
							}
						})
						.catch((err) => {
							console.warn("[WebSocket] Failed to refresh token:", err);
						});
					if (import.meta.env.DEV) {
						console.log("[WebSocket] Auth failed, will retry with fresh token");
					}
				}

				// Automatic reconnect with exponential backoff
				const delay = calculateBackoff(retryCountRef.current);
				console.log(
					`WebSocket disconnected. Reconnecting in ${Math.round(delay)}ms (Attempt ${retryCountRef.current + 1})`,
				);

				reconnectTimeoutRef.current = setTimeout(() => {
					if (isMounted.current) {
						retryCountRef.current += 1;
						connect();
					}
				}, delay);
			};

			wsRef.current = ws;
		} catch (error) {
			if (!isMounted.current) return;
			console.error("WebSocket connection failed:", error);
			setIsConnected(false);

			// Retry even if immediate connection fails (e.g. invalid URL or network down)
			const delay = calculateBackoff(retryCountRef.current);
			reconnectTimeoutRef.current = setTimeout(() => {
				if (isMounted.current) {
					retryCountRef.current += 1;
					connect();
				}
			}, delay);
		}
	}, []); // No dependencies - uses refs for all state

	useEffect(() => {
		isMounted.current = true;
		connect();

		return () => {
			isMounted.current = false;
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (wsRef.current) {
				// Clear handlers
				wsRef.current.onopen = null;
				wsRef.current.onmessage = null;
				wsRef.current.onerror = null;
				wsRef.current.onclose = null;
				wsRef.current.close();
			}
		};
	}, [connect]); // Run only once on mount (connect handles recursion)

	const sendMessage = useCallback((data: string) => {
		if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected to server");
		}
		wsRef.current.send(data);
	}, []);

	return {
		isConnected,
		sendMessage,
		wsRef,
	};
};
