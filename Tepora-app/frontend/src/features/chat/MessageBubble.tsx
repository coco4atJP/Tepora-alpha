import { AlertCircle, Bot, User } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import type { Message } from "../../types";

interface MessageBubbleProps {
	message: Message;
	icon?: string;
	avatar?: string;
}

// --- Helper functions for styling ---

/**
 * Get the icon background class based on message role.
 */
function getIconBgClass(message: Message): string {
	switch (message.role) {
		case "user":
			return "bg-gradient-to-br from-tea-500 to-tea-700";
		case "system":
			return "bg-red-900/50";
		default:
			return "bg-theme-glass backdrop-blur-md";
	}
}

/**
 * Get the message bubble class based on message role, agentName, nodeId, and mode.
 */
function getBubbleClass(message: Message): string {
	const baseClasses = "rounded-2xl p-4 shadow-lg backdrop-blur-md border min-w-0 transition-all";

	if (message.role === "user") {
		return `${baseClasses} bg-tea-600/70 border-tea-400/50 text-cream-100 rounded-tr-none`;
	}

	if (message.role === "system") {
		return `${baseClasses} bg-semantic-error/10 border-semantic-error/50 text-semantic-error`;
	}

	// Assistant role
	if (message.nodeId) {
		// Agent/Tool specific styling
		if (message.agentName === "Supervisor") {
			return `${baseClasses} bg-amber-900/60 border-amber-500/50 text-amber-100`;
		}
		if (message.agentName === "Planner") {
			return `${baseClasses} bg-purple-900/60 border-purple-500/50 text-purple-100`;
		}
		if (message.agentName?.includes("Search")) {
			return `${baseClasses} bg-cyan-900/60 border-cyan-500/50 text-cyan-100`;
		}
		return `${baseClasses} bg-gold-900/50 border-gold-500/40 text-gold-100`;
	}

	// Fallback to mode styling
	switch (message.mode) {
		case "search":
			return `${baseClasses} bg-cyan-950/70 border-cyan-500/40 text-cyan-50`;
		case "agent":
			return `${baseClasses} bg-tea-900/70 border-gold-500/40 text-gold-50`;
		default:
			return `${baseClasses} bg-theme-panel border-theme-border text-theme-text rounded-tl-none`;
	}
}

/**
 * Get the agent header color class.
 */
function getAgentHeaderClass(agentName: string): string {
	if (agentName === "Supervisor") return "text-amber-400";
	if (agentName === "Planner") return "text-purple-400";
	if (agentName.includes("Search")) return "text-cyan-400";
	return "text-gold-400";
}

/**
 * Get the mode label for user messages.
 */
function getModeLabel(mode: Message["mode"]): string | null {
	switch (mode) {
		case "search":
			return "🔍 Search";
		case "agent":
			return "🤖 Agent";
		case "chat":
			return "💬 Chat";
		default:
			return null;
	}
}

/**
 * Render the icon based on message role.
 */
function renderIcon(
	role: Message["role"],
	icon?: string,
	avatar?: string,
): React.ReactNode {
	if (avatar) {
		return (
			<img
				src={avatar}
				alt="Avatar"
				className="w-full h-full object-cover rounded-full"
			/>
		);
	}
	if (icon) {
		return <span className="text-lg leading-none">{icon}</span>;
	}

	switch (role) {
		case "user":
			return <User className="w-4 h-4 text-white" />;
		case "system":
			return <AlertCircle className="w-4 h-4 text-semantic-error" />;
		default:
			return <Bot className="w-4 h-4 text-gold-400" />;
	}
}

// Debounce interval for streaming messages
const MARKDOWN_DEBOUNCE_MS = 150;

// --- Main Component ---

