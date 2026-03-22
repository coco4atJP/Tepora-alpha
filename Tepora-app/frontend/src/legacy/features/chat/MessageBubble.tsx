import { AlertCircle, Bot, Check, Copy, Terminal, User, RefreshCw } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import type { Message } from "../../../types";
import { logger } from "../../../utils/logger";

interface MessageBubbleProps {
	message: Message;
	icon?: string;
	avatar?: string;
	isLast?: boolean;
	onRegenerate?: () => void;
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
	const baseClasses = "rounded-[1.25rem] p-4 md:p-5 shadow-lg min-w-0 transition-all border";

	if (message.role === "user") {
		return `${baseClasses} bg-tea-700/60 border-tea-400/30 text-cream-50 rounded-tr-sm shadow-[0_8px_30px_rgba(189,75,38,0.1)] backdrop-blur-md`;
	}

	if (message.role === "system") {
		return `${baseClasses} glass-panel bg-semantic-error/10 border-semantic-error/40 text-semantic-error`;
	}

	// Assistant role
	if (message.nodeId) {
		// Agent/Tool specific styling
		if (message.agentName === "Supervisor") {
			return `${baseClasses} glass-panel border-amber-500/30 text-amber-100 shadow-[0_4px_20px_rgba(245,158,11,0.05)]`;
		}
		if (message.agentName === "Planner") {
			return `${baseClasses} glass-panel border-purple-500/30 text-purple-100 shadow-[0_4px_20px_rgba(168,85,247,0.05)]`;
		}
		if (message.agentName?.includes("Search")) {
			return `${baseClasses} glass-panel border-cyan-500/30 text-cyan-100 shadow-[0_4px_20px_rgba(6,182,212,0.05)]`;
		}
		return `${baseClasses} glass-panel border-gold-500/30 text-gold-50 shadow-[0_4px_20px_rgba(252,211,77,0.05)]`;
	}

