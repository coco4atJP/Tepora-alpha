/**
 * Type definition for Tauri internal APIs.
 * This extends the global Window interface to include Tauri-specific properties.
 */
interface Window {
	/**
	 * Tauri internals object, present when running as a Tauri desktop application.
	 */
	__TAURI_INTERNALS__?: Record<string, unknown>;
	/**
	 * Active chat transport mode.
	 * `ipc` is the desktop default, `websocket` is used for web/dev fallback.
	 */
	__TRANSPORT_MODE__?: "ipc" | "websocket";
}
