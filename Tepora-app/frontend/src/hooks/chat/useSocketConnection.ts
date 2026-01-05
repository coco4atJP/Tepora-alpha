import { useCallback, useEffect, useRef, useState } from "react";
import { getWsBase } from "../../utils/api";
import { isDesktop } from "../../utils/sidecar";

const getWsUrl = () => {
	if (isDesktop()) {
		return `${getWsBase()}/ws`;
	}
	return import.meta.env.VITE_WS_URL || `${getWsBase()}/ws`;
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
	const WS_URL = getWsUrl();

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

	const connect = useCallback(() => {
		if (!isMounted.current) return;

		try {
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

			ws.onclose = () => {
				if (!isMounted.current) return;
				setIsConnected(false);
				onCloseRef.current?.();

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
	}, [WS_URL]); // Only depend on WS_URL, retryCount is managed via ref

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