const MessageBubble: React.FC<MessageBubbleProps> = ({
	message,
	icon,
	avatar,
}) => {
	const { t } = useTranslation();
	const modeLabel =
		message.mode && message.role === "user" ? getModeLabel(message.mode) : null;

	// Debounced content for performance optimization during streaming
	const [debouncedContent, setDebouncedContent] = useState(message.content);

	useEffect(() => {
		// Completed or user/system messages reflect immediately
		if (
			message.isComplete ||
			message.role === "user" ||
			message.role === "system"
		) {
			setDebouncedContent(message.content);
			return;
		}

		// Debounce during streaming
		const timer = setTimeout(() => {
			setDebouncedContent(message.content);
		}, MARKDOWN_DEBOUNCE_MS);

		return () => clearTimeout(timer);
	}, [message.content, message.isComplete, message.role]);

	return (
		<div
			className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} animate-message-in group`}
		>
			<div
				className={`flex max-w-[90%] md:max-w-[85%] min-w-0 ${message.role === "user" ? "flex-row-reverse" : "flex-row"} gap-4`}
			>
				{/* Icon */}
				<div
					className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center mt-1 shadow-xl ring-1 ring-white/10 ${getIconBgClass(message)} transition-transform duration-500 group-hover:scale-110`}
				>
					{renderIcon(message.role, icon, avatar)}
				</div>

				{/* Message Container */}
				<div className="flex flex-col min-w-0">
					{/* Agent Header */}
					{message.agentName && (
						<div
							className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ml-1 flex items-center gap-2 ${getAgentHeaderClass(message.agentName)}`}
						>
							<span className="w-1 h-1 rounded-full bg-current opacity-70" />
							{message.agentName}
						</div>
					)}

					{/* Message Bubble */}
					<div className={`${getBubbleClass(message)} relative overflow-hidden`}>
						{/* Shimmer Effect for AI Messages during streaming */}
						{message.role !== "user" && !message.isComplete && (
							<div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
						)}

						{modeLabel && (
							<div className="text-[10px] opacity-60 mb-2 flex items-center gap-1.5 font-display uppercase tracking-wider text-gold-300 border-b border-white/5 pb-1">
								{modeLabel}
							</div>
						)}

						{/* Thinking Process */}
						{/* Only show if there is actual content (ignoring whitespace) */}
						{message.thinking && message.thinking.trim().length > 0 && (
							<details className="mb-4 group/thinking rounded-lg bg-black/20 border border-white/5 overflow-hidden open:pb-2">
								<summary className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-gray-400 cursor-pointer hover:bg-white/5 transition-colors select-none">
									<Bot className="w-3 h-3 text-purple-400" />
									<span className="opacity-80">
										{t("chat.status.thinking") || "Thinking Process"}
									</span>
									<div className="flex-1" />
									<span className="text-[10px] opacity-50 group-open/thinking:hidden">
										Click to expand
									</span>
								</summary>
								<div className="px-3 pt-2 text-xs font-mono text-gray-400/80 leading-relaxed whitespace-pre-wrap border-t border-white/5">
									{message.thinking}
									{!message.isComplete && !message.content && (
										<span className="animate-pulse inline-block ml-1">...</span>
									)}
								</div>
							</details>
						)}

						<div
							className={`markdown-content prose prose-theme max-w-none break-words whitespace-pre-wrap
                                prose-p:leading-7 prose-p:my-3
                                prose-headings:font-display prose-headings:font-normal
                                prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:not-italic
                                prose-ul:my-2 prose-li:my-1
                                prose-a:no-underline hover:prose-a:underline
                                ${message.role === "user" ? "prose-p:text-cream-50" : ""}
                            `}
						>
							<ReactMarkdown
								remarkPlugins={[remarkGfm]}
								components={{
									code({ className, children, ...rest }) {
										const match = /language-(\w+)/.exec(className || "");
										const codeString = String(children).replace(/\n$/, "");
										return match ? (
											<section
												aria-label={`${match[1]} code block`}
												className="grid overflow-x-auto w-full max-w-full my-4 rounded-xl border border-white/10 shadow-lg group/code"
											>
												<div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-white/5 text-xs text-gray-400 font-mono">
													<span>{match[1]}</span>
												</div>
												<SyntaxHighlighter
													style={vscDarkPlus}
													language={match[1]}
													PreTag="div"
													className="!bg-black/60 !m-0 !p-4 !font-mono text-sm"
													wrapLines={true}
													wrapLongLines={true}
												>
													{codeString}
												</SyntaxHighlighter>
											</section>
										) : (
											<code {...rest} className={`${className || ""}`}>
												{children}
											</code>
										);
									},
									a: ({ href, children }) => (
										<a
											href={href}
											target="_blank"
											rel="noreferrer noopener"
											className="text-gold-400 hover:text-gold-300 underline decoration-white/30 hover:decoration-gold-300"
										>
											{children}
										</a>
									),
								}}
							>
								{debouncedContent}
							</ReactMarkdown>
						</div>
					</div>

					{/* Timestamp */}
					<div
						className={`text-[10px] opacity-40 mt-1.5 font-mono flex items-center gap-1 ${message.role === "user" ? "justify-end text-gold-200/50" : "justify-start text-gray-500"}`}
					>
						{message.timestamp.toLocaleTimeString("ja-JP")}
					</div>
				</div>
			</div>
		</div>
	);
};

export default React.memo(MessageBubble);
