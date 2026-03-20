import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface SocketConnectionState {
	isConnected: boolean;
	socket: WebSocket | null;
	reconnectAttempts: number;
}

interface SocketConnectionActions {
	setConnection: (isConnected: boolean, socket: WebSocket | null) => void;
	setReconnectAttempts: (reconnectAttempts: number) => void;
	reset: () => void;
}

export type SocketConnectionStore = SocketConnectionState & SocketConnectionActions;

const initialState: SocketConnectionState = {
	isConnected: false,
	socket: null,
	reconnectAttempts: 0,
};

export const useSocketConnectionStore = create<SocketConnectionStore>()(
	devtools(
		(set) => ({
			...initialState,
			setConnection: (isConnected, socket) => {
				set({ isConnected, socket }, false, "setConnection");
			},
			setReconnectAttempts: (reconnectAttempts) => {
				set({ reconnectAttempts }, false, "setReconnectAttempts");
			},
			reset: () => {
				set(initialState, false, "resetSocketConnection");
			},
		}),
		{ name: "socket-connection-store" },
	),
);
