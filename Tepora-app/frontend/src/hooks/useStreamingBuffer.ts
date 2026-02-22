/**
 * useStreamingBuffer - Custom hook for streaming message buffer management
 *
 * Provides a focused interface for components that need streaming buffer state
 * and actions from chatStore.
 */

import { useChatStore } from "../stores/chatStore";

/**
 * Returns the actions needed to manage streaming message buffers.
 *
 * Usage:
 * ```ts
 * const { handleChunk, flush, finalize } = useStreamingBuffer();
 * // on WS message:
 * handleChunk(content, { nodeId: "chat", mode: "normal" });
 * // on stream end:
 * finalize();
 * ```
 */
export function useStreamingBuffer() {
	const handleStreamChunk = useChatStore((s) => s.handleStreamChunk);
	const flushStreamBuffer = useChatStore((s) => s.flushStreamBuffer);
	const finalizeStream = useChatStore((s) => s.finalizeStream);

	// Streaming state snapshot (for read access in components)
	const streaming = useChatStore((s) => s.streaming);
	const streamBuffer = streaming.buffer;
	const streamMetadata = streaming.metadata;
	const isStreaming = streamBuffer.length > 0 || streamMetadata !== null;

	return {
		/** Process an incoming stream chunk */
		handleChunk: handleStreamChunk,
		/** Manually flush the buffer to the message list */
		flush: flushStreamBuffer,
		/** Finalize the stream (flush + mark message as complete) */
		finalize: finalizeStream,
		/** True if there is an active stream buffer */
		isStreaming,
		/** Current buffer content (useful for progress indicators) */
		streamBuffer,
		/** Current streaming metadata (node and mode info) */
		streamMetadata,
	};
}
