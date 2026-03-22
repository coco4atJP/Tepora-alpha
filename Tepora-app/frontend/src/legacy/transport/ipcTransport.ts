import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ToolConfirmationResponse } from '../../types';
import { Transport } from './index';
import { logger } from '../../utils/logger';

export class IpcTransport implements Transport {
    private handlers: Set<(message: unknown) => void> = new Set();
    private isListening = false;

    constructor() {
        this.startListening();
    }

    private startListening() {
        if (this.isListening) return;
        this.isListening = true;
        listen<string>('chat_event', (event) => {
            try {
                const data = JSON.parse(event.payload);
                this.handlers.forEach(h => h(data));
            } catch (e) {
                logger.error("Failed to parse IPC message", e);
            }
        });
    }

    send(data: Record<string, unknown>): void {
        invoke('chat_command', { payload: JSON.stringify(data) }).catch(e => {
            logger.error("Failed to send IPC message", e);
        });
    }

    subscribe(handler: (message: unknown) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    confirmTool(requestId: string, response: ToolConfirmationResponse): void {
        this.send({
            type: "tool_confirmation_response",
            requestId,
            decision: response.decision,
            ttlSeconds: response.ttlSeconds,
        });
    }
}

