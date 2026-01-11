import { Bot } from "lucide-react";
import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "../types";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
	messages: Message[];
}

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
	const { t } = useTranslation();
	const endOfMessagesRef = useRef<HTMLDivElement>(null);
	const prevLengthRef = useRef(messages.length);

	useEffect(() => {
		// メッセージ数が増えた場合のみスクロール（ストリーミング中のコンテンツ更新では発火しない）
		if (messages.length > prevLengthRef.current) {
			endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
		}
		prevLengthRef.current = messages.length;
	}, [messages.length]);

	// Get the last message for screen reader announcement
	const lastMessage = messages[messages.length - 1];
	const announcementText = lastMessage
		? `${lastMessage.role === "assistant" ? "Assistant" : "You"}: ${lastMessage.content.substring(0, 200)}${lastMessage.content.length > 200 ? "..." : ""}`
		: "";

	return (
		<div
			className="overflow-y-auto p-4 space-y-6 h-full custom-scrollbar"
			role="log"
			aria-label="Chat messages"
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
						Select a mode from the dial to begin
					</p>
				</div>
			)}

			{messages.map((message) => (
				<MessageBubble key={message.id} message={message} />
			))}

			<div ref={endOfMessagesRef} aria-hidden="true" />
		</div>
	);
};

export default React.memo(MessageList);
