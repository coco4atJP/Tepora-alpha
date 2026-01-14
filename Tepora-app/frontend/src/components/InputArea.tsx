import { Globe, Paperclip, Send, Square } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Attachment, ChatMode } from "../types";
import PersonaSwitcher from "./PersonaSwitcher";

interface InputAreaProps {
	onSendMessage: (
		message: string,
		mode: ChatMode,
		attachments?: Attachment[],
		skipWebSearch?: boolean,
	) => void;
	isProcessing: boolean;
	isConnected: boolean;
	currentMode: ChatMode;
	onStop?: () => void;
	onFileSelect?: () => void;
	attachments?: Attachment[];
}

const InputArea: React.FC<InputAreaProps> = ({
	onSendMessage,
	isProcessing,
	isConnected,
	currentMode,
	onStop,
	onFileSelect,
	attachments = [],
}) => {
	const { t } = useTranslation();
	const [message, setMessage] = useState("");
	const [skipWebSearch, setSkipWebSearch] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const handleSend = () => {
		if (message.trim() && !isProcessing && isConnected) {
			onSendMessage(message, currentMode, attachments, skipWebSearch);
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
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
		}
	}, [message]);

	return (
		<div className="w-full max-w-7xl mx-auto relative group">
			<div
				className={`relative flex items-end gap-2 p-2 rounded-[2rem] glass-tepora transition-all duration-500 ${
					isProcessing
						? "ring-1 ring-gold-500/30 shadow-[0_0_30px_-5px_rgba(234,179,8,0.15)] bg-black/40"
						: "hover:shadow-[0_0_30px_-5px_rgba(0,0,0,0.5)] hover:bg-black/40 shadow-2xl"
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
					className="flex-1 bg-transparent border-none outline-none text-gray-100 placeholder-gray-500 resize-none min-h-[44px] max-h-[200px] py-3 px-2 leading-relaxed font-sans text-[0.95rem] scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
					rows={1}
					style={{ maxHeight: "200px" }}
				/>

				<div className="flex items-center gap-1 mb-1 mr-1">
					{/* File Attachment (Search Mode Only) */}
					{currentMode === "search" && onFileSelect && (
						<button
							type="button"
							onClick={onFileSelect}
							className="p-2.5 text-gray-400 hover:text-gold-300 transition-all rounded-full hover:bg-white/5 active:scale-95"
							title={t("chat.input.attach_file")}
							aria-label={t("chat.input.attach_file")}
							disabled={isProcessing || !isConnected}
						>
							<Paperclip className="w-5 h-5" aria-hidden="true" />
						</button>
					)}

					{/* Web Search Toggle (Search Mode Only) */}
					{currentMode === "search" && (
						<button
							type="button"
							onClick={() => setSkipWebSearch(!skipWebSearch)}
							className={`flex items-center gap-1.5 h-10 px-4 rounded-full text-xs transition-all duration-300 border ${
								!skipWebSearch
									? "bg-gold-500/10 text-gold-300 border-gold-500/30 shadow-[0_0_15px_-3px_rgba(234,179,8,0.2)]"
									: "bg-white/5 text-gray-500 border-white/5 hover:bg-white/10"
							}`}
							title={
								skipWebSearch
									? `${t("chat.input.web_search")}: OFF`
									: `${t("chat.input.web_search")}: ON`
							}
							aria-label={t("chat.input.web_search_toggle", {
								state: skipWebSearch ? "OFF" : "ON",
							})}
							aria-pressed={!skipWebSearch}
							disabled={isProcessing}
						>
							<Globe
								className={`w-3.5 h-3.5 ${!skipWebSearch ? "text-gold-400 animate-pulse" : "text-gray-500"}`}
								aria-hidden="true"
							/>
							<span className="font-medium font-display tracking-wide">
								{skipWebSearch ? "OFF" : "ON"}
							</span>
						</button>
					)}

					{/* Send / Stop Button */}
					{isProcessing ? (
						<button
							type="button"
							onClick={() => onStop?.()}
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
							className={`w-10 h-10 rounded-full transition-all duration-300 flex items-center justify-center ${
								message.trim()
									? "bg-gradient-to-br from-gold-400 to-coffee-600 text-white shadow-lg hover:scale-105 hover:shadow-gold-500/30 hover:to-gold-600 border border-gold-400/20"
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
