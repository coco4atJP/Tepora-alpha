import { useEffect, useRef, useState, useCallback } from 'react';
import { isDesktop } from '../../utils/sidecar';

const getWsUrl = () => {
    if (isDesktop()) {
        return 'ws://localhost:8000/ws';
    }
    return import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';
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
    onClose
}: UseSocketConnectionProps = {}) => {
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const isMounted = useRef(true);
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
                onOpenRef.current?.();
            };

            ws.onmessage = (event) => {
                if (!isMounted.current) return;
                onMessageRef.current?.(event);
            };

            ws.onerror = (error) => {
                if (!isMounted.current) return;
                console.error("WebSocket error:", error);
                setIsConnected(false);
                onErrorRef.current?.(error);
            };

            ws.onclose = () => {
                if (!isMounted.current) return;
                setIsConnected(false);
                onCloseRef.current?.();

                // Automatic reconnect
                reconnectTimeoutRef.current = setTimeout(() => {
                    if (isMounted.current) {
                        connect();
                    }
                }, 5000);
            };

            wsRef.current = ws;
        } catch (error) {
            if (!isMounted.current) return;
            console.error("WebSocket connection failed:", error);
            setIsConnected(false);
            // onErrorRef.current?.(error); // Error event structure might differ
        }
    }, [WS_URL]);

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
    }, [connect]);

    const sendMessage = useCallback((data: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            throw new Error("Not connected to server");
        }
        wsRef.current.send(data);
    }, []);

    return {
        isConnected,
        sendMessage,
        wsRef
    };
};
