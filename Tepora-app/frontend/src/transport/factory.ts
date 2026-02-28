import { Transport } from './index';
import { IpcTransport } from './ipcTransport';
import { WebsocketTransport } from './websocketTransport';

export const ipcTransportInstance = new IpcTransport();
export const websocketTransportInstance = new WebsocketTransport();

/**
 * Factory to select the transport based on configuration mode.
 * @param mode 'ipc' or 'websocket' 
 */
export function getTransport(mode?: string): Transport {
    if (mode === 'ipc') {
        return ipcTransportInstance;
    }
    return websocketTransportInstance;
}
