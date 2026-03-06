import type { ToolConfirmationResponse } from '../types';
import { Transport } from './index';
import { useWebSocketStore } from '../stores/websocketStore';

export class WebsocketTransport implements Transport {
    send(data: Record<string, unknown>): void {
        const store = useWebSocketStore.getState();
        store.sendRaw(data);
    }

    subscribe(handler: (message: unknown) => void): () => void {
        const eventHandler = (e: Event) => {
            if ('detail' in e) {
                handler((e as CustomEvent).detail);
            }
        };
        window.addEventListener('ws_message_received', eventHandler);

        return () => {
            window.removeEventListener('ws_message_received', eventHandler);
        };
    }

    confirmTool(requestId: string, response: ToolConfirmationResponse): void {
        const store = useWebSocketStore.getState();
        store.handleToolConfirmation(requestId, response.decision, response.ttlSeconds);
    }
}
