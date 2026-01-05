import { useCallback, useEffect, useRef } from "react";
import type { ChatMode, Message, WebSocketMessage } from "../../types";

export const useMessageBuffer = (
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) => {
	const chunkBufferRef = useRef<string>("");
	const chunkMetadataRef = useRef<{
		mode?: ChatMode;
		agentName?: string;
		nodeId?: string;
	} | null>(null);
	const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const CHUNK_FLUSH_INTERVAL = 50;

	// Helper to updating messages
	const applyBufferedContent = useCallback(
		(
			prevMessages: Message[],
			bufferedContent: string,
			bufferedMeta: {
				mode?: ChatMode;
				agentName?: string;
				nodeId?: string;
			} | null,
		): Message[] => {
			const lastMessage = prevMessages[prevMessages.length - 1];

			// 1. Same node: Append to existing
			if (
				lastMessage?.role === "assistant" &&
				!lastMessage.isComplete &&
				lastMessage.nodeId === bufferedMeta?.nodeId
			) {
				return [
					...prevMessages.slice(0, -1),
					{
						...lastMessage,
						content: lastMessage.content + bufferedContent,
						mode: bufferedMeta?.mode || lastMessage.mode,
					},
				];
			}
			// 2. Different node but still assistant processing: Close previous, start new
			else if (lastMessage?.role === "assistant" && !lastMessage.isComplete) {
				return [
					...prevMessages.slice(0, -1),
					{ ...lastMessage, isComplete: true },
					{
						id: Date.now().toString(),
						role: "assistant",
						content: bufferedContent,
						timestamp: new Date(),
						isComplete: false,
						...bufferedMeta,
					},
				];
			}
			// 3. New message (start)
			else {
				return [
					...prevMessages,
					{
						id: Date.now().toString(),
						role: "assistant",
						content: bufferedContent,
						timestamp: new Date(),
						isComplete: false,
						...bufferedMeta,
					},
				];
			}
		},
		[],
	);

	const flush = useCallback(() => {
		if (!chunkBufferRef.current) return;

		const bufferedContent = chunkBufferRef.current;
		const bufferedMeta = chunkMetadataRef.current;

		setMessages((prev) =>
			applyBufferedContent(prev, bufferedContent, bufferedMeta),
		);

		chunkBufferRef.current = "";
		flushTimeoutRef.current = null;
	}, [setMessages, applyBufferedContent]);

	const handleChunk = useCallback(
		(data: WebSocketMessage) => {
			if (!data.message) return;

			const newMetadata = {
				mode: data.mode as ChatMode | undefined,
				agentName: data.agentName,
				nodeId: data.nodeId,
			};

			// If node changed, flush immediately
			if (
				chunkMetadataRef.current &&
				chunkMetadataRef.current.nodeId !== newMetadata.nodeId
			) {
				// Flush existing buffer
				if (chunkBufferRef.current) {
					const oldContent = chunkBufferRef.current;
					const oldMeta = chunkMetadataRef.current;
					setMessages((prev) => {
						const lastMessage = prev[prev.length - 1];
						// Only update if it allows continuing the same previous node
						if (
							lastMessage?.role === "assistant" &&
							!lastMessage.isComplete &&
							lastMessage.nodeId === oldMeta?.nodeId
						) {
							return [
								...prev.slice(0, -1),
								{
									...lastMessage,
									content: lastMessage.content + oldContent,
									isComplete: true,
								},
							];
						}
						return prev;
					});
					chunkBufferRef.current = "";
				}

				// Start new message
				setMessages((prev) => {
					const lastMessage = prev[prev.length - 1];
					if (lastMessage?.role === "assistant" && !lastMessage.isComplete) {
						return [
							...prev.slice(0, -1),
							{ ...lastMessage, isComplete: true },
							{
								id: Date.now().toString(),
								role: "assistant",
								content: data.message || "",
								timestamp: new Date(),
								isComplete: false,
								...newMetadata,
							},
						];
					}
					return [
						...prev,
						{
							id: Date.now().toString(),
							role: "assistant",
							content: data.message || "",
							timestamp: new Date(),
							isComplete: false,
							...newMetadata,
						},
					];
				});
				chunkMetadataRef.current = newMetadata;
			} else {
				// Same node, add to buffer
				chunkBufferRef.current += data.message;
				chunkMetadataRef.current = newMetadata;

				if (!flushTimeoutRef.current) {
					flushTimeoutRef.current = setTimeout(() => {
						flush();
					}, CHUNK_FLUSH_INTERVAL);
				}
			}
		},
		[setMessages, flush],
	);

	// Called on 'done' or 'stopped'
	const flushAndClose = useCallback(() => {
		if (flushTimeoutRef.current) {
			clearTimeout(flushTimeoutRef.current);
			flushTimeoutRef.current = null;
		}
		setMessages((prev) => {
			const lastMessage = prev[prev.length - 1];
			if (lastMessage && lastMessage.role === "assistant") {
				const remainingContent = chunkBufferRef.current;
				// Reset
				chunkBufferRef.current = "";
				chunkMetadataRef.current = null;

				return [
					...prev.slice(0, -1),
					{
						...lastMessage,
						content: lastMessage.content + remainingContent,
						isComplete: true,
					},
				];
			}
			return prev;
		});

		// Ensure buffer is cleared even if no message found
		chunkBufferRef.current = "";
		chunkMetadataRef.current = null;
	}, [setMessages]);

	useEffect(() => {
		return () => {
			if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
		};
	}, []);

	return {
		handleChunk,
		flushAndClose,
	};
};