	// Fallback to mode styling
	switch (message.mode) {
		case "search":
			return `${baseClasses} glass-panel bg-cyan-950/30 border-cyan-500/30 text-cyan-50`;
		case "agent":
			return `${baseClasses} glass-tepora border-gold-500/30 text-gold-50 rounded-tl-sm`;
		default:
			return `${baseClasses} glass-panel border-border-highlight text-text-primary rounded-tl-sm`;
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
function getModeLabel(mode: Message["mode"], t: TFunction): string | null {
	switch (mode) {
		case "search":
			return `🔍 ${t("chat.modes.search")}`;
		case "agent":
			return `🤖 ${t("chat.modes.agent")}`;
		case "chat":
			return `💬 ${t("chat.modes.chat")}`;
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

const CodeBlock = ({ language, code }: { language: string; code: string }) => {
	const [copied, setCopied] = React.useState(false);
	const { t } = useTranslation();

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			logger.error("Failed to copy!", err);
		}
	};

	return (
		<section
			aria-label={`${language} code block`}
			className="grid w-full max-w-full my-4 rounded-xl border border-white/10 shadow-lg group/code glow-border overflow-hidden"
		>
			<div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-white/10 text-xs text-gray-400 font-mono">
				<div className="flex items-center gap-2">
					<Terminal className="w-3.5 h-3.5 opacity-50 text-tea-400" />
					<span className="uppercase tracking-wider font-bold text-[11px]">{language}</span>
				</div>
				<button
					onClick={handleCopy}
					className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-hover/code:opacity-100 hover:text-white transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/50 px-2 py-1 rounded hover:bg-white/5 cursor-pointer"
					aria-label={t("common.aria.copy_code", "Copy code")}
				>
					{copied ? (
						<Check className="w-3.5 h-3.5 text-green-400" />
					) : (
						<Copy className="w-3.5 h-3.5" />
					)}
					<span className="text-[10px] uppercase tracking-widest opacity-70 hidden sm:inline-block">
						{copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
					</span>
				</button>
			</div>
			<div className="overflow-x-auto custom-scrollbar">
				<SyntaxHighlighter
					style={vscDarkPlus}
					language={language}
					PreTag="div"
					className="!bg-black/60 !m-0 !p-4 !font-mono text-sm"
					wrapLines={true}
					wrapLongLines={true}
				>
					{code}
				</SyntaxHighlighter>
			</div>
		</section>
	);
};

// Debounce interval for streaming messages
const MARKDOWN_DEBOUNCE_MS = 150;

// --- Main Component ---

const MessageBubble: React.FC<MessageBubbleProps> = ({
	message,
	icon,
	avatar,
	isLast,
	onRegenerate,
}) => {
	const { t } = useTranslation();
	const modeLabel =
		message.mode && message.role === "user" ? getModeLabel(message.mode, t) : null;

	const [debouncedContent, setDebouncedContent] = useState(message.content);
	const [copied, setCopied] = useState(false);
	const lastUpdateRef = React.useRef(Date.now());

	// Track thinking state
	const [isThinkingOpen, setIsThinkingOpen] = useState(() => !message.isComplete);
	const [hasAnswerStarted, setHasAnswerStarted] = useState(false);

	const handleCopyMessage = async () => {
		try {
			await navigator.clipboard.writeText(message.content);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			logger.error("Failed to copy message!", err);
		}
	};

	useEffect(() => {
		// Completed or user/system messages reflect immediately
		if (
			message.isComplete ||
			message.role === "user" ||
			message.role === "system"
		) {
			setDebouncedContent(message.content);
			lastUpdateRef.current = Date.now();
			return;
		}

		// Throttle during streaming to prevent starvation
		const now = Date.now();
		const timeSinceLast = now - lastUpdateRef.current;

		if (timeSinceLast >= MARKDOWN_DEBOUNCE_MS) {
			setDebouncedContent(message.content);
			lastUpdateRef.current = now;
		} else {
			const timer = setTimeout(() => {
				setDebouncedContent(message.content);
				lastUpdateRef.current = Date.now();
			}, MARKDOWN_DEBOUNCE_MS - timeSinceLast);

			return () => clearTimeout(timer);
		}
	}, [message.content, message.isComplete, message.role]);

	// Extract <think> tags from reasoning models (like DeepSeek R1)
	let displayContent = debouncedContent;
	let extractedThinking = message.thinking || "";

	if (displayContent.includes("<think>")) {
		const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
		displayContent = displayContent.replace(thinkRegex, (_match, thinkContent) => {
			extractedThinking = extractedThinking ? extractedThinking + "\n\n" + thinkContent : thinkContent;
			return "";
		});
	}

	// Clean up any stray closing tags if they get orphaned
	displayContent = displayContent.replace(/<\/think>/gi, "");

	const hasThinking = extractedThinking && extractedThinking.trim().length > 0;
	const isCurrentlyThinking = !message.isComplete && displayContent.trim().length === 0;

	useEffect(() => {
		if (!message.isComplete && displayContent.trim().length > 0 && !hasAnswerStarted) {
			setHasAnswerStarted(true);
			setIsThinkingOpen(false); // Auto-collapse when answer starts
		}
	}, [displayContent, message.isComplete, hasAnswerStarted]);

	return (
		<div
			className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} animate-message-in group`}
		>
			<div
				className={`flex max-w-[90%] md:max-w-[85%] lg:max-w-[48rem] min-w-0 ${message.role === "user" ? "flex-row-reverse" : "flex-row"} gap-4`}
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
						{hasThinking && (
							<div className="mb-4 rounded-lg bg-black/20 border border-white/5 overflow-hidden flex flex-col group/thinking">
								<button
									type="button"
									onClick={() => setIsThinkingOpen(!isThinkingOpen)}
									className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-gray-400 cursor-pointer hover:bg-white/5 transition-colors select-none w-full text-left"
								>
									<Bot className={`w-3 h-3 ${isCurrentlyThinking ? 'text-purple-400 animate-pulse' : 'text-gray-500'}`} />
									<span className={`opacity-80 ${isCurrentlyThinking ? 'text-purple-300' : ''}`}>
										{t("chat.status.thinking") || "Thinking Process"}
									</span>
									{isCurrentlyThinking && (
										<span className="flex items-center gap-0.5 ml-1">
											<span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
											<span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
											<span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
										</span>
									)}
									<div className="flex-1" />
									<span className={`text-[10px] opacity-50 transition-opacity ${isThinkingOpen ? "hidden" : "block"}`}>
										{t("chat.click_to_expand", "Click to expand")}
									</span>
								</button>
								<div className={`grid transition-all duration-300 ease-out ${isThinkingOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
									<div className="overflow-hidden">
										<div className="px-3 pt-2 text-xs font-mono text-gray-400/80 leading-relaxed whitespace-pre-wrap border-t border-white/5 break-words">
											{extractedThinking.trimStart()}
										</div>
									</div>
								</div>
							</div>
						)}

						<div
							className={`markdown-content prose prose-theme max-w-none break-words whitespace-pre-wrap
                            prose-p:leading-relaxed prose-p:my-4
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
											<CodeBlock language={match[1]} code={codeString} />
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
								{displayContent}
							</ReactMarkdown>
						</div>
					</div>

					{/* Timestamp & Actions */}
					<div
						className={`text-[10px] opacity-40 group-hover:opacity-60 transition-opacity mt-1.5 font-mono flex items-center gap-2 ${message.role === "user" ? "justify-end text-gold-200/50" : "justify-start text-gray-500"}`}
					>
						<span>{message.timestamp.toLocaleTimeString("ja-JP")}</span>
						<button
							onClick={handleCopyMessage}
							className={`flex items-center gap-1 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/50 p-0.5 rounded hover:bg-white/5 cursor-pointer opacity-0 group-hover:opacity-100 ${copied ? "text-green-400 opacity-100" : ""}`}
							aria-label={t("common.copy", "Copy")}
							title={copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
						>
							{copied ? (
								<Check className="w-3 h-3" />
							) : (
								<Copy className="w-3 h-3" />
							)}
						</button>
						{isLast && (message.role === "assistant" || message.role === "system") && message.isComplete && (
							<button
								onClick={onRegenerate}
								className="flex items-center gap-1 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/50 p-0.5 rounded hover:bg-white/5 cursor-pointer opacity-0 group-hover:opacity-100"
								aria-label={t("chat.regenerate", "Regenerate")}
								title={t("chat.regenerate", "Regenerate")}
							>
								<RefreshCw className="w-3 h-3" />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

export default React.memo(MessageBubble);

