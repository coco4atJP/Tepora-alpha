import {
	wsIncomingMessageSchema,
	wsOutgoingMessageSchema,
	type V2WsIncomingMessage,
	type V2WsOutgoingMessage,
} from "../contracts";

type ConnectionMode = "websocket";
export type V2TransportConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected";

export interface V2TransportConnectionSnapshot {
	status: V2TransportConnectionStatus;
	mode: ConnectionMode;
	reconnectAttempts: number;
	lastError: string | null;
}

type MessageSubscriber = (message: V2WsIncomingMessage) => void;
type ConnectionSubscriber = (snapshot: V2TransportConnectionSnapshot) => void;

const INITIAL_SNAPSHOT: V2TransportConnectionSnapshot = {
	status: "idle",
	mode: "websocket",
	reconnectAttempts: 0,
	lastError: null,
};

class V2TransportAdapter {
	private socket: WebSocket | null = null;
	private snapshot: V2TransportConnectionSnapshot = INITIAL_SNAPSHOT;
	private readonly messageSubscribers = new Set<MessageSubscriber>();
	private readonly connectionSubscribers = new Set<ConnectionSubscriber>();
	private manuallyClosed = false;

	private emitConnection(snapshot: V2TransportConnectionSnapshot) {
		this.snapshot = snapshot;
		for (const subscriber of this.connectionSubscribers) {
			subscriber(snapshot);
		}
	}

	private buildUrl() {
		if (typeof window === "undefined") {
			return "ws://localhost/ws";
		}

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${window.location.host}/ws`;
	}

	private attachSocket(socket: WebSocket) {
		socket.addEventListener("open", () => {
			this.emitConnection({
				status: "connected",
				mode: "websocket",
				reconnectAttempts: this.snapshot.reconnectAttempts,
				lastError: null,
			});
		});

		socket.addEventListener("message", (event) => {
			try {
				const parsed = wsIncomingMessageSchema.safeParse(JSON.parse(String(event.data)));
				if (!parsed.success) {
					return;
				}
				for (const subscriber of this.messageSubscribers) {
					subscriber(parsed.data);
				}
			} catch {
				// Ignore malformed frames.
			}
		});

		socket.addEventListener("close", () => {
			this.socket = null;
			this.emitConnection({
				status: this.manuallyClosed ? "disconnected" : "idle",
				mode: "websocket",
				reconnectAttempts: this.snapshot.reconnectAttempts,
				lastError: this.manuallyClosed ? null : this.snapshot.lastError,
			});
		});

		socket.addEventListener("error", () => {
			this.emitConnection({
				status: this.snapshot.status === "reconnecting" ? "reconnecting" : "disconnected",
				mode: "websocket",
				reconnectAttempts: this.snapshot.reconnectAttempts,
				lastError: "WebSocket transport error",
			});
		});
	}

	async connect() {
		if (typeof WebSocket === "undefined") {
			this.emitConnection({
				status: "disconnected",
				mode: "websocket",
				reconnectAttempts: this.snapshot.reconnectAttempts,
				lastError: "WebSocket is not available in this environment",
			});
			return;
		}
		if (
			this.socket &&
			(this.socket.readyState === WebSocket.OPEN ||
				this.socket.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		this.manuallyClosed = false;
		this.emitConnection({
			status: this.snapshot.reconnectAttempts > 0 ? "reconnecting" : "connecting",
			mode: "websocket",
			reconnectAttempts: this.snapshot.reconnectAttempts,
			lastError: null,
		});
		this.socket = new WebSocket(this.buildUrl());
		this.attachSocket(this.socket);
	}

	disconnect() {
		this.manuallyClosed = true;
		this.socket?.close();
		this.socket = null;
		this.emitConnection({
			status: "disconnected",
			mode: "websocket",
			reconnectAttempts: this.snapshot.reconnectAttempts,
			lastError: null,
		});
	}

	async reconnect() {
		this.emitConnection({
			status: "reconnecting",
			mode: "websocket",
			reconnectAttempts: this.snapshot.reconnectAttempts + 1,
			lastError: null,
		});
		this.socket?.close();
		this.socket = null;
		await this.connect();
	}

	send(message: V2WsOutgoingMessage) {
		const payload = wsOutgoingMessageSchema.parse(message);
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("Transport is not connected.");
		}
		this.socket.send(JSON.stringify(payload));
	}

	subscribe(callback: MessageSubscriber) {
		this.messageSubscribers.add(callback);
		return () => {
			this.messageSubscribers.delete(callback);
		};
	}

	subscribeConnection(callback: ConnectionSubscriber) {
		this.connectionSubscribers.add(callback);
		callback(this.snapshot);
		return () => {
			this.connectionSubscribers.delete(callback);
		};
	}
}

export const v2TransportAdapter = new V2TransportAdapter();
