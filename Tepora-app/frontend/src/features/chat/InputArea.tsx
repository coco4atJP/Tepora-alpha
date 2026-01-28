import { Brain, Send, Square } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { useChatStore, useWebSocketStore } from "../../stores";
import type { ChatInterfaceContext } from "./ChatInterface";
import PersonaSwitcher from "./PersonaSwitcher";

const InputArea: React.FC = () => {
	const { currentMode, attachments, clearAttachments, skipWebSearch } =
		useOutletContext<ChatInterfaceContext>();

	const { t } = useTranslation();
	const [message, setMessage] = useState("");
	const [isThinkingMode, setIsThinkingMode] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Stores
	const isProcessing = useChatStore((state) => state.isProcessing);
	const isConnected = useWebSocketStore((state) => state.isConnected);
	const sendMessage = useWebSocketStore((state) => state.sendMessage);
	const stopGeneration = useWebSocketStore((state) => state.stopGeneration);

	const handleSend = () => {
		if (message.trim() && !isProcessing && isConnected) {
			sendMessage(
				message,
				currentMode,
				attachments,
				skipWebSearch,
				isThinkingMode,
			);
			clearAttachments();
			setMessage("");
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const getPlaceholder = () => {
		if (!isConnected) return t("chat.input.placeholder.connecting");
		switch (currentMode) {
			case "search":
				return t("chat.input.placeholder.search");
			case "agent":
				return t("chat.input.placeholder.agent");
			default:
				return t("chat.input.placeholder.default");
		}
	};

	// Auto-resize textarea
	// biome-ignore lint/correctness/useExhaustiveDependencies: resize on message change only
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
		}
	}, [message]);

	return (
		<div className="w-full max-w-7xl mx-auto relative group">
			<div
				className={`relative flex items-end gap-2 p-2 rounded-[2rem] glass-tepora transition-all duration-500 ${isProcessing
					? "ring-1 ring-gold-500/30 shadow-[0_0_30px_-5px_rgba(234,179,8,0.15)] bg-theme-overlay"
					: "hover:shadow-[0_0_30px_-5px_rgba(0,0,0,0.1)] hover:bg-theme-overlay shadow-2xl"
					}`}
			>
				{/* Persona Switcher */}
				<div className="shrink-0 mb-1 ml-1">
					<PersonaSwitcher />
				</div>

				{/* Text Input */}
				<textarea
					ref={textareaRef}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={getPlaceholder()}
					disabled={isProcessing || !isConnected}
					aria-label={t("chat.input.aria_label")}
					className="flex-1 bg-transparent border-none outline-none text-theme-text placeholder-theme-subtext resize-none min-h-[44px] max-h-[200px] py-3 px-2 leading-relaxed font-sans text-[0.95rem] scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent"
					rows={1}
					style={{ maxHeight: "200px" }}
				/>

				<div className="flex items-center gap-2 mb-1 mr-1">
					{/* Thinking Toggle */}
					<button
						type="button"
						onClick={() => setIsThinkingMode(!isThinkingMode)}
						disabled={isProcessing}
						className={`w-8 h-8 rounded-full transition-all duration-300 flex items-center justify-center active:scale-90 ${isThinkingMode
							? "bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/50 shadow-[0_0_10px_-2px_rgba(168,85,247,0.3)]"
							: "text-gray-500 hover:text-purple-400 hover:bg-purple-500/10"
							}`}
						title={t("chat.input.thinking_mode")}
					>
						<Brain className="w-4 h-4" />
					</button>

					{/* Send / Stop Button */}
					{isProcessing ? (
						<button
							type="button"
							onClick={() => stopGeneration()}
							className="w-10 h-10 rounded-full transition-all duration-300 flex items-center justify-center bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500 hover:text-white hover:border-red-500 shadow-lg hover:shadow-red-500/40 active:scale-95 group/stop"
							title={t("chat.input.stop")}
							aria-label={t("chat.input.stop_generation")}
						>
							<Square
								className="w-4 h-4 fill-current group-hover/stop:scale-110 transition-transform"
								aria-hidden="true"
							/>
						</button>
					) : (
						<button
							type="button"
							onClick={handleSend}
							disabled={!message.trim() || !isConnected}
							className={`w-10 h-10 rounded-full transition-all duration-300 flex items-center justify-center ${message.trim()
								? "bg-gradient-to-br from-gold-400 to-coffee-600 text-white shadow-lg hover:scale-105 hover:shadow-gold-500/30 hover:to-gold-600 border border-gold-400/20 active:scale-95"
								: "bg-white/5 text-gray-600 border border-white/5 cursor-not-allowed"
								}`}
							title={t("chat.input.send")}
							aria-label={t("chat.input.send_message")}
						>
							<Send
								className={`w-4 h-4 ${message.trim() ? "ml-0.5" : ""}`}
								aria-hidden="true"
							/>
						</button>
					)}
				</div>
			</div>

			{/* Helper Text */}
			<div className="mt-2 hidden md:flex justify-end">
				<div className="text-[10px] text-gray-600 font-light tracking-widest opacity-60 font-display uppercase">
					{t("chat.input.mode_active", { mode: currentMode.toUpperCase() })}
				</div>
			</div>
		</div>
	);
};

export default InputArea;
