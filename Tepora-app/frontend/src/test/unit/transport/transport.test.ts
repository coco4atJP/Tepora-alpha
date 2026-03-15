import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IpcTransport } from '../../../transport/ipcTransport';
import { WebsocketTransport } from '../../../transport/websocketTransport';
import { Transport } from '../../../transport/index';
import { getTransport } from '../../../transport/factory';

// Mock Tauri IPC
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(() => { })
}));

vi.mock('../../../stores/socketCommands', () => ({
    socketCommands: {
        sendRaw: vi.fn(),
        handleToolConfirmation: vi.fn()
    }
}));

describe('Transport Implementations', () => {
    let ipcTransport: Transport;
    let wsTransport: Transport;

    beforeEach(() => {
        vi.clearAllMocks();
        ipcTransport = new IpcTransport();
        wsTransport = new WebsocketTransport();
    });

    describe('IpcTransport', () => {
        it('implements Transport interface', () => {
            expect(typeof ipcTransport.send).toBe('function');
            expect(typeof ipcTransport.subscribe).toBe('function');
            expect(typeof ipcTransport.confirmTool).toBe('function');
        });

        it('subscribes correctly', () => {
            const handler = vi.fn();
            const unsubscribe = ipcTransport.subscribe(handler);
            expect(typeof unsubscribe).toBe('function');
            unsubscribe();
        });
    });

    describe('WebsocketTransport', () => {
        it('implements Transport interface', () => {
            expect(typeof wsTransport.send).toBe('function');
            expect(typeof wsTransport.subscribe).toBe('function');
            expect(typeof wsTransport.confirmTool).toBe('function');
        });

        it('subscribes correctly', () => {
            const handler = vi.fn();
            const unsubscribe = wsTransport.subscribe(handler);
            expect(typeof unsubscribe).toBe('function');
            unsubscribe();
        });
    });

    describe('Transport Factory', () => {
        it('returns IpcTransport when mode is ipc', () => {
            const transport = getTransport('ipc');
            expect(transport).toBeInstanceOf(IpcTransport);
        });

        it('returns WebsocketTransport when mode is websocket', () => {
            const transport = getTransport('websocket');
            expect(transport).toBeInstanceOf(WebsocketTransport);
        });

        it('returns WebsocketTransport by default', () => {
            const transport = getTransport();
            expect(transport).toBeInstanceOf(WebsocketTransport);
        });
    });
});
