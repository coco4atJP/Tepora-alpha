import { ChevronDown, Loader2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "../../stores";
import MessageBubble from "./MessageBubble";

const MessageList: React.FC = () => {
	const messages = useChatStore((state) => state.messages);
	const { t } = useTranslation();
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const endOfMessagesRef = useRef<HTMLDivElement>(null);

	// Implement "stick to bottom" behavior
	const [isAtBottom, setIsAtBottom] = useState(true);
	const prevLengthRef = useRef(0);

	const checkIfAtBottom = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		// Allow a small buffer (e.g., 50px)
		const isBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 50;
		setIsAtBottom(isBottom);
	}, []);

	// Auto-scroll on new messages
	useEffect(() => {
		if (messages.length > prevLengthRef.current) {
			if (isAtBottom) {
				endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
			} else {
				// Optional: Show "New Feature" notification if not at bottom
				// For now, we just don't scroll
			}
		}
		prevLengthRef.current = messages.length;
	}, [messages.length, isAtBottom]);

	const lastMessageContent = messages[messages.length - 1]?.content ?? "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger scroll on content change
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

		// Only announce the first 100 chars to avoid noise
		const contentPreview = lastMessage.content.slice(0, 100);
		return `${t("chat.newMessageFrom", "New message from")} ${roleLabel}: ${contentPreview}`;
	}, [messages, t]);

	const scrollToBottom = () => {
		endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
	};

	return (
		<div className="relative h-full w-full min-h-0 min-w-0">
			{/* Announcer for Screen Readers */}
			<div
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{announcementText}
			</div>

			<div
				ref={scrollContainerRef}
				onScroll={checkIfAtBottom}
				className="h-full w-full overflow-y-auto overflow-x-hidden px-2 md:px-4 py-4 space-y-4 md:space-y-6 custom-scrollbar scroll-smooth"
			>
				{messages.length === 0 ? (
					<div className="h-full flex flex-col items-center justify-center text-gray-500 opacity-60 pointer-events-none select-none">
						<div className="text-4xl mb-4 text-tea-400 font-display font-light">
							TEPORA
						</div>
						<p className="text-sm font-light tracking-widest uppercase">
							{t("chat.empty", "System Ready")}
						</p>
					</div>
				) : (
					// biome-ignore lint/complexity/noUselessFragments: <explanation>
					<>
						{messages.map((msg, index) => (
							<div
								key={msg.id || index}
								className={`transition-all duration-500 ease-out ${
									index === messages.length - 1 ? "animate-slide-up-fade" : ""
								}`}
							>
								<MessageBubble message={msg} />
							</div>
						))}
					</>
				)}

				{/* Processing Indicator */}
				{messages.length > 0 &&
					messages[messages.length - 1].role === "user" && (
						<div className="flex justify-start animate-fade-in pl-4">
							<div className="bg-white/5 rounded-2xl p-4 flex items-center gap-3 border border-white/5">
								<Loader2 className="w-4 h-4 text-gold-400 animate-spin" />
								<span className="text-xs text-gray-400 tracking-wider font-mono uppercase">
									{t("chat.processing", "Processing...")}
								</span>
							</div>
						</div>
					)}

				{/* Invisible element to scroll to */}
				<div ref={endOfMessagesRef} aria-hidden="true" className="h-[1px]" />
			</div>

			{/* Scroll to Bottom Button */}
			{!isAtBottom && (
				<div className="absolute bottom-4 right-4 z-10 animate-fade-in-up">
					<button
						type="button"
						onClick={scrollToBottom}
						className="bg-gold-500 hover:bg-gold-400 text-black rounded-full p-2 shadow-lg transition-transform hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:ring-offset-2 focus:ring-offset-black"
						title={t("chat.scrollToBottom", "Scroll to bottom")}
						aria-label={t("chat.scrollToBottom", "Scroll to bottom")}
					>
						<ChevronDown className="w-5 h-5" />
					</button>
				</div>
			)}
		</div>
	);
};

export default MessageList;
