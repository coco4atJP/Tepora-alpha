import { Bot, ChevronDown } from "lucide-react";
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "../types";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
	messages: Message[];
}

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
	const { t } = useTranslation();
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const endOfMessagesRef = useRef<HTMLDivElement>(null);
	const prevLengthRef = useRef(messages.length);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [hasNewWhileAway, setHasNewWhileAway] = useState(false);

	const updateIsAtBottom = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const threshold = 80; // px
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		const atBottom = distanceFromBottom < threshold;

		setIsAtBottom(atBottom);
		if (atBottom) {
			setHasNewWhileAway(false);
		}
	}, []);

	const scrollToBottom = useCallback(() => {
		endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
		setHasNewWhileAway(false);
		setIsAtBottom(true);
	}, []);

	useEffect(() => {
		// メッセージ数が増えた場合のみスクロール（ストリーミング中のコンテンツ更新では発火しない）
		if (messages.length > prevLengthRef.current) {
			if (isAtBottom) {
				endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
			} else {
				setHasNewWhileAway(true);
			}
		}
		prevLengthRef.current = messages.length;
	}, [messages.length, isAtBottom]);

	const lastMessageContent = messages[messages.length - 1]?.content ?? "";
	useEffect(() => {
		// ストリーミング中は「最下部にいる場合のみ」追従する
		if (!isAtBottom) return;
		endOfMessagesRef.current?.scrollIntoView({ behavior: "auto" });
	}, [isAtBottom, lastMessageContent]);

	// Get the last message for screen reader announcement
	const announcementText = useMemo(() => {
		const lastMessage = messages[messages.length - 1];
		if (!lastMessage) return "";

		const roleLabel =
			lastMessage.role === "assistant"
				? t("chat.role.assistant", "Assistant")
				: lastMessage.role === "user"
					? t("chat.role.user", "You")
					: t("chat.role.system", "System");

		const snippet = lastMessage.content.substring(0, 200);
		return `${roleLabel}: ${snippet}${lastMessage.content.length > 200 ? "..." : ""}`;
	}, [messages, t]);

	return (
		<div className="relative h-full">
			<div
				ref={scrollContainerRef}
				onScroll={updateIsAtBottom}
				className="overflow-y-auto p-4 space-y-6 h-full custom-scrollbar"
				role="log"
				aria-label={t("chat.messages_aria_label", "Chat messages")}
				aria-live="off"
			>
				{/* Screen reader only: announce new messages */}
				<div className="sr-only" aria-live="polite" aria-atomic="true">
					{announcementText}
				</div>

				{messages.length === 0 && (
					<div className="flex flex-col items-center justify-center h-full text-coffee-200/50">
						<Bot className="w-16 h-16 mb-4 opacity-30" aria-hidden="true" />
						<p className="text-lg font-bold tracking-widest uppercase font-display">
							{t("chat.input.system_ready", "System Ready")}
						</p>
						<p className="text-sm mt-2 opacity-50 font-sans">
							{t(
								"chat.input.system_ready_hint",
								"Select a mode from the dial to begin",
							)}
						</p>
					</div>
				)}

				{messages.map((message) => (
					<MessageBubble key={message.id} message={message} />
				))}

				<div ref={endOfMessagesRef} aria-hidden="true" />
			</div>

			{hasNewWhileAway && (
				<button
					type="button"
					onClick={scrollToBottom}
					className="absolute bottom-4 right-4 z-10 glass-button px-3 py-2 text-xs text-gold-200 border border-white/10 shadow-lg hover:border-gold-500/30 flex items-center gap-2"
					aria-label={t("chat.jump_to_latest", "Jump to latest message")}
				>
					<ChevronDown className="w-4 h-4" aria-hidden="true" />
					{t("chat.jump_to_latest_short", "Latest")}
				</button>
			)}
		</div>
	);
};

export default React.memo(MessageList);
