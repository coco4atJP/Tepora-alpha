import type React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Message } from "../types";

interface MessageBubbleProps {
	message: Message;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
	const isUser = message.role === "user";
	return (
		<div
			className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-4`}
		>
			<div
				className={`max-w-[80%] rounded-lg p-3 ${isUser
						? "bg-blue-600 text-white rounded-br-none"
						: "bg-gray-700 text-gray-100 rounded-bl-none"
					}`}
			>
				<div
					className="prose prose-invert max-w-none break-words"
				>
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						rehypePlugins={[rehypeSanitize]}
					>
						{message.content}
					</ReactMarkdown>
				</div>
			</div>
		</div>
	);
};

export default MessageBubble;
